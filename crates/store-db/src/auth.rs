//! Tablet registration and bearer tokens (CLAUDE.md §11).
//!
//! Two different secrets, hashed two different ways, on purpose:
//!
//! * **API tokens** are 256 bits of randomness we generate. They cannot be
//!   guessed, so SHA-256 is the correct hash — it makes a database dump useless
//!   as a set of logins without slowing every request down.
//! * **Operator PINs** are four to six digits a human chose. They *can* be
//!   guessed, so they go through argon2 with a per-PIN salt.
//!
//! Using a slow KDF for the first would cost latency for nothing; using a fast
//! hash for the second would be a real hole.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::{DbError, FoundExt, Result};

/// Who is making a request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Principal {
    /// A tablet in the store.
    Tablet { tablet_id: String },
    /// A person logged into the admin app.
    Operator {
        operator_id: Uuid,
        emp_code: String,
        role: String,
    },
}

impl Principal {
    /// True for `ADMIN` operators only. Tablets are never administrators —
    /// the terminal in the store must not be able to rewrite the catalog.
    pub fn is_admin(&self) -> bool {
        matches!(self, Principal::Operator { role, .. } if role == "ADMIN")
    }

    /// True for anyone allowed to book stock inward or adjust it.
    pub fn is_storekeeper(&self) -> bool {
        matches!(self, Principal::Operator { role, .. } if role == "ADMIN" || role == "STOREKEEPER")
    }

    pub fn tablet_id(&self) -> Option<&str> {
        match self {
            Principal::Tablet { tablet_id } => Some(tablet_id),
            Principal::Operator { .. } => None,
        }
    }
}

/// A freshly issued token. The plaintext is returned exactly once — it is not
/// recoverable afterwards, only verifiable.
#[derive(Debug, Clone, Serialize)]
pub struct IssuedToken {
    pub token: String,
    pub issued_at: DateTime<Utc>,
}

/// Hash a bearer token for storage and lookup.
fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    // Lowercase hex — a stable, index-friendly representation.
    digest.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}

