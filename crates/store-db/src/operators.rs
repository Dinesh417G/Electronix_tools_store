//! Operator lookups. Used by the session service to turn a `zk_user_id` into a
//! person, and by the manual fallback path to verify an employee code and PIN.

use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{DbError, FoundExt, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operator {
    pub id: Uuid,
    pub emp_code: String,
    pub full_name: String,
    pub zk_user_id: Option<String>,
    pub role: String,
    pub department: Option<String>,
    pub active: bool,
}

/// What the manual-PIN path needs: the operator plus the hash to verify
/// against. Kept separate from [`Operator`] so a `pin_hash` cannot be
/// serialised into an API response by accident.
#[derive(Debug, Clone)]
pub struct OperatorCredentials {
    pub operator: Operator,
    pub pin_hash: Option<String>,
}

pub async fn get(pool: &PgPool, id: Uuid) -> Result<Operator> {
    sqlx::query_as!(
        Operator,
        r#"
        select id as "id!", emp_code as "emp_code!", full_name as "full_name!",
               zk_user_id, role as "role!", department, active as "active!"
          from operators where id = $1
        "#,
        id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("operator")
}

/// Resolve the PIN programmed into the door terminal to a person.
///
/// Returns `None` for an unknown or deactivated user. §9.4: the caller records
/// the punch anyway and raises an admin notice.
pub async fn by_zk_user_id(pool: &PgPool, zk_user_id: &str) -> Result<Option<Operator>> {
    let row = sqlx::query_as!(
        Operator,
        r#"
        select id as "id!", emp_code as "emp_code!", full_name as "full_name!",
               zk_user_id, role as "role!", department, active as "active!"
          from operators where zk_user_id = $1 and active
        "#,
        zk_user_id
    )
    .fetch_optional(pool)
    .await?;

    Ok(row)
}

/// Look up an operator by employee code, with their PIN hash, for the manual
/// fallback path.
pub async fn credentials_by_emp_code(
    pool: &PgPool,
    emp_code: &str,
) -> Result<Option<OperatorCredentials>> {
    let row = sqlx::query!(
        r#"
        select id, emp_code, full_name, zk_user_id, role, department, active, pin_hash
          from operators where upper(emp_code) = upper($1) and active
        "#,
        emp_code.trim()
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| OperatorCredentials {
        operator: Operator {
            id: r.id,
            emp_code: r.emp_code,
            full_name: r.full_name,
            zk_user_id: r.zk_user_id,
            role: r.role,
            department: r.department,
            active: r.active,
        },
        pin_hash: r.pin_hash,
    }))
}

pub async fn list(pool: &PgPool, include_inactive: bool) -> Result<Vec<Operator>> {
    let rows = sqlx::query_as!(
        Operator,
        r#"
        select id as "id!", emp_code as "emp_code!", full_name as "full_name!",
               zk_user_id, role as "role!", department, active as "active!"
          from operators
         where $1::bool or active
         order by full_name
        "#,
        include_inactive
    )
    .fetch_all(pool)
    .await?;

    Ok(rows)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorInput {
    pub emp_code: String,
    pub full_name: String,
    pub zk_user_id: Option<String>,
    pub role: String,
    pub department: Option<String>,
}

pub async fn create(
    pool: &PgPool,
    input: &OperatorInput,
    pin_hash: Option<&str>,
) -> Result<Uuid> {
    let id = sqlx::query_scalar!(
        r#"
        insert into operators (emp_code, full_name, zk_user_id, role, department, pin_hash)
        values ($1, $2, $3, $4, $5, $6)
        returning id
        "#,
        input.emp_code.trim(),
        input.full_name.trim(),
        input.zk_user_id.as_deref(),
        input.role,
        input.department.as_deref(),
        pin_hash,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "employee code or terminal user id"))?;

    Ok(id)
}

/// A partial edit of an operator (`PATCH /api/v1/admin/operators/{id}`).
///
/// Every field is optional, and the two nullable ones are `Option<Option<_>>`
/// on purpose: for `zk_user_id` and `department`, *absent* and *null* are
/// different instructions. Absent means "leave it alone"; null means "clear
/// it". Collapsing them is the difference between renaming somebody and
/// quietly un-enrolling them from the door.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct OperatorPatch {
    #[serde(default)]
    pub emp_code: Option<String>,
    #[serde(default)]
    pub full_name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub zk_user_id: Option<Option<String>>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub department: Option<Option<String>>,
    #[serde(default)]
    pub active: Option<bool>,
}

