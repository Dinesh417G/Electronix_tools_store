//! The M9 acceptance gate, server side (CLAUDE.md §13).
//!
//! > Terminal offline outbox survives a 10-minute LAN cut with zero duplicates.
//!
//! The browser half of this gate — a real page, a real IndexedDB queue, a real
//! network cut — is driven by Playwright in `crates/store-web/tests/outbox-soak.mjs`.
//! What lives here is the property that half depends on: **the server must
//! answer a replayed transaction from the ledger, whatever else has changed
//! since.**
//!
//! That is the case a LAN cut actually produces. The dangerous failure is not
//! the request that never arrives; it is the one that arrives, commits, and
//! whose acknowledgement is lost. The tablet cannot tell those apart, so it
//! retries — and if the retry is refused, the operator is told their issue was
//! not recorded when it was, and re-enters it by hand. That is how a mechanism
//! built to prevent duplicates creates one.

mod harness;

use harness::{dec_of, Harness, TABLET_A};
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use serde_json::json;
use uuid::Uuid;

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_replay_after_the_session_closed_is_answered_from_the_ledger(pool: sqlx::PgPool) {
    // §10 closes the session on submit, so *every* outbox replay arrives at a
    // closed session. If this regresses, the whole outbox stops working and the
    // symptom is operators being told their work was lost.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;
    let body = json!({
        "session_id": session_id,
        "item_id": item,
        "qty": 7,
        "client_txn_uuid": Uuid::new_v4(),
    });

    let first = h
        .post_json(TABLET_A, "/api/v1/txn/issue", body.clone())
        .await;

    // Ten retries, as a flusher hammering a flaky link would.
    for attempt in 0..10 {
        let (status, replay) = h
            .post_raw(TABLET_A, "/api/v1/txn/issue", body.clone())
            .await;
        assert_eq!(status, 200, "retry {attempt} was refused: {replay}");
        assert_eq!(replay["ledger_id"], first["ledger_id"], "retry {attempt}");
    }

    // One row, one deduction.
    assert_eq!(h.on_hand(item).await, dec!(93));
    let rows = h
        .get_json(
            TABLET_A,
            &format!("/api/v1/ledger?item={item}&txn_type=ISSUE"),
        )
        .await;
    assert_eq!(rows.as_array().unwrap().len(), 1, "the replays duplicated");
    assert!(store_db::ledger::reconcile(&h.pool)
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_whole_queue_flushed_after_an_outage_books_each_row_once(pool: sqlx::PgPool) {
    // What a flush looks like after the LAN comes back: a batch of queued
    // transactions, each with the id it was given before its first attempt,
    // sent twice because the first flush was itself interrupted.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(500), operator).await;

    // Each queued transaction was created under its own session, because §10
    // closes a session on submit and the operator punched in for each trip.
    let mut queued = Vec::new();
    for qty in [3, 5, 2, 8, 1] {
        let session_id = h.punch_and_claim("1042", TABLET_A).await;
        queued.push(json!({
            "session_id": session_id,
            "item_id": item,
            "qty": qty,
            "client_txn_uuid": Uuid::new_v4(),
        }));
    }

    // First flush.
    for body in &queued {
        let (status, response) = h
            .post_raw(TABLET_A, "/api/v1/txn/issue", body.clone())
            .await;
        assert_eq!(status, 200, "{response}");
    }

    // The flush was interrupted before the queue was cleared, so it runs again.
    for body in &queued {
        let (status, response) = h
            .post_raw(TABLET_A, "/api/v1/txn/issue", body.clone())
            .await;
        assert_eq!(status, 200, "second flush: {response}");
    }

    // 500 - (3+5+2+8+1) = 481, once.
    assert_eq!(h.on_hand(item).await, dec!(481));
    let rows = h
        .get_json(
            TABLET_A,
            &format!("/api/v1/ledger?item={item}&txn_type=ISSUE"),
        )
        .await;
    assert_eq!(rows.as_array().unwrap().len(), 5);
    assert!(store_db::ledger::reconcile(&h.pool)
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_reused_transaction_id_for_a_different_item_is_refused(pool: sqlx::PgPool) {
    // A tablet bug, not a network one. Answering with the first item's receipt
    // would silently turn it into a stock discrepancy on two items at once.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let a = h.item("ITEM-A", dec!(0)).await;
    let b = h.item("ITEM-B", dec!(0)).await;
    h.receipt_stock(a, dec!(50), operator).await;
    h.receipt_stock(b, dec!(50), operator).await;

    let txn_uuid = Uuid::new_v4();

    let session_id = h.punch_and_claim("1042", TABLET_A).await;
    h.post_json(
        TABLET_A,
        "/api/v1/txn/issue",
        json!({ "session_id": session_id, "item_id": a, "qty": 5, "client_txn_uuid": txn_uuid }),
    )
    .await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;
    let (status, response) = h
        .post_raw(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": b, "qty": 5, "client_txn_uuid": txn_uuid }),
        )
        .await;

    assert_eq!(status, 409, "{response}");
    assert_eq!(h.on_hand(a).await, dec!(45));
    assert_eq!(h.on_hand(b).await, dec!(50), "item B must be untouched");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_receipt_replay_is_answered_the_same_way(pool: sqlx::PgPool) {
    // PUT IN goes through the same outbox, so it needs the same guarantee.
    let h = Harness::start(pool).await;
    let operator = h.operator("E5", "5001", "M. Iyer", "STOREKEEPER").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(10), operator).await;

    let session_id = h.punch_and_claim("5001", TABLET_A).await;
    let body = json!({
        "session_id": session_id,
        "item_id": item,
        "qty": 100,
        "unit_cost": "12.50",
        "client_txn_uuid": Uuid::new_v4(),
    });

    let first = h
        .post_json(TABLET_A, "/api/v1/txn/receipt", body.clone())
        .await;
    let (status, replay) = h.post_raw(TABLET_A, "/api/v1/txn/receipt", body).await;

    assert_eq!(status, 200, "{replay}");
    assert_eq!(replay["ledger_id"], first["ledger_id"]);
    assert_eq!(h.on_hand(item).await, dec!(110));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_long_outage_worth_of_queued_work_reconciles_exactly(pool: sqlx::PgPool) {
    // The gate's shape: a substantial backlog, flushed with retries throughout,
    // has to land as exactly itself. Sixty transactions is a busy shift's worth
    // for one item.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(1000), operator).await;

    let mut expected_out = Decimal::ZERO;
    let mut queued = Vec::new();
    for i in 0..60 {
        let qty = Decimal::from(1 + (i % 4));
        expected_out += qty;
        let session_id = h.punch_and_claim("1042", TABLET_A).await;
        queued.push(json!({
            "session_id": session_id,
            "item_id": item,
            "qty": qty.to_string(),
            "client_txn_uuid": Uuid::new_v4(),
        }));
    }

    // Three passes: the queue is retried until every row is acknowledged.
    for pass in 0..3 {
        for body in &queued {
            let (status, response) = h
                .post_raw(TABLET_A, "/api/v1/txn/issue", body.clone())
                .await;
            assert_eq!(status, 200, "pass {pass}: {response}");
        }
    }

    assert_eq!(h.on_hand(item).await, dec!(1000) - expected_out);

    let rows = h
        .get_json(
            TABLET_A,
            &format!("/api/v1/ledger?item={item}&txn_type=ISSUE&limit=500"),
        )
        .await;
    assert_eq!(
        rows.as_array().unwrap().len(),
        60,
        "180 requests should have produced 60 rows"
    );

    assert!(
        store_db::ledger::reconcile(&h.pool)
            .await
            .unwrap()
            .is_empty(),
        "§7: any drift is a bug"
    );

    // And the balance the tablet would show matches the ledger.
    let stock = h.get_json(TABLET_A, &format!("/api/v1/items/{item}")).await;
    assert_eq!(dec_of(&stock["on_hand"]), dec!(1000) - expected_out);
}