/// Generate 256 bits of randomness, URL-safe.
fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    // Hex rather than base64: slightly longer, but it survives being pasted
    // into a tablet's setup screen without anyone worrying about `+` or `/`.
    bytes.iter().fold(String::with_capacity(64), |mut acc, b| {
        use std::fmt::Write;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}

/// Register a tablet and issue it a long-lived token (§11).
///
/// Re-registering an existing tablet issues a *new* token and revokes the old
/// one, which is how a reflashed or replaced tablet recovers without an admin
/// having to clean up first.
pub async fn register_tablet(
    pool: &PgPool,
    tablet_id: &str,
    name: Option<&str>,
) -> Result<IssuedToken> {
    let tablet_id = tablet_id.trim();
    if tablet_id.is_empty() {
        return Err(DbError::Invalid("tablet_id must not be blank".into()));
    }

    let mut tx = pool.begin().await?;

    sqlx::query!(
        r#"
        insert into tablets (tablet_id, name) values ($1, $2)
        on conflict (tablet_id) do update
           set name = coalesce(excluded.name, tablets.name),
               last_seen_at = now(),
               active = true
        "#,
        tablet_id,
        name,
    )
    .execute(&mut *tx)
    .await?;

    sqlx::query!(
        "update api_tokens set revoked_at = now()
          where tablet_id = $1 and revoked_at is null",
        tablet_id
    )
    .execute(&mut *tx)
    .await?;

    let token = generate_token();
    let issued_at = sqlx::query_scalar!(
        r#"
        insert into api_tokens (token_hash, kind, tablet_id)
        values ($1, 'TABLET', $2)
        returning issued_at
        "#,
        hash_token(&token),
        tablet_id,
    )
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(IssuedToken { token, issued_at })
}

/// Issue a token to a logged-in operator.
pub async fn issue_operator_token(pool: &PgPool, operator_id: Uuid) -> Result<IssuedToken> {
    let token = generate_token();
    let issued_at = sqlx::query_scalar!(
        r#"
        insert into api_tokens (token_hash, kind, operator_id, expires_at)
        values ($1, 'OPERATOR', $2, now() + interval '12 hours')
        returning issued_at
        "#,
        hash_token(&token),
        operator_id,
    )
    .fetch_one(pool)
    .await
    .map_err(|e| DbError::from_sqlx(e, "operator token"))?;

    Ok(IssuedToken { token, issued_at })
}

/// Resolve a bearer token to a principal.
///
/// Returns `None` for anything unknown, revoked or expired — the caller turns
/// that into `401`, without distinguishing between the three, because telling
/// an attacker which of their guesses was a real-but-revoked token is free
/// information.
pub async fn authenticate(pool: &PgPool, token: &str) -> Result<Option<Principal>> {
    let row = sqlx::query!(
        r#"
        select t.kind, t.tablet_id, t.operator_id,
               o.emp_code as "emp_code?", o.role as "role?",
               o.active   as "operator_active?"
          from api_tokens t
          left join operators o on o.id = t.operator_id
         where t.token_hash = $1
           and t.revoked_at is null
           and (t.expires_at is null or t.expires_at > now())
        "#,
        hash_token(token)
    )
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else { return Ok(None) };

    let principal = match row.kind.as_str() {
        "TABLET" => {
            let tablet_id = row
                .tablet_id
                .ok_or_else(|| DbError::Invalid("tablet token with no tablet".into()))?;
            Principal::Tablet { tablet_id }
        }
        "OPERATOR" => {
            // A deactivated operator's token stops working immediately, rather
            // than staying live until it expires.
            if row.operator_active != Some(true) {
                return Ok(None);
            }
            Principal::Operator {
                operator_id: row.operator_id.ok_or_else(|| {
                    DbError::Invalid("operator token with no operator".into())
                })?,
                emp_code: row.emp_code.unwrap_or_default(),
                role: row.role.unwrap_or_default(),
            }
        }
        other => return Err(DbError::Invalid(format!("unknown token kind {other:?}"))),
    };

    // Best-effort; a failure here must not cost the caller their request.
    let _ = sqlx::query!(
        "update api_tokens set last_used_at = now() where token_hash = $1",
        hash_token(token)
    )
    .execute(pool)
    .await;

    Ok(Some(principal))
}

/// Confirm a tablet is registered and active.
pub async fn tablet_exists(pool: &PgPool, tablet_id: &str) -> Result<bool> {
    let found = sqlx::query_scalar!(
        "select 1 from tablets where tablet_id = $1 and active",
        tablet_id
    )
    .fetch_optional(pool)
    .await?;
    Ok(found.is_some())
}

pub async fn touch_tablet(pool: &PgPool, tablet_id: &str) -> Result<()> {
    sqlx::query!(
        "update tablets set last_seen_at = now() where tablet_id = $1",
        tablet_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn revoke_all_for_tablet(pool: &PgPool, tablet_id: &str) -> Result<()> {
    sqlx::query!(
        "update api_tokens set revoked_at = now()
          where tablet_id = $1 and revoked_at is null",
        tablet_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

// ── Operator PINs ────────────────────────────────────────────────────────

/// Hash a PIN for storage. argon2 with a random salt, because a PIN is short
/// enough to brute-force otherwise.
pub fn hash_pin(pin: &str) -> Result<String> {
    use argon2::password_hash::{rand_core::OsRng as ArgonRng, PasswordHasher, SaltString};
    use argon2::Argon2;

    let salt = SaltString::generate(&mut ArgonRng);
    Argon2::default()
        .hash_password(pin.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| DbError::Invalid(format!("could not hash PIN: {e}")))
}

/// Verify a PIN against a stored argon2 hash.
pub fn verify_pin(pin: &str, hash: &str) -> bool {
    use argon2::password_hash::{PasswordHash, PasswordVerifier};
    use argon2::Argon2;

    let Ok(parsed) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(pin.as_bytes(), &parsed)
        .is_ok()
}

/// Set or clear an operator's PIN.
pub async fn set_pin(pool: &PgPool, operator_id: Uuid, pin: Option<&str>) -> Result<()> {
    let hash = match pin {
        Some(p) => Some(hash_pin(p)?),
        None => None,
    };
    let result = sqlx::query!(
        "update operators set pin_hash = $2 where id = $1",
        operator_id,
        hash
    )
    .execute(pool)
    .await?;
    crate::expect_one(result, "operator")
}

/// The manual fallback login (§8, §10): employee code plus PIN.
///
/// Returns `None` on any failure — unknown code, no PIN set, wrong PIN — so the
/// tablet cannot use the response to enumerate which employee codes exist.
pub async fn verify_operator_pin(
    pool: &PgPool,
    emp_code: &str,
    pin: &str,
) -> Result<Option<crate::operators::Operator>> {
    let Some(creds) = crate::operators::credentials_by_emp_code(pool, emp_code).await? else {
        return Ok(None);
    };
    let Some(hash) = creds.pin_hash.as_deref() else {
        return Ok(None);
    };
    if !verify_pin(pin, hash) {
        return Ok(None);
    }
    Ok(Some(creds.operator))
}

/// Fetch a tablet's registration.
pub async fn get_tablet(pool: &PgPool, tablet_id: &str) -> Result<TabletRow> {
    sqlx::query_as!(
        TabletRow,
        r#"
        select tablet_id as "tablet_id!", name, location,
               registered_at as "registered_at!", last_seen_at, active as "active!"
          from tablets where tablet_id = $1
        "#,
        tablet_id
    )
    .fetch_optional(pool)
    .await?
    .or_not_found("tablet")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabletRow {
    pub tablet_id: String,
    pub name: Option<String>,
    pub location: Option<String>,
    pub registered_at: DateTime<Utc>,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub active: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hashing_is_deterministic_and_not_the_token() {
        let a = hash_token("abc");
        assert_eq!(a, hash_token("abc"));
        assert_ne!(a, hash_token("abd"));
        assert_eq!(a.len(), 64);
        assert!(!a.contains("abc"));
    }

    #[test]
    fn generated_tokens_are_distinct() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn pins_verify_against_their_hash_and_nothing_else() {
        let hash = hash_pin("4271").unwrap();
        assert!(verify_pin("4271", &hash));
        assert!(!verify_pin("4272", &hash));
        assert!(!verify_pin("", &hash));
    }

    #[test]
    fn the_same_pin_hashes_differently_each_time() {
        // Per-PIN salts: otherwise the hash column would leak which operators
        // share a PIN.
        assert_ne!(hash_pin("4271").unwrap(), hash_pin("4271").unwrap());
    }

    #[test]
    fn a_malformed_hash_never_verifies() {
        assert!(!verify_pin("4271", "not-a-hash"));
        assert!(!verify_pin("4271", ""));
    }

    #[test]
    fn only_admin_operators_are_admins() {
        let admin = Principal::Operator {
            operator_id: Uuid::nil(),
            emp_code: "E1".into(),
            role: "ADMIN".into(),
        };
        let keeper = Principal::Operator {
            operator_id: Uuid::nil(),
            emp_code: "E2".into(),
            role: "STOREKEEPER".into(),
        };
        let tablet = Principal::Tablet {
            tablet_id: "TAB-1".into(),
        };

        assert!(admin.is_admin() && admin.is_storekeeper());
        assert!(!keeper.is_admin() && keeper.is_storekeeper());
        // The terminal in the store must not be able to rewrite the catalog.
        assert!(!tablet.is_admin() && !tablet.is_storekeeper());
    }
}
