//! Machines: the axis a consumption report is grouped by (§11).
//!
//! `GET /api/v1/machines` — the terminal's picker — has existed since M4 and
//! serves the active rows and nothing else. What was missing was every other
//! verb: a new VMC arriving on the shop floor meant an INSERT typed against
//! the database, which is a fine way to add one machine and a poor way to add
//! fifty.
//!
//! **Retire, never delete.** `stock_ledger.machine_id` points here, and a
//! machine that was scrapped this year is still the answer to "what ate the end
//! mills last year" (§7). Retiring takes it out of the terminal's picker
//! (§12.6) and leaves every report that names it intact.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{DbError, FoundExt, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Machine {
    pub id: Uuid,
    pub code: String,
    pub name: Option<String>,
    pub active: bool,
}

/// The admin list's row. It carries what the picker's does not: the retired
/// machines, and how much history is attached to each.
///
/// That count is the difference between a safe rename and a damaging one. A
/// machine with no transactions can be renamed freely; one with three years
/// behind it is the label on every past consumption report, and renaming it
/// silently rewrites all of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAdminView {
    pub id: Uuid,
    pub code: String,
    pub name: Option<String>,
    pub active: bool,
    pub txn_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MachineInput {
    pub code: String,
    #[serde(default)]
    pub name: Option<String>,
    /// Absent means active. Sending `false` retires; sending `true` brings a
    /// retired machine back, which is what the conflict message on a duplicate
    /// code tells the storekeeper to do.
    #[serde(default)]
    pub active: Option<bool>,
}

/// Trim and length-check a code or label.
///
/// Kept here rather than in `store-core` deliberately: an item code has a
/// *format* (§6, and `store_core::item::validate_item_code` enforces it), while
/// a machine code is whatever the shop paints on the machine. The only real
/// rules are that it is not blank and that it fits the column.
fn clean(value: &str, field: &'static str, max: usize) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(DbError::Invalid(format!("{field} cannot be blank")));
    }
    if trimmed.chars().count() > max {
        return Err(DbError::Invalid(format!(
            "{field} is longer than {max} characters"
        )));
    }
    Ok(trimmed.to_owned())
}

/// Optional free text: blank collapses to `NULL` rather than to an empty
/// string, so "no name" is one value in the database instead of two.
fn clean_opt(value: Option<&str>, field: &'static str, max: usize) -> Result<Option<String>> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => Ok(Some(clean(v, field, max)?)),
        None => Ok(None),
    }
}

/// Every machine, retired ones included, with its transaction count.
pub async fn list_admin(pool: &PgPool) -> Result<Vec<MachineAdminView>> {
    let rows = sqlx::query_as!(
        MachineAdminView,
        r#"
        select m.id as "id!", m.code as "code!", m.name, m.active as "active!",
               (select count(*) from stock_ledger l where l.machine_id = m.id)
                 as "txn_count!"
          from machines m
         order by m.active desc, m.code
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

pub async fn get(pool: &PgPool, id: Uuid) -> Result<Machine> {
    sqlx::query_as!(
        Machine,
        r#"
        select id as "id!", code as "code!", name, active as "active!"
          from machines where id = $1
        "#,
        id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("machine")
}

pub async fn create(pool: &PgPool, input: &MachineInput) -> Result<Machine> {
    let code = clean(&input.code, "machine code", 32)?;
    let name = clean_opt(input.name.as_deref(), "machine name", 200)?;

    sqlx::query_as!(
        Machine,
        r#"
        insert into machines (code, name, active)
        values ($1, $2, coalesce($3, true))
        returning id as "id!", code as "code!", name, active as "active!"
        "#,
        code,
        name,
        input.active,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "machine code"))
}

pub async fn update(pool: &PgPool, id: Uuid, input: &MachineInput) -> Result<Machine> {
    let code = clean(&input.code, "machine code", 32)?;
    let name = clean_opt(input.name.as_deref(), "machine name", 200)?;

    sqlx::query_as!(
        Machine,
        r#"
        update machines
           set code = $2, name = $3, active = coalesce($4, true)
         where id = $1
        returning id as "id!", code as "code!", name, active as "active!"
        "#,
        id,
        code,
        name,
        input.active,
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "machine code"))?
    .or_not_found("machine")
}

/// Retire a machine. The row survives, so old ledger rows still name it.
pub async fn deactivate(pool: &PgPool, id: Uuid) -> Result<Machine> {
    sqlx::query_as!(
        Machine,
        r#"
        update machines set active = false
         where id = $1
        returning id as "id!", code as "code!", name, active as "active!"
        "#,
        id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("machine")
}
