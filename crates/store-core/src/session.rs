//! The session claim state machine — CLAUDE.md §10. Pure: no clock, no I/O.
//!
//! The problem this solves: two people can walk in on one punch, and a punch
//! can arrive with nobody at the tablet. So a punch does not *become* a
//! session — it *offers* one, and somebody has to claim the offer.
//!
//! ```text
//!               punch received
//!                     │
//!                     ▼
//!              ┌─────────────┐   no claim in 90s    ┌─────────┐
//!              │  UNCLAIMED  │ ───────────────────► │ EXPIRED │
//!              └──────┬──────┘                      └─────────┘
//!               tablet claims
//!                     │
//!                     ▼
//!              ┌─────────────┐  submit / done /     ┌─────────┐
//!              │   ACTIVE    │  180s idle           │ CLOSED  │
//!              └─────────────┘ ───────────────────► └─────────┘
//! ```

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// How long an unclaimed punch stays on the tablet's claim screen (§10).
pub const CLAIM_WINDOW_SECS: i64 = 90;

/// How long an active session survives without operator input (§10).
pub const IDLE_TIMEOUT_SECS: i64 = 180;

pub fn claim_window() -> Duration {
    Duration::seconds(CLAIM_WINDOW_SECS)
}

pub fn idle_timeout() -> Duration {
    Duration::seconds(IDLE_TIMEOUT_SECS)
}

/// Identifies the physical tablet that claimed a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct TabletId(pub String);

