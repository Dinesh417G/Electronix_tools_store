//! The database half of the M1 gate (CLAUDE.md §13).
//!
//! `store-core`'s property test proves the *rule*. These tests prove that the
//! Postgres trigger maintaining the cached `item_stock.on_hand` implements the
//! same rule — including under concurrency, which is the case a pure test
//! cannot reach and the case a tool crib actually hits when two tablets take
//! the last insert at once.

use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use store_core::ledger::{Movement, Qty};
use store_db::error::DbError;
use store_db::ledger::{self, NewMovement};
use uuid::Uuid;

async fn operator(pool: &PgPool, emp_code: &str) -> Uuid {
    sqlx::query_scalar!(
        "insert into operators (emp_code, full_name, role) values ($1, $2, 'OPERATOR') returning id",
        emp_code,
        format!("Operator {emp_code}")
    )
    .fetch_one(pool)
    .await
    .expect("create operator")
}

async fn item(pool: &PgPool, code: &str, reorder_level: Decimal, allow_negative: bool) -> Uuid {
    sqlx::query_scalar!(
        r#"
        insert into items (item_code, description, uom, reorder_level, allow_negative, unit_cost)
        values ($1, $2, 'NOS', $3, $4, 120.50)
        returning id
        "#,
        code,
        format!("Test item {code}"),
        reorder_level,
        allow_negative
    )
    .fetch_one(pool)
    .await
    .expect("create item")
}

async fn on_hand(pool: &PgPool, item_id: Uuid) -> Decimal {
    sqlx::query_scalar!("select on_hand from item_stock where item_id = $1", item_id)
        .fetch_one(pool)
        .await
        .expect("read on_hand")
}

async fn ledger_sum(pool: &PgPool, item_id: Uuid) -> Decimal {
    sqlx::query_scalar!(
        r#"select coalesce(sum(delta_qty), 0) as "sum!" from stock_ledger where item_id = $1"#,
        item_id
    )
    .fetch_one(pool)
    .await
    .expect("sum ledger")
}

fn movement(m: Movement, operator_id: Uuid) -> NewMovement {
    NewMovement {
        movement: m,
        operator_id,
        session_id: None,
        machine_id: None,
        reason_id: None,
        note: None,
        unit_cost: None,
        device_ts: None,
        client_txn_uuid: None,
    }
}

fn qty(d: Decimal) -> Qty {
    Qty::new(d).expect("valid quantity")
}

#[sqlx::test]
async fn an_item_gets_a_stock_row_at_birth(pool: PgPool) {
    let id = item(&pool, "BIRTH-1", dec!(0), false).await;
    assert_eq!(on_hand(&pool, id).await, Decimal::ZERO);
}

#[sqlx::test]
async fn on_hand_tracks_the_sum_of_deltas_after_every_movement(pool: PgPool) {
    let op = operator(&pool, "E100").await;
    let it = item(&pool, "SUM-1", dec!(0), false).await;

    let steps = [
        (Movement::opening(it, qty(dec!(100))), dec!(100)),
        (Movement::issue(it, qty(dec!(5))), dec!(95)),
        (Movement::issue(it, qty(dec!(20))), dec!(75)),
        (Movement::receipt(it, qty(dec!(30))), dec!(105)),
        (Movement::scrap(it, qty(dec!(5))), dec!(100)),
        (Movement::adjust(it, dec!(-0.5)).unwrap(), dec!(99.5)),
        (Movement::adjust(it, dec!(2.25)).unwrap(), dec!(101.75)),
    ];

    for (m, expected) in steps {
        let receipt = ledger::record(&pool, &movement(m, op)).await.expect("record");
        assert_eq!(receipt.on_hand, expected);
        assert_eq!(on_hand(&pool, it).await, expected);
        // The invariant, after every single one.
        assert_eq!(on_hand(&pool, it).await, ledger_sum(&pool, it).await);
    }

    assert!(ledger::reconcile(&pool).await.unwrap().is_empty(), "drift");
}

