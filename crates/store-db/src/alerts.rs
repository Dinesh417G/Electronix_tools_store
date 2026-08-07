//! The alert console (CLAUDE.md §11, M8).
//!
//! Alert rows are raised and resolved by the ledger trigger, not from here.
//! This module only reads them and records acknowledgement — which is a human
//! act, and so is the one thing about an alert that application code owns.

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AlertRow {
    pub id: Uuid,
    pub item_id: Uuid,
    pub item_code: String,
    pub description: String,
    pub bin_location: Option<String>,
    pub level: String,
    pub on_hand: Decimal,
    pub reorder_level: Decimal,
    pub reorder_qty: Option<Decimal>,
    pub raised_at: DateTime<Utc>,
    pub acknowledged_at: Option<DateTime<Utc>>,
    pub acknowledged_by: Option<Uuid>,
    pub resolved_at: Option<DateTime<Utc>>,
}

/// Open alerts, worst first.
///
/// `include_acknowledged` exists because acknowledging is not fixing: the
/// storekeeper has seen it, but the bin is still empty, so it stays on the
/// dashboard until stock actually arrives.
pub async fn list_open(pool: &PgPool, include_acknowledged: bool) -> Result<Vec<AlertRow>> {
    let rows = sqlx::query_as!(
        AlertRow,
        r#"
        select a.id            as "id!",
               a.item_id       as "item_id!",
               i.item_code     as "item_code!",
               i.description   as "description!",
               i.bin_location,
               a.level         as "level!",
               s.on_hand       as "on_hand!",
               i.reorder_level as "reorder_level!",
               i.reorder_qty,
               a.raised_at     as "raised_at!",
               a.acknowledged_at,
               a.acknowledged_by,
               a.resolved_at
          from stock_alerts a
          join items i      on i.id = a.item_id
          join item_stock s on s.item_id = a.item_id
         where a.resolved_at is null
           and ($1::bool or a.acknowledged_at is null)
         order by case a.level when 'EMPTY' then 0 else 1 end, a.raised_at
        "#,
        include_acknowledged
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

/// Record that a storekeeper has seen an alert.
///
/// Idempotent: the first acknowledgement wins, so a double tap does not rewrite
/// who saw it first.
pub async fn acknowledge(pool: &PgPool, alert_id: Uuid, operator_id: Uuid) -> Result<()> {
    let result = sqlx::query!(
        r#"
        update stock_alerts
           set acknowledged_at = now(), acknowledged_by = $2
         where id = $1 and acknowledged_at is null
        "#,
        alert_id,
        operator_id,
    )
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        // Either already acknowledged or gone. Confirm it exists so the caller
        // can tell "already done" from "no such alert".
        sqlx::query_scalar!("select id from stock_alerts where id = $1", alert_id)
            .fetch_optional(pool)
            .await?
            .ok_or(crate::DbError::NotFound { entity: "alert" })?;
    }

    Ok(())
}

/// Count of unresolved alerts by level — the tablet's idle-screen banner (§12.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AlertSummary {
    pub low: i64,
    pub empty: i64,
}

impl AlertSummary {
    pub fn total(&self) -> i64 {
        self.low + self.empty
    }
}

pub async fn summary(pool: &PgPool) -> Result<AlertSummary> {
    let row = sqlx::query!(
        r#"
        select count(*) filter (where level = 'LOW')   as "low!",
               count(*) filter (where level = 'EMPTY') as "empty!"
          from stock_alerts where resolved_at is null
        "#
    )
    .fetch_one(pool)
    .await?;

    Ok(AlertSummary {
        low: row.low,
        empty: row.empty,
    })
}
