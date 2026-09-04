//! Reason codes: the words on a slice of history.
//!
//! `applies_to` is the whole design. ISSUE reasons and RECEIPT reasons are
//! different vocabularies — BREAKAGE is not a way stock arrives — and the
//! terminal shows one set or the other depending on the direction the operator
//! chose (§12.6). Migration 0004 seeds both, rather than leaving the list
//! empty, for a reason that also governs editing it: an empty list on day one
//! means every issue for the first month carries no reason, and
//! consumption-by-reason is unrecoverable after the fact.
//!
//! **Retire, never delete**, and here the foreign key is only half of it.
//! Deleting BREAKAGE because the shop stopped using it would erase the word
//! from every issue that ever cited it. Retiring drops it from the terminal's
//! chips and leaves the past legible.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{DbError, FoundExt, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasonCode {
    pub id: Uuid,
    pub code: String,
    pub label: String,
    pub applies_to: String,
    pub sort_order: i32,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReasonCodeAdminView {
    pub id: Uuid,
    pub code: String,
    pub label: String,
    pub applies_to: String,
    pub sort_order: i32,
    pub active: bool,
    pub txn_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReasonCodeInput {
    pub code: String,
    pub label: String,
    pub applies_to: String,
    /// Ten apart by convention, so one can be slipped between two later.
    #[serde(default = "default_sort_order")]
    pub sort_order: i32,
    #[serde(default)]
    pub active: Option<bool>,
}

fn default_sort_order() -> i32 {
    100
}

/// `CAPS_AND_UNDERSCORES`, because the code is read in a CSV export and typed
/// into a filter, not shown to an operator — that is what `label` is for.
fn clean_code(value: &str) -> Result<String> {
    let code = value.trim().to_owned();
    if code.is_empty() || code.chars().count() > 32 {
        return Err(DbError::Invalid(
            "a reason code is 1 to 32 characters".into(),
        ));
    }
    if !code
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(DbError::Invalid(format!(
            "{code} is not a reason code — use CAPS_AND_UNDERSCORES"
        )));
    }
    Ok(code)
}

fn clean_label(value: &str) -> Result<String> {
    let label = value.trim().to_owned();
    if label.is_empty() || label.chars().count() > 120 {
        return Err(DbError::Invalid(
            "a reason label is 1 to 120 characters".into(),
        ));
    }
    Ok(label)
}

/// The column's check constraint would refuse anything else anyway; catching it
/// here makes it a `400` with the two legal values rather than a constraint
/// name (§11).
fn clean_applies_to(value: &str) -> Result<String> {
    match value.trim().to_ascii_uppercase().as_str() {
        "ISSUE" => Ok("ISSUE".to_owned()),
        "RECEIPT" => Ok("RECEIPT".to_owned()),
        other => Err(DbError::Invalid(format!(
            "applies_to is ISSUE or RECEIPT, not {other:?}"
        ))),
    }
}

fn validate(input: &ReasonCodeInput) -> Result<(String, String, String)> {
    Ok((
        clean_code(&input.code)?,
        clean_label(&input.label)?,
        clean_applies_to(&input.applies_to)?,
    ))
}

/// Every reason code, retired ones included, with its transaction count.
pub async fn list_admin(pool: &PgPool) -> Result<Vec<ReasonCodeAdminView>> {
    let rows = sqlx::query_as!(
        ReasonCodeAdminView,
        r#"
        select r.id as "id!", r.code as "code!", r.label as "label!",
               r.applies_to as "applies_to!", r.sort_order as "sort_order!",
               r.active as "active!",
               (select count(*) from stock_ledger l where l.reason_id = r.id)
                 as "txn_count!"
          from reason_codes r
         order by r.applies_to, r.active desc, r.sort_order, r.code
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

pub async fn get(pool: &PgPool, id: Uuid) -> Result<ReasonCode> {
    sqlx::query_as!(
        ReasonCode,
        r#"
        select id as "id!", code as "code!", label as "label!",
               applies_to as "applies_to!", sort_order as "sort_order!",
               active as "active!"
          from reason_codes where id = $1
        "#,
        id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("reason code")
}

pub async fn create(pool: &PgPool, input: &ReasonCodeInput) -> Result<ReasonCode> {
    let (code, label, applies_to) = validate(input)?;

    sqlx::query_as!(
        ReasonCode,
        r#"
        insert into reason_codes (code, label, applies_to, sort_order, active)
        values ($1, $2, $3, $4, coalesce($5, true))
        returning id as "id!", code as "code!", label as "label!",
                  applies_to as "applies_to!", sort_order as "sort_order!",
                  active as "active!"
        "#,
        code,
        label,
        applies_to,
        input.sort_order,
        input.active,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "reason code"))
}

/// Editing `label` is safe — it is display text. Editing `code` cannot corrupt
/// history, because the ledger points at the id, but it can surprise anything
/// outside the database that refers to the reason by name.
pub async fn update(pool: &PgPool, id: Uuid, input: &ReasonCodeInput) -> Result<ReasonCode> {
    let (code, label, applies_to) = validate(input)?;

    sqlx::query_as!(
        ReasonCode,
        r#"
        update reason_codes
           set code = $2, label = $3, applies_to = $4, sort_order = $5,
               active = coalesce($6, true)
         where id = $1
        returning id as "id!", code as "code!", label as "label!",
                  applies_to as "applies_to!", sort_order as "sort_order!",
                  active as "active!"
        "#,
        id,
        code,
        label,
        applies_to,
        input.sort_order,
        input.active,
    )
    .fetch_optional(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "reason code"))?
    .or_not_found("reason code")
}

pub async fn deactivate(pool: &PgPool, id: Uuid) -> Result<ReasonCode> {
    sqlx::query_as!(
        ReasonCode,
        r#"
        update reason_codes set active = false
         where id = $1
        returning id as "id!", code as "code!", label as "label!",
                  applies_to as "applies_to!", sort_order as "sort_order!",
                  active as "active!"
        "#,
        id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("reason code")
}
