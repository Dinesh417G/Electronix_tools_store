//! The M3 and M4 acceptance gates (CLAUDE.md §13).
//!
//! > **M4** — End-to-end integration test: mock punch → claim → issue 5 →
//! > on-hand drops by 5 → ledger row correct → SSE events observed in order.
//!
//! §8 and §14: every one of these runs against `MockIdentitySource`. Nothing
//! here needs a physical door terminal, which is what makes the whole system
//! testable on a laptop on a plane.

mod harness;

use harness::{dec_of, Harness, TABLET_A, TABLET_B};
use rust_decimal_macros::dec;
use serde_json::json;
use store_core::session::{CLAIM_WINDOW_SECS, IDLE_TIMEOUT_SECS};
use uuid::Uuid;

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_m4_gate_punch_to_issue_end_to_end(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let operator = h.operator("E1042", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("CNMG120408-TN2000", dec!(10)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    // A tablet is watching the stream before anything happens — §4: no polling.
    let mut events = h.subscribe_events();

    // 1. The operator puts a finger on the door terminal.
    h.punch("1042").await;

    // 2. `session.opened` arrives, and the tablet foregrounds the claim screen.
    let opened = events.next_event().await;
    assert_eq!(opened["type"], "session.opened");
    assert_eq!(opened["emp_code"], "E1042");
    assert_eq!(opened["full_name"], "R. Kumar");

    let session_id: Uuid =
        serde_json::from_value(opened["session_id"].clone()).expect("session id");

    // The claim screen shows exactly one card.
    let cards = h.get_json(TABLET_A, "/api/v1/sessions/unclaimed").await;
    assert_eq!(cards.as_array().unwrap().len(), 1);
    assert_eq!(cards[0]["full_name"], "R. Kumar");

    // 3. They tap their own card.
    let claimed = h
        .post_json(
            TABLET_A,
            &format!("/api/v1/sessions/{session_id}/claim"),
            json!({ "tablet_id": TABLET_A }),
        )
        .await;
    assert_eq!(claimed["state"], "ACTIVE");
    assert_eq!(events.next_event().await["type"], "session.claimed");

    // 4. Scan the bin barcode. §11 budgets under 100 ms for this.
    let scanned = h
        .get_json(TABLET_A, "/api/v1/items/lookup?barcode=CNMG120408-TN2000")
        .await;
    assert_eq!(dec_of(&scanned["on_hand"]), dec!(100));
    assert_eq!(scanned["description"], "Test item CNMG120408-TN2000");

    // 5. Issue 5.
    let txn = h
        .post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({
                "session_id": session_id,
                "item_id": item,
                "qty": 5,
            }),
        )
        .await;

    // On-hand drops by exactly 5.
    assert_eq!(dec_of(&txn["on_hand"]), dec!(95));
    assert_eq!(dec_of(&txn["delta_qty"]), dec!(-5));
    assert_eq!(txn["alert_state"], "OK");

    // 6. The ledger row is correct — this is the record that has to survive.
    let ledger = h.get_json(TABLET_A, "/api/v1/ledger?limit=1").await;
    let row = &ledger[0];
    assert_eq!(row["txn_type"], "ISSUE");
    assert_eq!(dec_of(&row["delta_qty"]), dec!(-5));
    assert_eq!(row["operator_name"], "R. Kumar");
    assert_eq!(row["item_code"], "CNMG120408-TN2000");
    assert_eq!(
        row["session_id"],
        json!(session_id),
        "the ledger row must name the session it came from"
    );

    // 7. §10: submit closes the session, and the tablet is told.
    let closed = events.next_event().await;
    assert_eq!(closed["type"], "session.closed");
    assert_eq!(closed["reason"], "SUBMITTED");

    // 8. And the cached balance still equals the ledger.
    assert!(
        store_db::ledger::reconcile(&h.pool)
            .await
            .unwrap()
            .is_empty(),
        "the end-to-end flow left drift behind"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn work_submitted_after_the_session_closes_is_410_gone(pool: sqlx::PgPool) {
    // §10: the tablet re-opens the claim screen rather than silently discarding
    // the operator's typing. That behaviour depends on this status code.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;

    // The first issue succeeds and closes the session.
    h.post_json(
        TABLET_A,
        "/api/v1/txn/issue",
        json!({ "session_id": session_id, "item_id": item, "qty": 1 }),
    )
    .await;

    // The second is refused.
    let (status, body) = h
        .post_raw(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": 1 }),
        )
        .await;

    assert_eq!(status, 410, "expected 410 Gone, body: {body}");
    assert_eq!(body["code"], "session_gone");

    // And nothing was booked.
    let stock = h.on_hand(item).await;
    assert_eq!(stock, dec!(99));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_second_tablet_cannot_steal_a_claimed_session(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;

    let (status, body) = h
        .post_raw(
            TABLET_B,
            &format!("/api/v1/sessions/{session_id}/claim"),
            json!({ "tablet_id": TABLET_B }),
        )
        .await;

    assert_eq!(status, 409);
    assert!(
        body["message"].as_str().unwrap().contains(TABLET_A),
        "the refusal should name the holder: {body}"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn tailgating_gives_each_person_their_own_card_and_their_own_ledger_rows(
    pool: sqlx::PgPool,
) {
    // The M3 gate: two people walk in on what looks like one entry.
    let h = Harness::start(pool).await;
    let kumar = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let singh = h.operator("E2", "2077", "A. Singh", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(100), kumar).await;

    h.punch("1042").await;
    h.punch("2077").await;
    h.settle().await;

    // Both cards are on the claim screen. §10: tailgating is solved socially.
    let cards = h.get_json(TABLET_A, "/api/v1/sessions/unclaimed").await;
    let cards = cards.as_array().unwrap();
    assert_eq!(cards.len(), 2);

    // Each person taps their own, one after the other on the same tablet.
    for (name, qty) in [("R. Kumar", 3), ("A. Singh", 7)] {
        let card = cards
            .iter()
            .find(|c| c["full_name"] == name)
            .expect("card for {name}");
        let session_id: Uuid = serde_json::from_value(card["session_id"].clone()).unwrap();

        h.post_json(
            TABLET_A,
            &format!("/api/v1/sessions/{session_id}/claim"),
            json!({ "tablet_id": TABLET_A }),
        )
        .await;

        h.post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": qty }),
        )
        .await;
    }

    // Nobody's issue landed on the other person's name.
    let by_operator = h
        .get_json(
            TABLET_A,
            &format!("/api/v1/ledger?operator={kumar}&txn_type=ISSUE"),
        )
        .await;
    assert_eq!(by_operator.as_array().unwrap().len(), 1);
    assert_eq!(dec_of(&by_operator[0]["delta_qty"]), dec!(-3));

    let by_operator = h
        .get_json(
            TABLET_A,
            &format!("/api/v1/ledger?operator={singh}&txn_type=ISSUE"),
        )
        .await;
    assert_eq!(by_operator.as_array().unwrap().len(), 1);
    assert_eq!(dec_of(&by_operator[0]["delta_qty"]), dec!(-7));

    assert_eq!(h.on_hand(item).await, dec!(90));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_unclaimed_punch_expires_after_the_claim_window(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;

    let session_id = h.punch("1042").await;

    // Wind the clock back rather than waiting 90 seconds.
    h.age_session(session_id, CLAIM_WINDOW_SECS + 1).await;

    // The card is gone from the claim screen.
    let cards = h.get_json(TABLET_A, "/api/v1/sessions/unclaimed").await;
    assert!(cards.as_array().unwrap().is_empty());

    // And a late claim is refused.
    let (status, body) = h
        .post_raw(
            TABLET_A,
            &format!("/api/v1/sessions/{session_id}/claim"),
            json!({ "tablet_id": TABLET_A }),
        )
        .await;
    assert_eq!(status, 410, "{body}");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_idle_session_is_closed_by_the_reaper(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;
    h.age_activity(session_id, IDLE_TIMEOUT_SECS + 1).await;

    let reaped = store_db::sessions::reap(&h.pool).await.unwrap();
    assert_eq!(reaped.idle_closed, vec![session_id]);

    let session = store_db::sessions::get(&h.pool, session_id).await.unwrap();
    assert_eq!(session.state.as_str(), "CLOSED");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_negative_stock_guard_reaches_the_tablet_as_a_409(pool: sqlx::PgPool) {
    // §7: the tablet surfaces this as "Only 3 left in system — count the bin
    // and adjust", not as a silent failure.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(3), operator).await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;

    let (status, body) = h
        .post_raw(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": 5 }),
        )
        .await;

    assert_eq!(status, 409, "{body}");
    let message = body["message"].as_str().unwrap();
    assert!(
        message.contains('3') && message.contains('5'),
        "the message must tell the operator what is actually there: {message}"
    );

    // Nothing was booked, and the session is still usable for a smaller issue.
    assert_eq!(h.on_hand(item).await, dec!(3));
    let ok = h
        .post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": 3 }),
        )
        .await;
    assert_eq!(dec_of(&ok["on_hand"]), dec!(0));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn crossing_the_reorder_level_raises_an_alert_and_an_sse_event(pool: sqlx::PgPool) {
    // The M8 gate, end to end.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(10)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    let mut events = h.subscribe_events();
    let session_id = h.punch_and_claim("1042", TABLET_A).await;

    let txn = h
        .post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": 95 }),
        )
        .await;

    assert_eq!(txn["alert_state"], "LOW");
    assert_eq!(
        txn["crossed_threshold"], true,
        "the tablet needs this to show 'now LOW — storekeeper notified'"
    );

    let alert = events.next_event_named("alert.raised").await;
    assert_eq!(alert["level"], "LOW");
    assert_eq!(alert["item_code"], "ITEM-1");

    // It is on the dashboard too.
    let alerts = h.get_json(TABLET_A, "/api/v1/alerts").await;
    assert_eq!(alerts.as_array().unwrap().len(), 1);
    assert_eq!(alerts[0]["level"], "LOW");

    let summary = h.get_json(TABLET_A, "/api/v1/alerts/summary").await;
    assert_eq!(summary["low"], 1);
    assert_eq!(summary["empty"], 0);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_punch_from_an_unknown_user_is_recorded_and_reported(pool: sqlx::PgPool) {
    // §9.4: never drop data because the operator master is incomplete.
    let h = Harness::start(pool).await;
    let mut events = h.subscribe_events();

    h.punch_expecting_no_session("9999").await;

    let notice = events.next_event().await;
    assert_eq!(notice["type"], "punch.unknown_user");
    assert_eq!(notice["zk_user_id"], "9999");

    // The punch itself is on record.
    let punches = store_db::punches::recent(&h.pool, 10).await.unwrap();
    assert_eq!(punches.len(), 1);
    assert_eq!(punches[0].zk_user_id, "9999");

    // And it shows up as an admin notice.
    let unknown = store_db::punches::unknown_user_punches(&h.pool, 10)
        .await
        .unwrap();
    assert_eq!(unknown.len(), 1);
    assert_eq!(unknown[0].zk_user_id, "9999");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_manual_fallback_opens_a_session_flagged_as_weaker_evidence(pool: sqlx::PgPool) {
    // §10: when no punch arrives, the tablet offers "Enter manually".
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    store_db::auth::set_pin(&h.pool, operator, Some("4271"))
        .await
        .unwrap();
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(50), operator).await;

    let session = h
        .post_json(
            TABLET_A,
            "/api/v1/sessions/manual",
            json!({ "emp_code": "E1", "pin": "4271", "tablet_id": TABLET_A }),
        )
        .await;

    assert_eq!(session["state"], "ACTIVE");
    assert_eq!(
        session["manual_identity"], true,
        "manual sessions must be distinguishable in reports"
    );

    let session_id: Uuid = serde_json::from_value(session["session_id"].clone()).unwrap();
    let txn = h
        .post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": 2 }),
        )
        .await;
    assert_eq!(dec_of(&txn["on_hand"]), dec!(48));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_wrong_pin_is_refused_the_same_way_as_an_unknown_code(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    store_db::auth::set_pin(&h.pool, operator, Some("4271"))
        .await
        .unwrap();

    let (wrong_pin, _) = h
        .post_raw(
            TABLET_A,
            "/api/v1/sessions/manual",
            json!({ "emp_code": "E1", "pin": "0000", "tablet_id": TABLET_A }),
        )
        .await;

    let (unknown_code, _) = h
        .post_raw(
            TABLET_A,
            "/api/v1/sessions/manual",
            json!({ "emp_code": "NOBODY", "pin": "4271", "tablet_id": TABLET_A }),
        )
        .await;

    // Identical, so the tablet cannot be used to enumerate employee codes.
    assert_eq!(wrong_pin, 401);
    assert_eq!(unknown_code, 401);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_unauthenticated_request_is_refused(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;

    let (status, _) = h
        .get_raw_unauthenticated("/api/v1/sessions/unclaimed")
        .await;
    assert_eq!(status, 401);

    let (status, _) = h
        .get_raw(TABLET_A, "not-a-real-token", "/api/v1/stock")
        .await;
    assert_eq!(status, 401);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_tablet_cannot_reverse_a_ledger_row(pool: sqlx::PgPool) {
    // §11: reversal is admin only. The terminal in the store must not be able
    // to rewrite history.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    let ledger_id = h.receipt_stock(item, dec!(50), operator).await;

    let (status, _) = h
        .post_raw(
            TABLET_A,
            &format!("/api/v1/txn/{ledger_id}/reverse"),
            json!({}),
        )
        .await;
    assert_eq!(status, 403);
    assert_eq!(h.on_hand(item).await, dec!(50));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_admin_reversal_appends_a_row_rather_than_editing_one(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let admin = h.operator("E9", "9000", "S. Rao", "ADMIN").await;
    store_db::auth::set_pin(&h.pool, admin, Some("1111"))
        .await
        .unwrap();
    let admin_token = h.login("E9", "1111").await;

    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;
    let txn = h
        .post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({ "session_id": session_id, "item_id": item, "qty": 40 }),
        )
        .await;
    let ledger_id = txn["ledger_id"].as_i64().unwrap();
    assert_eq!(h.on_hand(item).await, dec!(60));

    let reversal = h
        .post_json_with_token(
            &admin_token,
            &format!("/api/v1/txn/{ledger_id}/reverse"),
            json!({ "note": "wrong bin" }),
        )
        .await;

    assert_eq!(dec_of(&reversal["on_hand"]), dec!(100));

    // Both halves survive: §7's audit trail keeps the whole story.
    let rows = h
        .get_json(TABLET_A, &format!("/api/v1/ledger?item={item}"))
        .await;
    assert_eq!(rows.as_array().unwrap().len(), 3);
    assert!(store_db::ledger::reconcile(&h.pool)
        .await
        .unwrap()
        .is_empty());
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_offline_outbox_replay_does_not_double_book(pool: sqlx::PgPool) {
    // §12: the tablet queues writes locally and flushes when the LAN returns.
    // A flush interrupted after the server committed but before the ack landed
    // gets replayed.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(100), operator).await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;
    let txn_uuid = Uuid::new_v4();
    let body = json!({
        "session_id": session_id,
        "item_id": item,
        "qty": 7,
        "client_txn_uuid": txn_uuid,
    });

    let first = h
        .post_json(TABLET_A, "/api/v1/txn/issue", body.clone())
        .await;

    // The replay arrives after the session has closed on submit (§10). It must
    // be answered from the ledger, not refused: the tablet is retrying a
    // request the server already committed, and telling it "gone" would have
    // the operator re-enter the issue by hand — a real duplicate, created by
    // the mechanism meant to prevent one.
    let (status, replay) = h.post_raw(TABLET_A, "/api/v1/txn/issue", body).await;

    assert_eq!(
        status, 200,
        "the replay should be answered, not refused: {replay}"
    );
    assert_eq!(
        replay["ledger_id"], first["ledger_id"],
        "the replay should return the row that already exists"
    );
    assert_eq!(
        replay["crossed_threshold"], false,
        "a replay is not a fresh threshold crossing"
    );

    // Either way, exactly one row and one deduction.
    assert_eq!(dec_of(&first["on_hand"]), dec!(93));
    assert_eq!(h.on_hand(item).await, dec!(93));
    let rows = h
        .get_json(
            TABLET_A,
            &format!("/api/v1/ledger?item={item}&txn_type=ISSUE"),
        )
        .await;
    assert_eq!(rows.as_array().unwrap().len(), 1);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn consumption_by_machine_matches_a_hand_computed_fixture(pool: sqlx::PgPool) {
    // The M8 gate.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(1000), operator).await;

    let vmc1 = h.machine("VMC-01").await;
    let vmc2 = h.machine("VMC-02").await;

    // unit_cost on the item fixture is 120.50.
    for (machine, qty) in [
        (Some(vmc1), 10),
        (Some(vmc1), 5),
        (Some(vmc2), 8),
        (None, 2),
    ] {
        let session_id = h.punch_and_claim("1042", TABLET_A).await;
        let mut body = json!({ "session_id": session_id, "item_id": item, "qty": qty });
        if let Some(m) = machine {
            body["machine_id"] = json!(m);
        }
        h.post_json(TABLET_A, "/api/v1/txn/issue", body).await;
    }

    let report = h
        .get_json(TABLET_A, "/api/v1/reports/consumption?group_by=machine")
        .await;
    let rows = report.as_array().unwrap();
    assert_eq!(rows.len(), 3);

    // VMC-01: 15 × 120.50 = 1807.50
    assert_eq!(rows[0]["bucket_label"], "VMC-01");
    assert_eq!(dec_of(&rows[0]["qty"]), dec!(15));
    assert_eq!(dec_of(&rows[0]["value"]), dec!(1807.50));
    assert_eq!(rows[0]["txn_count"], 2);

    // VMC-02: 8 × 120.50 = 964.00
    assert_eq!(rows[1]["bucket_label"], "VMC-02");
    assert_eq!(dec_of(&rows[1]["value"]), dec!(964));

    // §12.6: machine is optional, with a Skip button. Skipped issues still
    // count — they just land in their own bucket.
    assert_eq!(rows[2]["bucket_label"], "(no machine recorded)");
    assert_eq!(dec_of(&rows[2]["qty"]), dec!(2));

    // And the CSV says the same thing.
    let csv = h
        .get_text(TABLET_A, "/api/v1/reports/consumption.csv?group_by=machine")
        .await;
    assert!(csv.starts_with("machine,qty,value,txn_count\n"));
    assert!(csv.contains("\"VMC-01\",15.000,1807.50,2"));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn search_finds_items_by_code_description_iso_and_grade(pool: sqlx::PgPool) {
    // §12.4: a permanent "Search instead" button, for when the barcode is worn
    // off or the box is upside down.
    let h = Harness::start(pool).await;
    h.item_full(
        "CNMG120408-TN2000",
        "CNMG 120408 turning insert",
        Some("CNMG120408"),
        Some("TN2000"),
    )
    .await;
    h.item_full("EM-06-4F", "6mm 4-flute carbide end mill", None, None)
        .await;

    for (query, expected) in [
        ("cnmg", "CNMG120408-TN2000"),
        ("turning", "CNMG120408-TN2000"),
        ("tn2000", "CNMG120408-TN2000"),
        ("end%20mill", "EM-06-4F"),
        ("EM-06", "EM-06-4F"),
    ] {
        let results = h
            .get_json(TABLET_A, &format!("/api/v1/items/search?q={query}"))
            .await;
        let results = results.as_array().unwrap();
        assert!(!results.is_empty(), "no results for {query:?}");
        assert_eq!(results[0]["item_code"], expected, "for query {query:?}");
    }
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_vendor_barcode_resolves_to_our_item(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let admin = h.operator("E9", "9000", "S. Rao", "ADMIN").await;
    store_db::auth::set_pin(&h.pool, admin, Some("1111"))
        .await
        .unwrap();
    let token = h.login("E9", "1111").await;

    let item = h.item("ITEM-1", dec!(0)).await;
    h.post_json_with_token(
        &token,
        &format!("/api/v1/admin/items/{item}/barcodes"),
        json!({ "code": "8901234567890", "kind": "MFR_EAN" }),
    )
    .await;

    let found = h
        .get_json(TABLET_A, "/api/v1/items/lookup?barcode=8901234567890")
        .await;
    assert_eq!(found["item_code"], "ITEM-1");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_unknown_barcode_is_a_404_not_a_crash(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (status, body) = h
        .get_raw(
            TABLET_A,
            &h.tablet_token,
            "/api/v1/items/lookup?barcode=NOPE",
        )
        .await;
    assert_eq!(status, 404);
    assert!(
        body.contains("NOPE"),
        "the message should name the barcode: {body}"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn working_on_the_tablet_keeps_the_session_alive(pool: sqlx::PgPool) {
    // §10 measures the idle timeout from last_activity_at, "not opened_at".
    // Nothing ever moved that column, so a 180 s idle limit behaved as a 180 s
    // deadline on the whole transaction: an operator scrolling the catalog and
    // keying a quantity was working, and the server closed the session anyway.
    let h = Harness::start(pool).await;
    h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;
    h.age_activity(session_id, IDLE_TIMEOUT_SECS + 1).await;

    // The operator is still standing there, working the screens.
    let touched = h
        .post_json(
            TABLET_A,
            &format!("/api/v1/sessions/{session_id}/touch"),
            json!({}),
        )
        .await;
    assert_eq!(touched["state"], "ACTIVE");

    let reaped = store_db::sessions::reap(&h.pool).await.unwrap();
    assert!(
        !reaped.idle_closed.contains(&session_id),
        "a session being worked on must not be reaped: {reaped:?}"
    );

    let session = store_db::sessions::get(&h.pool, session_id).await.unwrap();
    assert_eq!(session.state.as_str(), "ACTIVE");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn another_tablet_cannot_hold_my_session_open(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;

    let (status, body) = h
        .post_raw(
            TABLET_B,
            &format!("/api/v1/sessions/{session_id}/touch"),
            json!({}),
        )
        .await;
    assert_eq!(status, 409, "{body}");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn one_item_for_several_machines_writes_a_row_each(pool: sqlx::PgPool) {
    // §11: one trip to the crib, one confirm, but consumption stays
    // attributable — five inserts tagged with three machines could not tell you
    // which machine ate them.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("CNMG120408", dec!(2)).await;
    h.receipt_stock(item, dec!(20), operator).await;

    let hmc = h.machine("HMC-01").await;
    let vmc = h.machine("VMC-01").await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;

    let txn = h
        .post_json(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({
                "session_id": session_id,
                "item_id": item,
                "qty": 0,
                "splits": [
                    { "machine_id": hmc, "qty": 2 },
                    { "machine_id": vmc, "qty": 3 },
                ],
            }),
        )
        .await;

    // One confirm, two rows, and the balance is the one the bin actually holds.
    assert_eq!(txn["ledger_ids"].as_array().unwrap().len(), 2);
    assert_eq!(dec_of(&txn["delta_qty"]), dec!(-5));
    assert_eq!(dec_of(&txn["on_hand"]), dec!(15));
    assert_eq!(h.on_hand(item).await, dec!(15));

    // Each row names its own machine.
    let rows = sqlx::query!(
        "select machine_id, delta_qty from stock_ledger
          where session_id = $1 order by id",
        session_id
    )
    .fetch_all(&h.pool)
    .await
    .unwrap();

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].machine_id, Some(hmc));
    assert_eq!(rows[0].delta_qty, dec!(-2));
    assert_eq!(rows[1].machine_id, Some(vmc));
    assert_eq!(rows[1].delta_qty, dec!(-3));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_split_that_overdraws_the_bin_writes_nothing(pool: sqlx::PgPool) {
    // The §7 guard applies to the set, not to each row in turn. Serving the
    // first two machines and refusing the third would leave the operator told
    // "refused" while part of their trip sat in the ledger.
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;
    let item = h.item("ITEM-1", dec!(0)).await;
    h.receipt_stock(item, dec!(4), operator).await;

    let hmc = h.machine("HMC-01").await;
    let vmc = h.machine("VMC-01").await;

    let session_id = h.punch_and_claim("1042", TABLET_A).await;

    let (status, body) = h
        .post_raw(
            TABLET_A,
            "/api/v1/txn/issue",
            json!({
                "session_id": session_id,
                "item_id": item,
                "qty": 0,
                "splits": [
                    { "machine_id": hmc, "qty": 3 },
                    { "machine_id": vmc, "qty": 3 },
                ],
            }),
        )
        .await;

    assert_eq!(status, 409, "{body}");

    // Not 1 (the first split), not -2: nothing was written at all.
    assert_eq!(h.on_hand(item).await, dec!(4));
    let written = sqlx::query_scalar!(
        "select count(*) from stock_ledger where session_id = $1",
        session_id
    )
    .fetch_one(&h.pool)
    .await
    .unwrap();
    assert_eq!(written, Some(0));
}
