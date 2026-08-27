//! Session persistence (CLAUDE.md §10).
//!
//! The transition rules live in `store-core::session` and are not duplicated
//! here. This module's job is to load a session, hand it to the pure machine,
//! and persist whatever the machine decided — with the state change written
//! under a conditional `WHERE` so two tablets racing to claim one punch cannot
//! both win.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use store_core::session::{
    CloseReason, IdentityStrength, Session, SessionEvent, SessionState, TabletId,
    TransitionError, CLAIM_WINDOW_SECS, IDLE_TIMEOUT_SECS,
};
use uuid::Uuid;

use crate::error::{DbError, FoundExt, Result};

/// A name card on the tablet's claim screen (§12.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnclaimedSession {
    pub session_id: Uuid,
    pub operator_id: Uuid,
    pub emp_code: String,
    pub full_name: String,
    pub department: Option<String>,
    pub opened_at: DateTime<Utc>,
    /// Seconds left before the card disappears. Lets the tablet show a countdown
    /// rather than having a card vanish mid-tap.
    pub expires_in_secs: i64,
}

/// A `sessions` row, exactly as stored.
///
/// Kept as a struct rather than loose arguments so that adding a column is a
/// change in one place, and so the conversion below reads as a mapping rather
/// than as an eleven-argument call nobody can check at the call site.
#[derive(Debug)]
struct SessionRow {
    id: Uuid,
    operator_id: Uuid,
    punch_id: Option<Uuid>,
    state: String,
    tablet_id: Option<String>,
    close_reason: Option<String>,
    manual_identity: bool,
    opened_at: DateTime<Utc>,
    claimed_at: Option<DateTime<Utc>>,
    closed_at: Option<DateTime<Utc>>,
    last_activity_at: DateTime<Utc>,
}

impl TryFrom<SessionRow> for Session {
    type Error = DbError;

    /// Reconstruct the pure aggregate.
    ///
    /// The `ok_or_else` arms are unreachable in practice — `0002_identity`'s
    /// check constraints make an ACTIVE row without a tablet impossible — but
    /// they are here rather than as `unwrap()` because a corrupt row should
    /// surface as an error an operator can be told about, not a panic that
    /// takes the store offline.
    fn try_from(r: SessionRow) -> Result<Self> {
        let tablet = r.tablet_id.map(TabletId);

        let state = match r.state.as_str() {
            "UNCLAIMED" => SessionState::Unclaimed,
            "EXPIRED" => SessionState::Expired,
            "ACTIVE" => SessionState::Active {
                tablet_id: tablet.ok_or_else(|| {
                    DbError::Invalid("ACTIVE session with no tablet_id".into())
                })?,
            },
            "CLOSED" => SessionState::Closed {
                tablet_id: tablet.ok_or_else(|| {
                    DbError::Invalid("CLOSED session with no tablet_id".into())
                })?,
                reason: r
                    .close_reason
                    .ok_or_else(|| DbError::Invalid("CLOSED session with no reason".into()))?
                    .parse()?,
            },
            other => return Err(DbError::Invalid(format!("unknown session state {other:?}"))),
        };

        Ok(Session {
            id: r.id,
            operator_id: r.operator_id,
            punch_id: r.punch_id,
            state,
            identity: if r.manual_identity {
                IdentityStrength::Manual
            } else {
                IdentityStrength::Verified
            },
            opened_at: r.opened_at,
            claimed_at: r.claimed_at,
            closed_at: r.closed_at,
            last_activity_at: r.last_activity_at,
        })
    }
}

/// Load one session.
pub async fn get(pool: &PgPool, id: Uuid) -> Result<Session> {
    sqlx::query_as!(
        SessionRow,
        r#"
        select id             as "id!",
               operator_id    as "operator_id!",
               punch_id,
               state          as "state!",
               tablet_id,
               close_reason,
               manual_identity as "manual_identity!",
               opened_at      as "opened_at!",
               claimed_at,
               closed_at,
               last_activity_at as "last_activity_at!"
          from sessions where id = $1
        "#,
        id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("session")?
    .try_into()
}

/// What happened when we tried to offer a session for a punch.
///
/// Three outcomes, kept distinct because the caller must treat them
/// differently: only a genuinely new offer should wake the tablets, and only an
/// unknown user should raise an admin notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionOffer {
    /// A new session is on the claim screen.
    Opened(Uuid),
    /// This punch had already offered a session. A device retry, or the ADMS
    /// listener and the identity consumer both reaching the same row.
    AlreadyOffered(Uuid),
    /// §9.4: the punch is on record, but its `zk_user_id` maps to no active
    /// operator, so there is nobody to offer a session to.
    UnknownOperator,
}

