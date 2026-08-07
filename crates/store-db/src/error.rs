//! Database errors, and the mapping from Postgres SQLSTATEs back onto domain
//! meaning.
//!
//! The §7 guard lives in a trigger, so the guard's refusal arrives as a
//! `sqlx::Error`. Translating it back into `CoreError::InsufficientStock` here
//! is what lets the API layer answer `409 Conflict` with a sentence an operator
//! can act on — *"Only 3 left in system — count the bin and adjust"* — instead
//! of leaking a driver error.

use store_core::CoreError;

/// SQLSTATEs raised by our own triggers. Kept next to the migration that
/// raises them (`0003_ledger.up.sql`).
pub mod sqlstate {
    /// An ISSUE would have driven `on_hand` below zero on an item that does not
    /// allow it.
    pub const INSUFFICIENT_STOCK: &str = "EL001";
    /// A write was attempted against the append-only ledger.
    pub const LEDGER_APPEND_ONLY: &str = "EL003";
    /// A ledger row referenced an item that does not exist.
    pub const UNKNOWN_ITEM: &str = "EL404";
    /// Postgres: unique violation.
    pub const UNIQUE_VIOLATION: &str = "23505";
    /// Postgres: foreign key violation.
    pub const FOREIGN_KEY_VIOLATION: &str = "23503";
    /// Postgres: check constraint violation.
    pub const CHECK_VIOLATION: &str = "23514";
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// The §7 negative-stock guard refused an issue. Maps to `409 Conflict`.
    #[error("{0}")]
    InsufficientStock(String),

    /// Somebody tried to UPDATE or DELETE a ledger row.
    #[error("the stock ledger is append-only; correct a mistake with a reversing row")]
    LedgerAppendOnly,

    /// The row asked for is not there.
    #[error("{entity} not found")]
    NotFound { entity: &'static str },

    /// A uniqueness rule was broken — a duplicate item code, a second claim on
    /// one punch.
    #[error("{0} already exists")]
    Conflict(String),

    /// A referenced row does not exist, or a check constraint refused the row.
    #[error("invalid reference or constraint violation: {0}")]
    Invalid(String),

    #[error(transparent)]
    Domain(#[from] CoreError),

    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),

    #[error(transparent)]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

pub type Result<T> = std::result::Result<T, DbError>;

/// A refused session transition is domain meaning, not a database failure.
/// The API layer maps it onto `409 Conflict` or `410 Gone` (§10).
impl From<store_core::TransitionError> for DbError {
    fn from(err: store_core::TransitionError) -> Self {
        DbError::Domain(err.into())
    }
}

impl DbError {
    /// Reinterpret a raw driver error as domain meaning where we can.
    ///
    /// `context` names the thing being written, so a unique violation reads as
    /// "item code already exists" rather than as an index name.
    pub fn from_sqlx(err: sqlx::Error, context: &str) -> Self {
        let Some(db_err) = err.as_database_error() else {
            return DbError::Sqlx(err);
        };
        let code = db_err.code().unwrap_or_default().to_string();
        let message = db_err.message().to_owned();

        match code.as_str() {
            sqlstate::INSUFFICIENT_STOCK => DbError::InsufficientStock(message),
            sqlstate::LEDGER_APPEND_ONLY => DbError::LedgerAppendOnly,
            sqlstate::UNKNOWN_ITEM => DbError::NotFound { entity: "item" },
            sqlstate::UNIQUE_VIOLATION => DbError::Conflict(context.to_owned()),
            sqlstate::FOREIGN_KEY_VIOLATION | sqlstate::CHECK_VIOLATION => {
                DbError::Invalid(message)
            }
            _ => DbError::Sqlx(err),
        }
    }

    /// True when the caller may retry the operation unchanged.
    pub fn is_transient(&self) -> bool {
        matches!(self, DbError::Sqlx(sqlx::Error::PoolTimedOut | sqlx::Error::Io(_)))
    }
}

/// Convenience for `Option<T>` rows returned by `fetch_optional`.
pub trait FoundExt<T> {
    fn or_not_found(self, entity: &'static str) -> Result<T>;
}

impl<T> FoundExt<T> for Option<T> {
    fn or_not_found(self, entity: &'static str) -> Result<T> {
        self.ok_or(DbError::NotFound { entity })
    }
}
