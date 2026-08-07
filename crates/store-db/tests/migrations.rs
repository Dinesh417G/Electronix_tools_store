//! The M0 acceptance gate (CLAUDE.md §13).
//!
//! > `cargo test` green; `migrate run` then `revert` leaves a clean schema.

use sqlx::PgPool;
use sqlx::Row;

/// Every object we create, so the revert test can assert each one is gone
/// rather than trusting a count.
const EXPECTED_TABLES: &[&str] = &[
    "devices",
    "item_barcodes",
    "item_categories",
    "item_stock",
    "items",
    "machines",
    "operators",
    "punches",
    "reason_codes",
    "sessions",
    "stock_alerts",
    "stock_ledger",
];

const EXPECTED_FUNCTIONS: &[&str] = &[
    "evaluate_alert_level",
    "items_after_insert",
    "items_after_reorder_level_change",
    "set_updated_at",
    "stock_ledger_after_insert",
    "stock_ledger_is_append_only",
    "sync_stock_alert",
];

async fn table_names(pool: &PgPool) -> Vec<String> {
    sqlx::query(
        "select tablename from pg_tables
          where schemaname = 'public' and tablename <> '_sqlx_migrations'
          order by tablename",
    )
    .fetch_all(pool)
    .await
    .expect("list tables")
    .into_iter()
    .map(|r| r.get::<String, _>("tablename"))
    .collect()
}

async fn function_names(pool: &PgPool) -> Vec<String> {
    sqlx::query(
        "select p.proname from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
          order by p.proname",
    )
    .fetch_all(pool)
    .await
    .expect("list functions")
    .into_iter()
    .map(|r| r.get::<String, _>("proname"))
    .collect()
}

#[sqlx::test(migrations = false)]
async fn migrate_run_then_revert_leaves_a_clean_schema(pool: PgPool) {
    // Up.
    store_db::MIGRATOR.run(&pool).await.expect("migrate run");

    let tables = table_names(&pool).await;
    for expected in EXPECTED_TABLES {
        assert!(
            tables.contains(&expected.to_string()),
            "missing table {expected}"
        );
    }

    let functions = function_names(&pool).await;
    for expected in EXPECTED_FUNCTIONS {
        assert!(
            functions.contains(&expected.to_string()),
            "missing function {expected}"
        );
    }

    // And all the way back down.
    store_db::MIGRATOR
        .undo(&pool, 0)
        .await
        .expect("migrate revert");

    let tables = table_names(&pool).await;
    assert!(tables.is_empty(), "revert left tables behind: {tables:?}");

    // pg_trgm functions belong to the extension, which 0001's down migration
    // deliberately leaves in place; only our own functions must be gone.
    let functions = function_names(&pool).await;
    for ours in EXPECTED_FUNCTIONS {
        assert!(
            !functions.contains(&ours.to_string()),
            "revert left function {ours} behind"
        );
    }
}

#[sqlx::test(migrations = false)]
async fn migrations_are_idempotent_across_a_full_cycle(pool: PgPool) {
    // A second up-down-up cycle must land in exactly the same place. This is
    // what catches a down migration that drops less than its up created.
    store_db::MIGRATOR.run(&pool).await.expect("first run");
    let first = table_names(&pool).await;

    store_db::MIGRATOR.undo(&pool, 0).await.expect("revert");
    store_db::MIGRATOR.run(&pool).await.expect("second run");
    let second = table_names(&pool).await;

    assert_eq!(first, second);
}

#[sqlx::test]
async fn reference_data_is_seeded(pool: PgPool) {
    let codes: Vec<String> = sqlx::query("select code from reason_codes order by code")
        .fetch_all(&pool)
        .await
        .expect("reason codes")
        .into_iter()
        .map(|r| r.get::<String, _>("code"))
        .collect();

    // §6 names these exactly.
    for expected in [
        "BREAKAGE",
        "FOUND",
        "NEW_JOB",
        "PURCHASE",
        "RETURN_FROM_SHOP",
        "REWORK",
        "TRIAL",
        "WEAR",
    ] {
        assert!(
            codes.contains(&expected.to_string()),
            "missing reason {expected}"
        );
    }
}
