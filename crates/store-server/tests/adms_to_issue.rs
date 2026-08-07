//! The M2 gate against real Postgres, and the whole physical loop over HTTP.
//!
//! `store-adms`'s own tests prove the protocol against an in-memory sink.
//! These prove the *composition*: a terminal pushing to `/iclock/cdata`, the
//! punch landing in Postgres, the identity consumer offering a session, and a
//! tablet issuing against it.
//!
//! That composition is worth its own file. The ADMS listener persists punches
//! on the hot path (§9.2) and the identity consumer processes them off it, so
//! every real punch is seen twice — and a test that only ever drives
//! `MockIdentitySource` cannot see what happens on the second look.

mod harness;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use harness::{Harness, TABLET_A};
use http_body_util::BodyExt;
use rust_decimal_macros::dec;
use serde_json::json;
use store_adms::mock_device::{attlog_batch, fixture_start, MockDevice};
use tower::ServiceExt;
use uuid::Uuid;

const SERIAL: &str = "ZK-STORE-001";

async fn attlog_push(h: &Harness, body: &str) -> (StatusCode, String) {
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/iclock/cdata?SN={SERIAL}&table=ATTLOG"))
                .header("content-type", "text/plain")
                .body(Body::from(body.to_owned()))
                .unwrap(),
        )
        .await
        .expect("router responded");

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_terminal_push_opens_a_session_a_tablet_can_claim(pool: sqlx::PgPool) {
    // The loop from §1, over the wire the terminal actually uses.
    let h = Harness::start_without_mock_identity(pool).await;
    let operator = h.operator("E1042", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("CNMG120408-TN2000", dec!(10)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    let mut events = h.subscribe_events();

    // The terminal boots and hands us its serial.
    let device = MockDevice::new(h.router.clone(), SERIAL);
    let hs = device.handshake().await;
    assert!(MockDevice::handshake_is_usable(&hs), "{hs:?}");

    // Somebody puts a finger on the reader.
    let (status, ack) = attlog_push(&h, "1042\t2026-08-07 14:32:11\t0\t2\t0\t0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ack, "OK: 1", "a non-OK ack makes the device retry");

    // A session is offered — this is the step the in-memory ADMS tests cannot
    // reach, because it depends on the listener and the consumer agreeing about
    // a punch they have both seen.
    let opened = events.next_event_named("session.opened").await;
    assert_eq!(opened["emp_code"], "E1042");
    let session_id: Uuid = serde_json::from_value(opened["session_id"].clone()).unwrap();

    // And the tablet can work with it.
    h.post_json(
        TABLET_A,
        &format!("/api/v1/sessions/{session_id}/claim"),
        json!({ "tablet_id": TABLET_A }),
    )
    .await;

    let txn = h
        .post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": 5 }),
        )
        .await;

    assert_eq!(harness::dec_of(&txn["on_hand"]), dec!(95));
    assert!(store_db::ledger::reconcile(&h.pool)
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_m2_gate_against_real_postgres(pool: sqlx::PgPool) {
    // > Mock device completes handshake, pushes 500 ATTLOG rows including a
    // > full duplicate retry batch → exactly 500 punches persisted.
    let h = Harness::start_without_mock_identity(pool).await;
    for zk in ["1042", "2077", "3001"] {
        h.operator(&format!("E{zk}"), zk, &format!("Operator {zk}"), "OPERATOR")
            .await;
    }

    let mut device = MockDevice::new(h.router.clone(), SERIAL);
    assert!(MockDevice::handshake_is_usable(&device.handshake().await));

    let all = attlog_batch(500, fixture_start(), &["1042", "2077", "3001"]);
    for chunk in all.chunks(50) {
        let response = device.push_attlog(chunk).await;
        assert!(response.is_accepted(), "device would retry: {response:?}");
    }

    assert_eq!(h.punch_count().await, 500);

    // The retry: a terminal resending everything after a power cut.
    let replay = device.resend_everything().await;
    assert!(replay.is_accepted());
    assert_eq!(replay.ack_count(), Some(500));

    // The gate.
    assert_eq!(
        h.punch_count().await,
        500,
        "the duplicate retry batch created extra punches"
    );

    // And each punch offered exactly one session — deduplication has to hold
    // all the way through to the claim screen, not just in the punches table.
    h.wait_for_sessions(500).await;
    assert_eq!(h.session_count().await, 500);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_retried_batch_does_not_offer_a_second_session(pool: sqlx::PgPool) {
    // The other half of §9.1: deduplication has to hold all the way through to
    // the claim screen, not just in the punches table. Two cards for one walk
    // through the door would have the operator guessing which is theirs.
    let h = Harness::start_without_mock_identity(pool).await;
    h.operator("E1042", "1042", "R. Kumar", "OPERATOR").await;

    let line = "1042\t2026-08-07 14:32:11\t0\t2\t0\t0";

    attlog_push(&h, line).await;
    h.wait_for_sessions(1).await;

    for _ in 0..3 {
        let (_, ack) = attlog_push(&h, line).await;
        assert_eq!(ack, "OK: 1");
    }
    h.settle().await;

    assert_eq!(h.punch_count().await, 1);
    assert_eq!(h.session_count().await, 1);

    let cards = h.get_json(TABLET_A, "/api/v1/sessions/unclaimed").await;
    assert_eq!(cards.as_array().unwrap().len(), 1, "duplicate name cards");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_unknown_user_at_the_door_is_recorded_over_the_wire(pool: sqlx::PgPool) {
    // §9.4, on the real path: never drop data because the master is incomplete.
    let h = Harness::start_without_mock_identity(pool).await;

    let (status, ack) = attlog_push(&h, "9999\t2026-08-07 14:32:11\t0\t2\t0\t0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        ack, "OK: 1",
        "we must still acknowledge, or the device retries"
    );

    h.settle().await;

    assert_eq!(h.punch_count().await, 1);
    assert_eq!(h.session_count().await, 0);

    let unknown = store_db::punches::unknown_user_punches(&h.pool, 10)
        .await
        .unwrap();
    assert_eq!(unknown.len(), 1);
    assert_eq!(unknown[0].zk_user_id, "9999");
    assert_eq!(unknown[0].device_serial, SERIAL);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_device_is_recorded_on_first_contact(pool: sqlx::PgPool) {
    let h = Harness::start_without_mock_identity(pool).await;

    let device = MockDevice::new(h.router.clone(), SERIAL);
    device.handshake().await;

    let devices = store_db::punches::device_health(&h.pool).await.unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0].serial_no, SERIAL);
    assert!(
        devices[0].last_seen_at.is_some(),
        "an admin needs to see when the door was last heard from"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_punch_with_a_drifting_device_clock_is_still_usable(pool: sqlx::PgPool) {
    // §9.3: device clocks drift, and Indian half-hour offsets are a known
    // trouble spot. `received_at` is what business logic uses, so a terminal
    // claiming last year must not break the claim screen.
    let h = Harness::start_without_mock_identity(pool).await;
    h.operator("E1042", "1042", "R. Kumar", "OPERATOR").await;

    attlog_push(&h, "1042\t2019-01-01 03:00:00\t0\t2\t0\t0").await;
    h.wait_for_sessions(1).await;

    // The card is on the claim screen, because the 90 s window is measured from
    // when *we* saw it.
    let cards = h.get_json(TABLET_A, "/api/v1/sessions/unclaimed").await;
    assert_eq!(cards.as_array().unwrap().len(), 1);

    // And the device's own account of the time is kept, for diagnosis.
    let punches = store_db::punches::recent(&h.pool, 1).await.unwrap();
    assert_eq!(
        punches[0].device_ts.map(|t| t.format("%Y").to_string()),
        Some("2019".to_owned())
    );
}