/// Deserialize a present-but-null field as `Some(None)`, so the caller can
/// tell it apart from an absent field (`None`).
pub fn double_option<'de, T, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

impl OperatorPatch {
    fn is_empty(&self) -> bool {
        self.emp_code.is_none()
            && self.full_name.is_none()
            && self.zk_user_id.is_none()
            && self.role.is_none()
            && self.department.is_none()
            && self.active.is_none()
    }
}

/// Apply a patch, and optionally set or clear the PIN.
///
/// `pin_hash` follows the same three-way rule as the nullable fields:
/// `None` leaves the PIN as it is, `Some(None)` clears it, `Some(Some(hash))`
/// replaces it. A PATCH that omits `pin` must not clear it — that is the
/// difference between "I renamed somebody" and "I locked them out".
///
/// Runs in a transaction with [`lock_admin_set`] and
/// [`refuse_if_last_admin_gone`], so the crib cannot be left with nobody who can
/// administer it (§11) — not even by two admins demoting each other at once.
pub async fn update(
    pool: &PgPool,
    id: Uuid,
    patch: &OperatorPatch,
    pin_hash: Option<Option<&str>>,
) -> Result<Operator> {
    if patch.is_empty() && pin_hash.is_none() {
        return Err(DbError::Invalid("nothing to update".into()));
    }

    let emp_code = patch.emp_code.as_deref().map(str::trim);
    let full_name = patch.full_name.as_deref().map(str::trim);
    // A blank string in a nullable text column is a second way of saying
    // "none", and two ways is one too many.
    let zk_user_id = patch
        .zk_user_id
        .as_ref()
        .map(|v| v.as_deref().map(str::trim).filter(|s| !s.is_empty()));
    let department = patch
        .department
        .as_ref()
        .map(|v| v.as_deref().map(str::trim).filter(|s| !s.is_empty()));

    let mut tx = pool.begin().await?;
    lock_admin_set(&mut tx).await?;

    let updated = sqlx::query_as!(
        Operator,
        r#"
        update operators
           set emp_code   = coalesce($2, emp_code),
               full_name  = coalesce($3, full_name),
               role       = coalesce($4, role),
               active     = coalesce($5::bool, active),
               zk_user_id = case when $6::bool then $7 else zk_user_id end,
               department = case when $8::bool then $9 else department end,
               pin_hash   = case when $10::bool then $11 else pin_hash end
         where id = $1
        returning id as "id!", emp_code as "emp_code!", full_name as "full_name!",
                  zk_user_id, role as "role!", department, active as "active!"
        "#,
        id,
        emp_code,
        full_name,
        patch.role.as_deref(),
        patch.active,
        zk_user_id.is_some(),
        zk_user_id.flatten(),
        department.is_some(),
        department.flatten(),
        pin_hash.is_some(),
        pin_hash.flatten(),
    )
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| DbError::from_sqlx(e, "employee code or terminal user id"))?
    .or_not_found("operator")?;

    refuse_if_last_admin_gone(&mut tx).await?;

    tx.commit().await?;
    Ok(updated)
}

