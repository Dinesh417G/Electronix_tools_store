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

pub async fn set_active(pool: &PgPool, id: Uuid, active: bool) -> Result<()> {
    let result = sqlx::query!("update operators set active = $2 where id = $1", id, active)
        .execute(pool)
        .await?;
    crate::expect_one(result, "operator")
}