/// Open an UNCLAIMED session from a punch.
///
/// The `punch_id` unique constraint means a replayed punch cannot offer a
/// second session, so this is safe — and meaningful — to call more than once.
/// That idempotency is load-bearing: the ADMS listener persists punches on the
/// hot path (§9.2) and the identity consumer processes the same punch again
/// off it, so this function is genuinely called twice for every real punch.
pub async fn open_from_punch(pool: &PgPool, punch_id: Uuid) -> Result<SessionOffer> {
    let mut tx = pool.begin().await?;

    let existing = sqlx::query_scalar!("select id from sessions where punch_id = $1", punch_id)
        .fetch_optional(&mut *tx)
        .await?;

    if let Some(id) = existing {
        tx.commit().await?;
        return Ok(SessionOffer::AlreadyOffered(id));
    }

    let operator_id = sqlx::query_scalar!(
        r#"
        select o.id from punches p
          join operators o on o.zk_user_id = p.zk_user_id and o.active
         where p.id = $1
        "#,
        punch_id
    )
    .fetch_optional(&mut *tx)
    .await?;

    let Some(operator_id) = operator_id else {
        tx.commit().await?;
        return Ok(SessionOffer::UnknownOperator);
    };

    let session_id = sqlx::query_scalar!(
        r#"
        insert into sessions (operator_id, punch_id, state, manual_identity)
        values ($1, $2, 'UNCLAIMED', false)
        returning id
        "#,
        operator_id,
        punch_id,
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| DbError::from_sqlx(e, "session for punch"))?;

    sqlx::query!("update punches set claimed = true where id = $1", punch_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(SessionOffer::Opened(session_id))
}

/// The claim screen: every UNCLAIMED punch from the last 90 seconds (§10).
///
/// Listing *all* of them is the point — tailgating is solved socially, by each
/// person tapping their own card.
pub async fn unclaimed(pool: &PgPool) -> Result<Vec<UnclaimedSession>> {
    let rows = sqlx::query_as!(
        UnclaimedSession,
        r#"
        select s.id          as "session_id!",
               o.id          as "operator_id!",
               o.emp_code    as "emp_code!",
               o.full_name   as "full_name!",
               o.department,
               s.opened_at   as "opened_at!",
               greatest(
                 0,
                 ceil(extract(epoch from (s.opened_at + make_interval(secs => $1::double precision)) - now()))
               )::bigint     as "expires_in_secs!"
          from sessions s
          join operators o on o.id = s.operator_id
         where s.state = 'UNCLAIMED'
           and s.opened_at > now() - make_interval(secs => $1::double precision)
         order by s.opened_at desc
        "#,
        CLAIM_WINDOW_SECS as f64,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Claim a session for a tablet.
///
/// The transition is decided by `store-core`, then written with the previous
/// state in the `WHERE` clause. That compare-and-set is what makes a double
/// claim from two tablets resolve to exactly one winner: the loser's `UPDATE`
/// matches no rows, and it is told who holds the session.
pub async fn claim(pool: &PgPool, id: Uuid, tablet_id: &TabletId) -> Result<Session> {
    let mut session = get(pool, id).await?;

    // A card that has sat past its window is expired even if the reaper has not
    // caught up yet — otherwise a stale claim screen could claim it.
    let now = Utc::now();
    if session.should_expire(now) {
        expire(pool, id).await?;
        return Err(DbError::Domain(TransitionError::SessionExpired.into()));
    }

    session.apply(
        &SessionEvent::Claim {
            tablet_id: tablet_id.clone(),
        },
        now,
    )?;

    let updated = sqlx::query!(
        r#"
        update sessions
           set state = 'ACTIVE',
               tablet_id = $2,
               claimed_at = coalesce(claimed_at, now()),
               last_activity_at = now()
         where id = $1
           and (state = 'UNCLAIMED' or (state = 'ACTIVE' and tablet_id = $2))
        returning id
        "#,
        id,
        tablet_id.0,
    )
    .fetch_optional(pool)
    .await?;

    if updated.is_none() {
        // Somebody else got there between our read and our write. Re-read to
        // report who actually holds it.
        let winner = get(pool, id).await?;
        return match winner.state.tablet_id() {
            Some(holder) if holder != tablet_id => Err(DbError::Domain(
                TransitionError::AlreadyClaimed {
                    claimed_by: holder.clone(),
                }
                .into(),
            )),
            _ => Err(DbError::Domain(TransitionError::SessionClosed.into())),
        };
    }

    get(pool, id).await
}

/// Open an already-claimed session for the manual fallback path (§8, §10).
///
/// Flagged `manual_identity` because a typed PIN is weaker evidence than a
/// fingerprint at the door, and reports must be able to say so.
pub async fn open_manual(
    pool: &PgPool,
    operator_id: Uuid,
    tablet_id: &TabletId,
) -> Result<Session> {
    let id = sqlx::query_scalar!(
        r#"
        insert into sessions (
            operator_id, punch_id, state, manual_identity,
            identity_source, tablet_id, claimed_at, last_activity_at
        )
        -- 0007 made identity strength three-valued. This path is the typed
        -- emp code and PIN, which is the weakest of the three; the column
        -- defaults to PUNCH, and a punchless PUNCH row is refused outright.
        values ($1, null, 'ACTIVE', true, 'PIN', $2, now(), now())
        returning id
        "#,
        operator_id,
        tablet_id.0,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "manual session"))?;

    get(pool, id).await
}

/// Close an active session.
pub async fn close(pool: &PgPool, id: Uuid, reason: CloseReason) -> Result<Session> {
    let mut session = get(pool, id).await?;

    let event = match reason {
        CloseReason::Submitted => SessionEvent::Submit,
        CloseReason::Done => SessionEvent::Done,
        CloseReason::IdleTimeout => SessionEvent::IdleTimeout,
    };
    session.apply(&event, Utc::now())?;

    // Terminal states absorb Done and the timeouts (see store-core), so a
    // second close is a no-op rather than an error — which is what a tablet on
    // a flaky LAN needs.
    sqlx::query!(
        r#"
        update sessions
           set state = 'CLOSED', close_reason = $2, closed_at = now()
         where id = $1 and state = 'ACTIVE'
        "#,
        id,
        reason.as_str(),
    )
    .execute(pool)
    .await?;

    get(pool, id).await
}

/// Mark operator activity, pushing back the idle timeout.
pub async fn touch(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query!(
        "update sessions set last_activity_at = now() where id = $1 and state = 'ACTIVE'",
        id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Expire one unclaimed session.
pub async fn expire(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query!(
        r#"
        update sessions set state = 'EXPIRED', closed_at = now()
         where id = $1 and state = 'UNCLAIMED'
        "#,
        id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// The reaper: expire stale claims and close idle sessions.
///
/// Returns the ids it acted on so the caller can emit `session.closed` events
/// — a tablet whose session timed out under it needs to be told, not left
/// showing a screen that no longer works.
///
/// The window bounds come from `store-core`, so there is one definition of 90
/// and 180 seconds rather than one per layer.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reaped {
    pub expired: Vec<Uuid>,
    pub idle_closed: Vec<Uuid>,
}

impl Reaped {
    pub fn is_empty(&self) -> bool {
        self.expired.is_empty() && self.idle_closed.is_empty()
    }
}

pub async fn reap(pool: &PgPool) -> Result<Reaped> {
    let expired = sqlx::query_scalar!(
        r#"
        update sessions set state = 'EXPIRED', closed_at = now()
         where state = 'UNCLAIMED'
           and opened_at <= now() - make_interval(secs => $1::double precision)
        returning id
        "#,
        CLAIM_WINDOW_SECS as f64,
    )
    .fetch_all(pool)
    .await?;

    let idle_closed = sqlx::query_scalar!(
        r#"
        update sessions
           set state = 'CLOSED', close_reason = 'IDLE_TIMEOUT', closed_at = now()
         where state = 'ACTIVE'
           and last_activity_at <= now() - make_interval(secs => $1::double precision)
        returning id
        "#,
        IDLE_TIMEOUT_SECS as f64,
    )
    .fetch_all(pool)
    .await?;

    Ok(Reaped {
        expired,
        idle_closed,
    })
}