impl std::fmt::Display for TabletId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Why an active session ended. Persisted to `sessions.close_reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CloseReason {
    /// The operator confirmed a transaction.
    Submitted,
    /// The operator tapped Done, or cancelled out.
    Done,
    /// 180 s with no input.
    IdleTimeout,
}

impl CloseReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            CloseReason::Submitted => "SUBMITTED",
            CloseReason::Done => "DONE",
            CloseReason::IdleTimeout => "IDLE_TIMEOUT",
        }
    }
}

impl std::str::FromStr for CloseReason {
    type Err = crate::error::CoreError;

    fn from_str(s: &str) -> crate::error::Result<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "SUBMITTED" => Ok(CloseReason::Submitted),
            "DONE" => Ok(CloseReason::Done),
            "IDLE_TIMEOUT" => Ok(CloseReason::IdleTimeout),
            _ => Err(crate::error::CoreError::UnknownSessionState(s.to_owned())),
        }
    }
}

/// The state of one session offer.
///
/// The payloads mirror the nullable columns on `sessions`: `tablet_id` is set
/// exactly when the row is ACTIVE-or-later, `close_reason` exactly when CLOSED.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionState {
    /// A punch arrived; the name card is on the claim screen.
    Unclaimed,
    /// A tablet took the card. Bound to that tablet and no other.
    Active { tablet_id: TabletId },
    /// Finished normally.
    Closed {
        tablet_id: TabletId,
        reason: CloseReason,
    },
    /// Nobody claimed it inside the 90 s window.
    Expired,
}

impl SessionState {
    /// The token stored in `sessions.state`.
    pub const fn as_str(&self) -> &'static str {
        match self {
            SessionState::Unclaimed => "UNCLAIMED",
            SessionState::Active { .. } => "ACTIVE",
            SessionState::Closed { .. } => "CLOSED",
            SessionState::Expired => "EXPIRED",
        }
    }

    /// True when no further work can be accepted against this session.
    pub const fn is_terminal(&self) -> bool {
        matches!(
            self,
            SessionState::Closed { .. } | SessionState::Expired
        )
    }

    /// The tablet this session is bound to, if any.
    pub const fn tablet_id(&self) -> Option<&TabletId> {
        match self {
            SessionState::Active { tablet_id }
            | SessionState::Closed { tablet_id, .. } => Some(tablet_id),
            SessionState::Unclaimed | SessionState::Expired => None,
        }
    }
}

/// Everything that can happen to a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionEvent {
    /// A tablet tapped the operator's name card.
    Claim { tablet_id: TabletId },
    /// A transaction was confirmed. §10: submit closes the session.
    Submit,
    /// The operator tapped Done, or backed out.
    Done,
    /// 180 s elapsed with no input on an active session.
    IdleTimeout,
    /// The 90 s claim window elapsed on an unclaimed punch.
    ClaimWindowElapsed,
}

impl SessionEvent {
    pub fn claim(tablet_id: impl Into<String>) -> Self {
        SessionEvent::Claim {
            tablet_id: TabletId(tablet_id.into()),
        }
    }
}

/// Why a transition was refused.
///
/// The server maps `SessionClosed` and `SessionExpired` onto `410 Gone` (§10),
/// and `AlreadyClaimed` onto `409 Conflict`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TransitionError {
    #[error("session is already claimed by tablet {claimed_by}")]
    AlreadyClaimed { claimed_by: TabletId },

    #[error("session is closed")]
    SessionClosed,

    #[error("session expired before it was claimed")]
    SessionExpired,

    #[error("session has not been claimed yet")]
    NotClaimed,

    #[error("the claim window does not apply to a session in state {state}")]
    ClaimWindowNotApplicable { state: &'static str },
}

/// The whole state machine, as one exhaustive match over `(state, event)`.
///
/// §10 requires every illegal pair to be an explicit arm rather than a
/// `_ => unreachable!()`, so that adding a state or an event breaks the build
/// instead of silently falling into a catch-all.
///
/// Two deliberate idempotencies, both there so a flaky LAN cannot produce a
/// spurious error:
///
/// * the *same* tablet re-claiming a session it already holds succeeds — this
///   is what a tablet does after a reconnect;
/// * a terminal state absorbs terminal-producing events (`Done`, the two
///   timeouts), so a reaper racing a normal close is benign.
///
/// What a terminal state never absorbs is `Claim` or `Submit`: those would
/// resurrect a finished session or accept work against it.
pub fn transition(
    state: &SessionState,
    event: &SessionEvent,
) -> Result<SessionState, TransitionError> {
    use SessionEvent as E;
    use SessionState as S;

    match (state, event) {
        // ── UNCLAIMED ────────────────────────────────────────────────────
        (S::Unclaimed, E::Claim { tablet_id }) => Ok(S::Active {
            tablet_id: tablet_id.clone(),
        }),
        (S::Unclaimed, E::Submit) => Err(TransitionError::NotClaimed),
        (S::Unclaimed, E::Done) => Err(TransitionError::NotClaimed),
        // The idle timer only runs once a tablet has claimed the session, so
        // seeing this against an unclaimed row means the reaper picked the
        // wrong rows.
        (S::Unclaimed, E::IdleTimeout) => Err(TransitionError::NotClaimed),
        (S::Unclaimed, E::ClaimWindowElapsed) => Ok(S::Expired),

        // ── ACTIVE ───────────────────────────────────────────────────────
        (S::Active { tablet_id }, E::Claim { tablet_id: by }) => {
            if tablet_id == by {
                Ok(S::Active {
                    tablet_id: tablet_id.clone(),
                })
            } else {
                Err(TransitionError::AlreadyClaimed {
                    claimed_by: tablet_id.clone(),
                })
            }
        }
        (S::Active { tablet_id }, E::Submit) => Ok(S::Closed {
            tablet_id: tablet_id.clone(),
            reason: CloseReason::Submitted,
        }),
        (S::Active { tablet_id }, E::Done) => Ok(S::Closed {
            tablet_id: tablet_id.clone(),
            reason: CloseReason::Done,
        }),
        (S::Active { tablet_id }, E::IdleTimeout) => Ok(S::Closed {
            tablet_id: tablet_id.clone(),
            reason: CloseReason::IdleTimeout,
        }),
        (S::Active { .. }, E::ClaimWindowElapsed) => {
            Err(TransitionError::ClaimWindowNotApplicable { state: "ACTIVE" })
        }

        // ── CLOSED (terminal) ────────────────────────────────────────────
        (S::Closed { .. }, E::Claim { .. }) => Err(TransitionError::SessionClosed),
        (S::Closed { .. }, E::Submit) => Err(TransitionError::SessionClosed),
        (S::Closed { tablet_id, reason }, E::Done)
        | (S::Closed { tablet_id, reason }, E::IdleTimeout)
        | (S::Closed { tablet_id, reason }, E::ClaimWindowElapsed) => Ok(S::Closed {
            tablet_id: tablet_id.clone(),
            reason: *reason,
        }),

        // ── EXPIRED (terminal) ───────────────────────────────────────────
        (S::Expired, E::Claim { .. }) => Err(TransitionError::SessionExpired),
        (S::Expired, E::Submit) => Err(TransitionError::SessionExpired),
        (S::Expired, E::Done)
        | (S::Expired, E::IdleTimeout)
        | (S::Expired, E::ClaimWindowElapsed) => Ok(S::Expired),
    }
}

/// How the operator was identified for this session.
///
/// §10: manual sessions are weaker evidence than a fingerprint at the door, so
/// they are flagged here and shown distinctly in reports rather than being
/// quietly mixed in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IdentityStrength {
    /// The door terminal verified a fingerprint, card or face.
    Verified,
    /// The operator typed an employee code and PIN on the tablet.
    Manual,
}

impl IdentityStrength {
    /// Maps to the `sessions.manual_identity` column.
    pub const fn is_manual(self) -> bool {
        matches!(self, IdentityStrength::Manual)
    }
}

/// A session aggregate: the state machine plus the timestamps that drive it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub id: Uuid,
    pub operator_id: Uuid,
    /// `None` for a manual-identity session — there was no punch.
    pub punch_id: Option<Uuid>,
    pub state: SessionState,
    pub identity: IdentityStrength,
    pub opened_at: DateTime<Utc>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    /// Last operator input; the idle timeout is measured from here.
    pub last_activity_at: DateTime<Utc>,
}

impl Session {
    /// Open a fresh, unclaimed session for a verified punch.
    pub fn opened(
        id: Uuid,
        operator_id: Uuid,
        punch_id: Uuid,
        opened_at: DateTime<Utc>,
    ) -> Self {
        Session {
            id,
            operator_id,
            punch_id: Some(punch_id),
            state: SessionState::Unclaimed,
            identity: IdentityStrength::Verified,
            opened_at,
            claimed_at: None,
            closed_at: None,
            last_activity_at: opened_at,
        }
    }

    /// The fallback path: no punch arrived, so the operator typed emp code and
    /// PIN. Such a session starts already claimed by the tablet in front of
    /// them — there is no card for anyone else to take.
    pub fn manual(
        id: Uuid,
        operator_id: Uuid,
        tablet_id: TabletId,
        opened_at: DateTime<Utc>,
    ) -> Self {
        Session {
            id,
            operator_id,
            punch_id: None,
            state: SessionState::Active { tablet_id },
            identity: IdentityStrength::Manual,
            opened_at,
            claimed_at: Some(opened_at),
            closed_at: None,
            last_activity_at: opened_at,
        }
    }

    /// Drive the machine and keep the timestamps consistent with the result.
    pub fn apply(
        &mut self,
        event: &SessionEvent,
        now: DateTime<Utc>,
    ) -> Result<&SessionState, TransitionError> {
        let was_terminal = self.state.is_terminal();
        let next = transition(&self.state, event)?;

        if matches!(self.state, SessionState::Unclaimed)
            && matches!(next, SessionState::Active { .. })
        {
            self.claimed_at = Some(now);
        }
        if !was_terminal && next.is_terminal() {
            self.closed_at = Some(now);
        }
        // Timeouts are the absence of activity; they must not refresh the clock
        // they are measured against.
        if !matches!(
            event,
            SessionEvent::IdleTimeout | SessionEvent::ClaimWindowElapsed
        ) {
            self.last_activity_at = now;
        }
        self.state = next;
        Ok(&self.state)
    }

    /// True when an unclaimed punch has sat past its 90 s window.
    pub fn should_expire(&self, now: DateTime<Utc>) -> bool {
        matches!(self.state, SessionState::Unclaimed)
            && now - self.opened_at >= claim_window()
    }

    /// True when an active session has gone 180 s without input.
    pub fn should_idle_close(&self, now: DateTime<Utc>) -> bool {
        matches!(self.state, SessionState::Active { .. })
            && now - self.last_activity_at >= idle_timeout()
    }

    /// True when this session should still appear on a claim screen.
    pub fn is_offerable(&self, now: DateTime<Utc>) -> bool {
        matches!(self.state, SessionState::Unclaimed) && !self.should_expire(now)
    }

    /// Whether `tablet_id` may submit work against this session.
    pub fn accepts_work_from(&self, tablet_id: &TabletId) -> Result<(), TransitionError> {
        match &self.state {
            SessionState::Active { tablet_id: bound } if bound == tablet_id => Ok(()),
            SessionState::Active { tablet_id: bound } => {
                Err(TransitionError::AlreadyClaimed {
                    claimed_by: bound.clone(),
                })
            }
            SessionState::Unclaimed => Err(TransitionError::NotClaimed),
            SessionState::Closed { .. } => Err(TransitionError::SessionClosed),
            SessionState::Expired => Err(TransitionError::SessionExpired),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_700_000_000 + secs, 0).unwrap()
    }

    fn tab(s: &str) -> TabletId {
        TabletId(s.to_owned())
    }

    fn unclaimed() -> Session {
        Session::opened(Uuid::from_u128(1), Uuid::from_u128(2), Uuid::from_u128(3), t(0))
    }

    #[test]
    fn a_punch_offers_a_session_it_does_not_become_one() {
        let s = unclaimed();
        assert_eq!(s.state, SessionState::Unclaimed);
        assert!(s.is_offerable(t(0)));
        assert!(s.claimed_at.is_none());
    }

    #[test]
    fn claiming_binds_the_session_to_one_tablet() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        assert_eq!(s.state, SessionState::Active { tablet_id: tab("TAB-1") });
        assert_eq!(s.claimed_at, Some(t(5)));
    }

    #[test]
    fn a_second_tablet_cannot_steal_a_claimed_session() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        let err = s.apply(&SessionEvent::claim("TAB-2"), t(6)).unwrap_err();
        assert_eq!(err, TransitionError::AlreadyClaimed { claimed_by: tab("TAB-1") });
        // The refusal left the binding intact.
        assert_eq!(s.state, SessionState::Active { tablet_id: tab("TAB-1") });
    }

    #[test]
    fn the_same_tablet_may_reclaim_after_a_reconnect() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        s.apply(&SessionEvent::claim("TAB-1"), t(9)).unwrap();
        assert_eq!(s.state, SessionState::Active { tablet_id: tab("TAB-1") });
    }

    #[test]
    fn tailgating_is_two_offers_and_two_independent_claims() {
        // Two people walk in; the terminal reports two punches.
        let mut a = Session::opened(Uuid::from_u128(10), Uuid::from_u128(1), Uuid::from_u128(100), t(0));
        let mut b = Session::opened(Uuid::from_u128(11), Uuid::from_u128(2), Uuid::from_u128(101), t(1));

        // Each taps their own card, on the same tablet, one after the other.
        a.apply(&SessionEvent::claim("TAB-1"), t(3)).unwrap();
        a.apply(&SessionEvent::Submit, t(20)).unwrap();
        b.apply(&SessionEvent::claim("TAB-1"), t(25)).unwrap();

        assert!(matches!(a.state, SessionState::Closed { .. }));
        assert_eq!(b.state, SessionState::Active { tablet_id: tab("TAB-1") });
        // The two sessions carry different operators — nobody's issue lands on
        // the other person's name.
        assert_ne!(a.operator_id, b.operator_id);
    }

    #[test]
    fn an_unclaimed_punch_expires_after_the_claim_window() {
        let s = unclaimed();
        assert!(!s.should_expire(t(CLAIM_WINDOW_SECS - 1)));
        assert!(s.should_expire(t(CLAIM_WINDOW_SECS)));
        assert!(!s.is_offerable(t(CLAIM_WINDOW_SECS)));
    }

    #[test]
    fn expiry_is_terminal_and_refuses_a_late_claim() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::ClaimWindowElapsed, t(90)).unwrap();
        assert_eq!(s.state, SessionState::Expired);
        assert_eq!(
            s.apply(&SessionEvent::claim("TAB-1"), t(91)).unwrap_err(),
            TransitionError::SessionExpired
        );
    }

    #[test]
    fn submitting_closes_the_session() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        s.apply(&SessionEvent::Submit, t(30)).unwrap();
        assert_eq!(
            s.state,
            SessionState::Closed {
                tablet_id: tab("TAB-1"),
                reason: CloseReason::Submitted
            }
        );
        assert_eq!(s.closed_at, Some(t(30)));
    }

    #[test]
    fn work_submitted_after_close_is_refused() {
        // This is the 410 Gone path: the tablet re-opens the claim screen
        // rather than silently discarding the operator's typing.
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        s.apply(&SessionEvent::Submit, t(30)).unwrap();
        assert_eq!(
            s.accepts_work_from(&tab("TAB-1")).unwrap_err(),
            TransitionError::SessionClosed
        );
        assert_eq!(
            s.apply(&SessionEvent::Submit, t(31)).unwrap_err(),
            TransitionError::SessionClosed
        );
    }

    #[test]
    fn an_active_session_idles_out_after_180s() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        assert!(!s.should_idle_close(t(5 + IDLE_TIMEOUT_SECS - 1)));
        assert!(s.should_idle_close(t(5 + IDLE_TIMEOUT_SECS)));
    }

    #[test]
    fn a_timeout_does_not_refresh_the_clock_it_is_measured_against() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        // A spurious claim-window event against an ACTIVE session is refused
        // and must not look like operator activity.
        assert!(s.apply(&SessionEvent::ClaimWindowElapsed, t(100)).is_err());
        assert_eq!(s.last_activity_at, t(5));
        assert!(s.should_idle_close(t(5 + IDLE_TIMEOUT_SECS)));
    }

    #[test]
    fn only_the_binding_tablet_may_submit_work() {
        let mut s = unclaimed();
        s.apply(&SessionEvent::claim("TAB-1"), t(5)).unwrap();
        assert!(s.accepts_work_from(&tab("TAB-1")).is_ok());
        assert_eq!(
            s.accepts_work_from(&tab("TAB-2")).unwrap_err(),
            TransitionError::AlreadyClaimed { claimed_by: tab("TAB-1") }
        );
    }

    #[test]
    fn an_unclaimed_session_accepts_no_work() {
        let s = unclaimed();
        assert_eq!(
            s.accepts_work_from(&tab("TAB-1")).unwrap_err(),
            TransitionError::NotClaimed
        );
    }

    #[test]
    fn manual_sessions_start_claimed_and_are_flagged_as_weaker_evidence() {
        let s = Session::manual(Uuid::from_u128(1), Uuid::from_u128(2), tab("TAB-1"), t(0));
        assert_eq!(s.state, SessionState::Active { tablet_id: tab("TAB-1") });
        assert!(s.identity.is_manual());
        assert!(s.punch_id.is_none());
        assert!(s.accepts_work_from(&tab("TAB-1")).is_ok());
    }

    #[test]
    fn terminal_states_absorb_terminal_events_but_never_resurrect() {
        let closed = SessionState::Closed {
            tablet_id: tab("TAB-1"),
            reason: CloseReason::Submitted,
        };
        for e in [
            SessionEvent::Done,
            SessionEvent::IdleTimeout,
            SessionEvent::ClaimWindowElapsed,
        ] {
            assert_eq!(transition(&closed, &e).unwrap(), closed);
            assert_eq!(transition(&SessionState::Expired, &e).unwrap(), SessionState::Expired);
        }
        for e in [SessionEvent::claim("TAB-9"), SessionEvent::Submit] {
            assert!(transition(&closed, &e).is_err());
            assert!(transition(&SessionState::Expired, &e).is_err());
        }
    }

    /// Walks all 20 `(state, event)` pairs and asserts each one has a decided
    /// outcome. This is the guard §10 asks for: if a state or event is added
    /// without a decision, this test is where it surfaces.
    #[test]
    fn every_state_event_pair_has_an_explicit_outcome() {
        let states = [
            SessionState::Unclaimed,
            SessionState::Active { tablet_id: tab("TAB-1") },
            SessionState::Closed {
                tablet_id: tab("TAB-1"),
                reason: CloseReason::Submitted,
            },
            SessionState::Expired,
        ];
        let events = [
            SessionEvent::claim("TAB-1"),
            SessionEvent::Submit,
            SessionEvent::Done,
            SessionEvent::IdleTimeout,
            SessionEvent::ClaimWindowElapsed,
        ];

        let mut legal = 0;
        let mut refused = 0;
        for s in &states {
            for e in &events {
                match transition(s, e) {
                    Ok(next) => {
                        legal += 1;
                        // A refusal is the only way out of a terminal state.
                        if s.is_terminal() {
                            assert_eq!(&next, s, "terminal state changed on {e:?}");
                        }
                    }
                    Err(_) => refused += 1,
                }
            }
        }
        assert_eq!(legal + refused, states.len() * events.len());
        assert_eq!(legal, 12);
        assert_eq!(refused, 8);
    }
}
