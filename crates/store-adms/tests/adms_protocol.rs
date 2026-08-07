//! The M2 acceptance gate (CLAUDE.md §13).
//!
//! > Mock device completes handshake, pushes 500 ATTLOG rows including a full
//! > duplicate retry batch → exactly 500 punches persisted.
//!
//! The sink here is an in-memory stand-in for `store-db`, deduplicating on the
//! same `(serial, user_id, device_ts)` key as the `punches_dedup` index. The
//! same gate is re-run against real Postgres in `store-server`'s integration
//! tests; this one keeps the protocol honest without needing a database.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use futures::StreamExt;
use store_adms::mock_device::{attlog_batch, fixture_start, MockDevice};
use store_adms::protocol::AttlogRecord;
use store_adms::routes::{AdmsState, PunchSink, SinkError};
use store_adms::{router, DeviceCommand};
use store_core::identity::{IdentitySource, VerifyMode};

/// An in-memory `PunchSink` with the same dedup key as the real index.
#[derive(Debug, Default)]
struct RecordingSink {
    /// Deduplicated punches, in arrival order.
    punches: Mutex<Vec<(String, String, Option<String>)>>,
    seen: Mutex<HashSet<(String, String, Option<String>)>>,
    devices: Mutex<Vec<String>>,
    /// Flips the sink into failure mode, to prove a failed persist is not
    /// acknowledged.
    fail: AtomicBool,
}

impl RecordingSink {
    fn count(&self) -> usize {
        self.punches.lock().unwrap().len()
    }
    fn device_calls(&self) -> usize {
        self.devices.lock().unwrap().len()
    }
}

#[async_trait]
impl PunchSink for RecordingSink {
    async fn device_seen(
        &self,
        serial: &str,
        _firmware: Option<&str>,
    ) -> Result<(), SinkError> {
        self.devices.lock().unwrap().push(serial.to_owned());
        Ok(())
    }

    async fn persist(
        &self,
        serial: &str,
        records: &[AttlogRecord],
    ) -> Result<usize, SinkError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(SinkError("database is down".into()));
        }

        let mut seen = self.seen.lock().unwrap();
        let mut punches = self.punches.lock().unwrap();
        let mut new = 0;

        for r in records {
            let key = (
                serial.to_owned(),
                r.user_id.clone(),
                r.device_ts.map(|t| t.to_rfc3339()),
            );
            if seen.insert(key.clone()) {
                punches.push(key);
                new += 1;
            }
        }

        Ok(new)
    }
}

fn harness() -> (Arc<RecordingSink>, AdmsState) {
    let sink = Arc::new(RecordingSink::default());
    let state = AdmsState::new(sink.clone());
    (sink, state)
}

#[tokio::test]
async fn the_m2_gate_five_hundred_rows_with_a_full_duplicate_retry_batch() {
    let (sink, state) = harness();
    let mut device = MockDevice::new(router(state), "ZK-STORE-001");

    // 1. Handshake.
    let hs = device.handshake().await;
    assert!(
        MockDevice::handshake_is_usable(&hs),
        "device could not start from this handshake: {hs:?}"
    );

    // 2. Push 500 rows, in the batches a real terminal would use.
    let all = attlog_batch(500, fixture_start(), &["1042", "2077", "3001"]);
    for chunk in all.chunks(50) {
        let response = device.push_attlog(chunk).await;
        assert!(response.is_accepted(), "device would retry: {response:?}");
        assert_eq!(response.ack_count(), Some(chunk.len()));
    }
    assert_eq!(sink.count(), 500, "500 distinct rows should persist as 500");

    // 3. The retry. §9.1: the device resends everything it has ever sent after
    //    a power cut with ATTLOGStamp=0. This must be a no-op.
    let replay = device.resend_everything().await;
    assert!(replay.is_accepted());
    assert_eq!(
        replay.ack_count(),
        Some(500),
        "a retry must be acknowledged in full, or the device retries again"
    );

    // The gate.
    assert_eq!(
        sink.count(),
        500,
        "the duplicate batch created extra punches"
    );
}

#[tokio::test]
async fn a_single_batch_retried_verbatim_is_a_no_op() {
    let (sink, state) = harness();
    let mut device = MockDevice::new(router(state), "ZK-STORE-001");

    let batch = attlog_batch(10, fixture_start(), &["1042"]);
    device.push_attlog(&batch).await;
    assert_eq!(sink.count(), 10);

    for _ in 0..5 {
        let r = device.retry(&batch).await;
        assert!(r.is_accepted());
        assert_eq!(r.ack_count(), Some(10));
    }

    assert_eq!(sink.count(), 10);
}

#[tokio::test]
async fn a_failed_persist_is_not_acknowledged() {
    // §9: losing a punch is the one outcome we cannot accept. If the database
    // is down we must let the device retry rather than tell it we have the row.
    let (sink, state) = harness();
    let mut device = MockDevice::new(router(state), "ZK-STORE-001");

    sink.fail.store(true, Ordering::SeqCst);
    let batch = attlog_batch(3, fixture_start(), &["1042"]);
    let response = device.push_attlog(&batch).await;

    assert!(
        !response.is_accepted(),
        "we acknowledged a batch we did not persist"
    );
    assert_eq!(sink.count(), 0);

    // When the database comes back, the retry lands.
    sink.fail.store(false, Ordering::SeqCst);
    let retry = device.retry(&batch).await;
    assert!(retry.is_accepted());
    assert_eq!(sink.count(), 3);
}