#[sqlx::test]
async fn the_negative_stock_guard_refuses_and_leaves_no_trace(pool: PgPool) {
    let op = operator(&pool, "E101").await;
    let it = item(&pool, "GUARD-1", dec!(0), false).await;

    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(3))), op))
        .await
        .unwrap();

    let err = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(5))), op))
        .await
        .expect_err("guard should refuse");
    assert!(matches!(err, DbError::InsufficientStock(_)), "got {err:?}");

    // §7: a refused issue is not a recorded issue. The ledger is what happened,
    // not what was attempted.
    assert_eq!(on_hand(&pool, it).await, dec!(3));
    let rows = sqlx::query_scalar!(
        r#"select count(*) as "n!" from stock_ledger where item_id = $1"#,
        it
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows, 1, "the refused row was persisted");
}

#[sqlx::test]
async fn issuing_exactly_the_balance_is_allowed(pool: PgPool) {
    let op = operator(&pool, "E102").await;
    let it = item(&pool, "GUARD-2", dec!(0), false).await;

    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(3))), op))
        .await
        .unwrap();
    let r = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(3))), op))
        .await
        .expect("issuing the whole balance");
    assert_eq!(r.on_hand, Decimal::ZERO);
}

#[sqlx::test]
async fn allow_negative_items_bypass_the_guard(pool: PgPool) {
    let op = operator(&pool, "E103").await;
    let it = item(&pool, "GUARD-3", dec!(0), true).await;

    let r = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(5))), op))
        .await
        .expect("allow_negative item");
    assert_eq!(r.on_hand, dec!(-5));
    assert_eq!(on_hand(&pool, it).await, ledger_sum(&pool, it).await);
}

#[sqlx::test]
async fn the_ledger_is_append_only(pool: PgPool) {
    let op = operator(&pool, "E104").await;
    let it = item(&pool, "APPEND-1", dec!(0), false).await;
    let r = ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(10))), op))
        .await
        .unwrap();

    let update = sqlx::query("update stock_ledger set delta_qty = 999 where id = $1")
        .bind(r.ledger_id)
        .execute(&pool)
        .await;
    assert!(update.is_err(), "UPDATE on the ledger was allowed");

    let delete = sqlx::query("delete from stock_ledger where id = $1")
        .bind(r.ledger_id)
        .execute(&pool)
        .await;
    assert!(delete.is_err(), "DELETE on the ledger was allowed");
}

#[sqlx::test]
async fn a_reversal_restores_the_balance_and_keeps_both_rows(pool: PgPool) {
    let op = operator(&pool, "E105").await;
    let it = item(&pool, "REV-1", dec!(0), false).await;

    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(100))), op))
        .await
        .unwrap();
    let issue = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(40))), op))
        .await
        .unwrap();
    assert_eq!(on_hand(&pool, it).await, dec!(60));

    let rev = ledger::reverse(&pool, issue.ledger_id, op, None)
        .await
        .expect("reverse");
    assert_eq!(rev.on_hand, dec!(100));

    // Both halves survive — that is what makes the audit trail defensible.
    let count = sqlx::query_scalar!(
        r#"select count(*) as "n!" from stock_ledger where item_id = $1"#,
        it
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 3);

    let reverses_id = sqlx::query_scalar!(
        "select reverses_id from stock_ledger where id = $1",
        rev.ledger_id
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reverses_id, Some(issue.ledger_id));
}

#[sqlx::test]
async fn a_row_cannot_be_reversed_twice(pool: PgPool) {
    let op = operator(&pool, "E106").await;
    let it = item(&pool, "REV-2", dec!(0), false).await;

    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(100))), op))
        .await
        .unwrap();
    let issue = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(40))), op))
        .await
        .unwrap();

    ledger::reverse(&pool, issue.ledger_id, op, None).await.unwrap();
    let second = ledger::reverse(&pool, issue.ledger_id, op, None).await;

    assert!(matches!(second, Err(DbError::Conflict(_))), "got {second:?}");
    assert_eq!(on_hand(&pool, it).await, dec!(100), "double correction");
}