/// Retire an operator (`DELETE /api/v1/admin/operators/{id}`).
///
/// Deactivates rather than deletes, for the same reason retiring an item does:
/// `stock_ledger.operator_id` is NOT NULL and points here, and §7's whole claim
/// is that the history can still answer "who took the forty inserts" years
/// later. A person who has left is `active = false` — out of the pickers, still
/// attached to everything they signed.
///
/// Their token stops working on the next request without being revoked here:
/// [`crate::auth::authenticate`] joins `operators` and refuses an inactive one,
/// so `active` and `role` are read live rather than frozen into the token. The
/// cloud app revokes explicitly because its own reasoning is the same and it
/// prefers the belt and braces; there is nothing here for a revocation to fix.
pub async fn deactivate(pool: &PgPool, id: Uuid) -> Result<Operator> {
    let mut tx = pool.begin().await?;
    lock_admin_set(&mut tx).await?;

    let updated = sqlx::query_as!(
        Operator,
        r#"
        update operators set active = false
         where id = $1
        returning id as "id!", emp_code as "emp_code!", full_name as "full_name!",
                  zk_user_id, role as "role!", department, active as "active!"
        "#,
        id
    )
    .fetch_optional(&mut *tx)
    .await?
    .or_not_found("operator")?;

    refuse_if_last_admin_gone(&mut tx).await?;

    tx.commit().await?;
    Ok(updated)
}

/// Refuse a change that leaves the store with nobody who can administer it.
///
/// §11 notes that the first admin cannot come from the API — it needs
/// `store-cli operator add`, a Rust toolchain and the database password. So the
/// last one leaving through the API is not a recoverable state, it is a crib
/// whose console nobody can open.
///
/// Called inside the transaction that made the change, behind
/// [`lock_admin_set`]. **The transaction alone is not enough**, and the earlier
/// version of this comment claimed it was: two admins demoting *each other*
/// touch two different rows, so nothing conflicts. At READ COMMITTED each
/// transaction then counts the other as still active — its own change applied,
/// the other's invisible until it commits — both see one admin left, both
/// commit, and the crib has none. Only same-row edits were ever serialised, and
/// that is the one case this guard did not need to cover.
async fn refuse_if_last_admin_gone(tx: &mut sqlx::PgConnection) -> Result<()> {
    let admins = sqlx::query_scalar!(
        r#"select count(*) as "n!" from operators where active and role = 'ADMIN'"#
    )
    .fetch_one(&mut *tx)
    .await?;

    if admins == 0 {
        return Err(DbError::LastAdmin);
    }
    Ok(())
}

/// The advisory-lock key that serialises every change to who can administer the
/// crib.
///
/// One arbitrary constant, shared by [`update`] and [`deactivate`], and public
/// so a test can hold it and prove they take it. Advisory rather than
/// `select … for update` on the admin rows, because the two writers acquire
/// their locks in opposite orders — demote A then read B, demote B then read A
/// — which is a deadlock Postgres resolves by aborting one of them with 40P01.
/// A lock taken *first*, by everyone, cannot be taken out of order. It is held
/// for the transaction, so it is released by the commit or the rollback and
/// there is nothing to leak.
///
/// `cloud/src/app/api/v1/admin/operators/[id]/route.ts` holds the same
/// number. Nothing requires that — the two implementations never share a
/// database at the same moment — but a reader comparing them should find one
/// constant and not two.
pub const ADMIN_SET_LOCK: i64 = 0x45_4c_45_43_54; // "ELECT"

/// Take [`ADMIN_SET_LOCK`] for the rest of the transaction.
///
/// Every write that can change `active` or `role` calls this before touching a
/// row, which is what makes [`refuse_if_last_admin_gone`]'s count exact rather
/// than merely current.
async fn lock_admin_set(tx: &mut sqlx::PgConnection) -> Result<()> {
    sqlx::query!("select pg_advisory_xact_lock($1)", ADMIN_SET_LOCK)
        .execute(&mut *tx)
        .await?;
    Ok(())
}

pub async fn set_active(pool: &PgPool, id: Uuid, active: bool) -> Result<()> {
    let result = sqlx::query!("update operators set active = $2 where id = $1", id, active)
        .execute(pool)
        .await?;
    crate::expect_one(result, "operator")
}
