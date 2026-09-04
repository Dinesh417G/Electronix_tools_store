//! What the idle terminal needs to know about the crib it is standing in.
//!
//! Three facts with no tablet-callable source between them. `/admin/devices`
//! answers the first but requires an ADMIN, and the terminal holds a *device*
//! token that is deliberately not an operator (§11) — so the screen could not
//! find out whether this crib has a door reader at all.
//!
//! **The reader is optional (§3).** A crib that wants the tablet and nothing
//! else is a real customer, and telling them to use hardware they never bought
//! is the worst kind of wrong: confident, and about the one action the screen
//! exists to prompt. Rather than a setting somebody has to know to change, this
//! reports whether a device has *ever* checked in and lets the terminal word
//! itself accordingly.
//!
//! Ever, not recently, and the distinction is the whole point: a reader that is
//! installed but quiet for an hour is a fault to fix, a crib that never had one
//! is a configuration, and the remedies are opposite. Recency travels
//! separately, in `last_seen_at`.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;
use sqlx::PgPool;

use crate::error::Result;

/// Whether this crib has a door reader, and when it last said anything.
#[derive(Debug, Serialize)]
pub struct ReaderStatus {
    /// A device has checked in at some point in this database's life.
    pub installed: bool,
    pub last_seen_at: Option<DateTime<Utc>>,
}

/// What the crib did in the window the tablet asked about.
#[derive(Debug, Serialize)]
pub struct TodayCounts {
    pub movements: i64,
    /// Trips out, not quantity out. Summing `delta_qty` across items adds
    /// twenty-litre drums to carbide inserts: §6 gives every item a `uom`, and
    /// NOS + LTR + KG is a number with no unit and no meaning.
    pub out_count: i64,
    pub in_count: i64,
    pub last_at: Option<DateTime<Utc>>,
}

/// One line of the activity list.
#[derive(Debug, Serialize)]
pub struct RecentMovement {
    pub id: i64,
    pub delta_qty: Decimal,
    pub txn_type: String,
    pub item_code: String,
    pub uom: String,
    pub operator_name: String,
    pub created_at: DateTime<Utc>,
}

/// Is a reader installed here, and what has moved since `since`.
///
/// `since` is the *tablet's* local midnight, because the tablet is the thing
/// physically in the store and its clock is the store's clock. A server-side
/// `date_trunc('day', now())` would roll the day at 05:30 in an Indian plant —
/// mid-shift, with every number on the screen dropping to zero while somebody
/// is watching.
pub async fn status(
    pool: &PgPool,
    since: DateTime<Utc>,
) -> Result<(ReaderStatus, TodayCounts, Vec<RecentMovement>)> {
    let reader = sqlx::query_as!(
        ReaderStatus,
        r#"
        select count(*) > 0 as "installed!", max(last_seen_at) as last_seen_at
          from devices
        "#
    )
    .fetch_one(pool)
    .await?;

    // §9.3: business logic reads `created_at`, never the device clock. A day's
    // count is business logic.
    let today = sqlx::query_as!(
        TodayCounts,
        r#"
        select count(*)                                       as "movements!",
               count(*) filter (where delta_qty < 0)          as "out_count!",
               count(*) filter (where delta_qty > 0)          as "in_count!",
               max(created_at)                                as last_at
          from stock_ledger
         where created_at >= $1
        "#,
        since
    )
    .fetch_one(pool)
    .await?;

    // Scoped to the same window as the counts above. A panel headed TODAY that
    // lists last night's movements under a count that excludes them disagrees
    // with itself, and teaches the reader to distrust every number on the
    // screen — including the stock figures, which are the product.
    let recent = sqlx::query_as!(
        RecentMovement,
        r#"
        select l.id            as "id!",
               l.delta_qty     as "delta_qty!",
               l.txn_type      as "txn_type!",
               i.item_code     as "item_code!",
               i.uom           as "uom!",
               o.full_name     as "operator_name!",
               l.created_at    as "created_at!"
          from stock_ledger l
          join items i     on i.id = l.item_id
          join operators o on o.id = l.operator_id
         where l.created_at >= $1
         order by l.created_at desc, l.id desc
         limit 20
        "#,
        since
    )
    .fetch_all(pool)
    .await?;

    Ok((reader, today, recent))
}