#[sqlx::test]
async fn a_reversal_cannot_itself_be_reversed(pool: PgPool) {
    let op = operator(&pool, "E107").await;
    let it = item(&pool, "REV-3", dec!(0), false).await;

    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(50))), op))
        .await
        .unwrap();
    let issue = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(10))), op))
        .await
        .unwrap();
    let rev = ledger::reverse(&pool, issue.ledger_id, op, None).await.unwrap();

    let err = ledger::reverse(&pool, rev.ledger_id, op, None).await;
    assert!(matches!(err, Err(DbError::Invalid(_))), "got {err:?}");
}

#[sqlx::test]
async fn crossing_the_reorder_level_raises_low_then_empty(pool: PgPool) {
    let op = operator(&pool, "E108").await;
    let it = item(&pool, "ALERT-1", dec!(10), false).await;

    let r = ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(100))), op))
        .await
        .unwrap();
    assert_eq!(r.alert_state, "OK");
    assert!(!r.crossed_threshold);

    let r = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(95))), op))
        .await
        .unwrap();
    assert_eq!(r.alert_state, "LOW");
    assert!(r.crossed_threshold, "the tablet needs to show the LOW banner");

    let r = ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(5))), op))
        .await
        .unwrap();
    assert_eq!(r.alert_state, "EMPTY");
    assert!(r.crossed_threshold);

    // Exactly one open alert, at the current level.
    let open = sqlx::query!(
        r#"select level as "level!" from stock_alerts
            where item_id = $1 and resolved_at is null"#,
        it
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(open.len(), 1);
    assert_eq!(open[0].level, "EMPTY");

    // Restocking resolves it.
    let r = ledger::record(&pool, &movement(Movement::receipt(it, qty(dec!(200))), op))
        .await
        .unwrap();
    assert_eq!(r.alert_state, "OK");
    let still_open = sqlx::query_scalar!(
        r#"select count(*) as "n!" from stock_alerts
            where item_id = $1 and resolved_at is null"#,
        it
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(still_open, 0);
}

#[sqlx::test]
async fn raising_the_reorder_level_re_evaluates_without_a_movement(pool: PgPool) {
    let op = operator(&pool, "E109").await;
    let it = item(&pool, "ALERT-2", dec!(5), false).await;
    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(20))), op))
        .await
        .unwrap();

    sqlx::query!("update items set reorder_level = 50 where id = $1", it)
        .execute(&pool)
        .await
        .unwrap();

    let state = sqlx::query_scalar!(
        r#"select alert_state as "s!" from item_stock where item_id = $1"#,
        it
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "LOW", "a policy change must surface immediately");
}

#[sqlx::test]
async fn an_offline_outbox_replay_does_not_double_book(pool: PgPool) {
    // §12: the tablet queues writes to a local SQLite outbox and flushes when
    // the LAN returns. A flush that is interrupted mid-ack replays.
    let op = operator(&pool, "E110").await;
    let it = item(&pool, "OUTBOX-1", dec!(0), false).await;
    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(100))), op))
        .await
        .unwrap();

    let txn_uuid = Uuid::new_v4();
    let mut queued = movement(Movement::issue(it, qty(dec!(7))), op);
    queued.client_txn_uuid = Some(txn_uuid);

    let first = ledger::record(&pool, &queued).await.unwrap();
    let replay = ledger::record(&pool, &queued).await.unwrap();

    assert_eq!(first.ledger_id, replay.ledger_id, "replay created a second row");
    assert_eq!(on_hand(&pool, it).await, dec!(93));
    assert_eq!(on_hand(&pool, it).await, ledger_sum(&pool, it).await);
}

