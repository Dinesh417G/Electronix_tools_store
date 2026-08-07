//! Persistence for the ElectronIx Tool Store.
//!
//! `sqlx` with compile-time checked queries (§2), against PostgreSQL 16.
//!
//! One rule governs everything here: **`item_stock` is never written by
//! application code** (§7). You will find no `UPDATE item_stock` in this crate.
//! That table is maintained by the `AFTER INSERT` trigger on `stock_ledger`,
//! and `store-cli reconcile` exists to prove the two never drift.

#![forbid(unsafe_code)]

pub mod alerts;
pub mod error;
pub mod items;
pub mod ledger;
pub mod operators;
pub mod punches;
pub mod reports;
pub mod sessions;

pub use error::{DbError, FoundExt, Result};

use std::time::Duration;

use sqlx::postgres::{PgPoolOptions, PgQueryResult};
use sqlx::PgPool;

/// The migrations in `migrations/`, embedded in the binary so a deployment is
/// one file rather than a file plus a directory somebody forgets to copy.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Connect to Postgres and run migrations.
///
/// `max_connections` should comfortably exceed the number of tablets: the ADMS
/// handler must never wait on a pool slot, because a slow response makes the
/// device retry and duplicate records (§9.2).
pub async fn connect(database_url: &str, max_connections: u32) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(5))
        .connect(database_url)
        .await?;
    Ok(pool)
}

/// Run every pending migration.
pub async fn migrate(pool: &PgPool) -> Result<()> {
    MIGRATOR.run(pool).await?;
    Ok(())
}

/// Assert that exactly one row was affected, or report the row as missing.
pub(crate) fn expect_one(result: PgQueryResult, entity: &'static str) -> Result<()> {
    if result.rows_affected() == 0 {
        return Err(DbError::NotFound { entity });
    }
    Ok(())
}