#[tokio::test]
async fn punches_reach_the_identity_source_in_order() {
    let (_sink, state) = harness();
    let source = state.source.clone();
    let mut stream = source.subscribe().await;
    let mut device = MockDevice::new(router(state), "ZK-STORE-001");

    device
        .push_attlog(&attlog_batch(3, fixture_start(), &["1042", "2077", "3001"]))
        .await;

    let a = stream.next().await.unwrap();
    let b = stream.next().await.unwrap();
    let c = stream.next().await.unwrap();

    assert_eq!(a.external_user_id, "1042");
    assert_eq!(b.external_user_id, "2077");
    assert_eq!(c.external_user_id, "3001");
    assert_eq!(a.device_serial, "ZK-STORE-001");
    assert_eq!(a.verify_mode, VerifyMode::Fingerprint);
}

#[tokio::test]
async fn a_batch_that_fails_to_persist_publishes_nothing() {
    // Otherwise the tablet would wake for a punch that is not on record.
    let (sink, state) = harness();
    let source = state.source.clone();
    let mut stream = source.subscribe().await;
    let mut device = MockDevice::new(router(state), "ZK-STORE-001");

    sink.fail.store(true, Ordering::SeqCst);
    device
        .push_attlog(&attlog_batch(2, fixture_start(), &["1042"]))
        .await;

    // Nothing should be waiting on the stream.
    let immediate = futures::poll!(stream.next());
    assert!(immediate.is_pending(), "an unpersisted punch was published");
}

#[tokio::test]
async fn malformed_lines_do_not_fail_the_batch() {
    // §9.4's principle applied to shapes: a line we cannot parse is logged, and
    // the rest of the batch still lands. Refusing would make the device retry
    // the malformed line forever.
    let (sink, state) = harness();
    let mut device = MockDevice::new(router(state), "ZK-STORE-001");

    let mut batch = attlog_batch(3, fixture_start(), &["1042"]);
    batch.insert(1, "\t\t\t".to_owned());

    let response = device.push_attlog(&batch).await;
    assert!(response.is_accepted(), "one bad line poisoned the batch");
    assert_eq!(sink.count(), 3);
}

#[tokio::test]
async fn a_request_without_a_serial_is_refused() {
    let (_sink, state) = harness();
    let app = router(state);

    let response = tower::ServiceExt::oneshot(
        app,
        axum::http::Request::builder()
            .method("GET")
            .uri("/iclock/cdata?options=all")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn non_attendance_tables_are_acknowledged_and_ignored() {
    let (sink, state) = harness();
    let app = router(state);

    let response = tower::ServiceExt::oneshot(
        app,
        axum::http::Request::builder()
            .method("POST")
            .uri("/iclock/cdata?SN=ZK-STORE-001&table=OPERLOG")
            .body(axum::body::Body::from("some\toperation\tlog"))
            .unwrap(),
    )
    .await
    .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(sink.count(), 0);
}

#[tokio::test]
async fn the_command_queue_round_trips_through_a_device_poll() {
    let (_sink, state) = harness();
    let commands = state.commands.clone();
    let device = MockDevice::new(router(state), "ZK-STORE-001");

    // Nothing queued: the device is told OK and goes back to sleep.
    let idle = device.poll_for_command().await;
    assert_eq!(idle.body, "OK");

    let id = commands.enqueue(
        "ZK-STORE-001",
        DeviceCommand::UpdateUser {
            pin: "1042".into(),
            name: "R. Kumar".into(),
            privilege: 0,
        },
    );

    let dispatched = device.poll_for_command().await;
    assert_eq!(
        dispatched.body,
        format!("C:{id}:DATA UPDATE USERINFO PIN=1042\tName=R. Kumar\tPri=0")
    );

    // The queue empties as the command goes out, and clears once reported.
    assert_eq!(commands.pending_count("ZK-STORE-001"), 0);
    assert_eq!(commands.in_flight_count(), 1);

    let reported = device.report_command(&id, 0).await;
    assert_eq!(reported.status, axum::http::StatusCode::OK);
    assert_eq!(commands.in_flight_count(), 0);
}

#[tokio::test]
async fn every_device_contact_refreshes_last_seen() {
    let (sink, state) = harness();
    let device = MockDevice::new(router(state), "ZK-STORE-001");

    device.handshake().await;
    device.poll_for_command().await;

    assert_eq!(sink.device_calls(), 2);
}

#[tokio::test]
async fn a_device_with_no_clock_still_deduplicates() {
    // Some firmware sends rows with an empty timestamp field. NULLs are
    // distinct under a plain unique index, which would let such a device
    // duplicate freely — the real index uses NULLS NOT DISTINCT, and this
    // sink mirrors that.
    let (sink, state) = harness();
    let mut device = MockDevice::new(router(state), "ZK-STORE-001");

    let batch = vec!["1042\t\t0\t2\t0\t0".to_owned()];
    device.push_attlog(&batch).await;
    device.retry(&batch).await;
    device.retry(&batch).await;

    assert_eq!(sink.count(), 1);
}