#[sqlx::test]
async fn concurrent_issues_cannot_oversell_the_last_insert(pool: PgPool) {
    // Two tablets, one insert left. Exactly one must win.
    let op = operator(&pool, "E111").await;
    let it = item(&pool, "RACE-1", dec!(0), false).await;
    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(1))), op))
        .await
        .unwrap();

    let ma = movement(Movement::issue(it, qty(dec!(1))), op);
    let mb = movement(Movement::issue(it, qty(dec!(1))), op);
    let (ra, rb) = tokio::join!(
        ledger::record(&pool, &ma),
        ledger::record(&pool, &mb)
    );

    let winners = [ra.is_ok(), rb.is_ok()].iter().filter(|ok| **ok).count();
    assert_eq!(winners, 1, "both tablets were allowed to take the last insert");

    assert_eq!(on_hand(&pool, it).await, Decimal::ZERO);
    assert_eq!(on_hand(&pool, it).await, ledger_sum(&pool, it).await);
    assert!(ledger::reconcile(&pool).await.unwrap().is_empty());
}

#[sqlx::test]
async fn reconcile_reports_drift_when_the_cache_is_tampered_with(pool: PgPool) {
    // The cache is trigger-maintained, so drift should be impossible. This test
    // forces it, to prove `store-cli reconcile` would actually notice.
    let op = operator(&pool, "E112").await;
    let it = item(&pool, "DRIFT-1", dec!(0), false).await;
    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(10))), op))
        .await
        .unwrap();

    assert!(ledger::reconcile(&pool).await.unwrap().is_empty());

    sqlx::query!("update item_stock set on_hand = 999 where item_id = $1", it)
        .execute(&pool)
        .await
        .unwrap();

    let drift = ledger::reconcile(&pool).await.unwrap();
    assert_eq!(drift.len(), 1);
    assert_eq!(drift[0].item_code, "DRIFT-1");
    assert_eq!(drift[0].cached_on_hand, dec!(999));
    assert_eq!(drift[0].ledger_sum, dec!(10));
    assert_eq!(drift[0].difference(), dec!(989));
}

#[sqlx::test]
async fn unit_cost_is_snapshotted_at_transaction_time(pool: PgPool) {
    let op = operator(&pool, "E113").await;
    let it = item(&pool, "COST-1", dec!(0), false).await;

    ledger::record(&pool, &movement(Movement::opening(it, qty(dec!(10))), op))
        .await
        .unwrap();

    // The price goes up after the fact.
    sqlx::query!("update items set unit_cost = 250.00 where id = $1", it)
        .execute(&pool)
        .await
        .unwrap();
    ledger::record(&pool, &movement(Movement::issue(it, qty(dec!(2))), op))
        .await
        .unwrap();

    let costs = sqlx::query_scalar!(
        "select unit_cost from stock_ledger where item_id = $1 order by id",
        it
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    // The old row keeps the old price: valuing last year's consumption at
    // today's price would quietly rewrite last year's reports.
    assert_eq!(costs[0], Some(dec!(120.50)));
    assert_eq!(costs[1], Some(dec!(250.00)));
}

#[sqlx::test]
async fn a_zero_delta_is_refused_by_the_database(pool: PgPool) {
    let op = operator(&pool, "E114").await;
    let it = item(&pool, "ZERO-1", dec!(0), false).await;

    let result = sqlx::query(
        "insert into stock_ledger (item_id, delta_qty, txn_type, operator_id)
         values ($1, 0, 'ADJUST', $2)",
    )
    .bind(it)
    .bind(op)
    .execute(&pool)
    .await;

    assert!(result.is_err(), "a zero delta was accepted");
}

#[sqlx::test]
async fn sign_rules_are_enforced_by_the_database(pool: PgPool) {
    let op = operator(&pool, "E115").await;
    let it = item(&pool, "SIGN-1", dec!(0), false).await;

    // An ISSUE that increases stock is not an issue.
    let bad = sqlx::query(
        "insert into stock_ledger (item_id, delta_qty, txn_type, operator_id)
         values ($1, 5, 'ISSUE', $2)",
    )
    .bind(it)
    .bind(op)
    .execute(&pool)
    .await;
    assert!(bad.is_err());

    // A RECEIPT that decreases it is not a receipt.
    let bad = sqlx::query(
        "insert into stock_ledger (item_id, delta_qty, txn_type, operator_id)
         values ($1, -5, 'RECEIPT', $2)",
    )
    .bind(it)
    .bind(op)
    .execute(&pool)
    .await;
    assert!(bad.is_err());
}
