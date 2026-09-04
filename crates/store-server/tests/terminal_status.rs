//! §3's optional door reader, and the window the idle screen counts in.
//!
//! §3 used to say "1× ZKTeco access terminal" and the terminal read that as a
//! promise: it told every operator to put a finger on a reader whether or not
//! one existed. A crib that wants the tablet and nothing else is a real
//! customer, and telling them to use hardware they never bought is the worst
//! kind of wrong — confident, and about the one action the screen exists to
//! prompt.
//!
//! The distinction this gates is `installed` (**ever**) against `online`
//! (**lately**). Flattening them turns a reader that is down for an hour into a
//! crib that never had one, and the two need opposite remedies: one is a fault
//! to go and fix, the other is a configuration to word the screen around.
//!
//! The equivalent gate in `cloud/` (`tests/terminal-flow.mjs`) can only ever
//! run one branch per pass, because `e2e.mjs` performs an ADMS handshake first
//! and CI therefore always has a device by the time the terminal is driven.
//! Here all three run in one test against a database owned by the test.

mod harness;

use chrono::{Duration, Utc};
use harness::{Harness, TABLET_A};
use rust_decimal_macros::dec;

/// The tablet always sends its own local midnight (§12.1).
fn since_now() -> String {
    urlencoding(&Utc::now().date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc().to_rfc3339())
}

fn urlencoding(raw: &str) -> String {
    raw.replace('+', "%2B").replace(':', "%3A")
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_crib_with_no_reader_is_never_told_it_has_one(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;

    let body = h
        .get_json(TABLET_A, &format!("/api/v1/terminal/status?since={}", since_now()))
        .await;

    // Nothing has ever checked in. Not "offline" — never installed.
    assert_eq!(body["reader"]["installed"], false);
    assert_eq!(body["reader"]["online"], false);
    assert!(body["reader"]["last_seen_at"].is_null());
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_reader_that_has_checked_in_is_installed_and_online(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;

    // The real handshake, not a fixture row: §9's `GET /iclock/cdata` is what
    // a terminal does on boot, and registering the device is a side effect of
    // it that the idle screen now depends on.
    let hs = h.get_text(TABLET_A, "/iclock/cdata?SN=ZK-DOOR-1&options=all").await;
    assert!(hs.starts_with("GET OPTION FROM:"), "handshake: {hs}");

    let body = h
        .get_json(TABLET_A, &format!("/api/v1/terminal/status?since={}", since_now()))
        .await;

    assert_eq!(body["reader"]["installed"], true);
    assert_eq!(body["reader"]["online"], true);
    assert!(body["reader"]["last_seen_at"].is_string());
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_reader_gone_quiet_is_still_installed(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    h.get_text(TABLET_A, "/iclock/cdata?SN=ZK-DOOR-1&options=all").await;

    // Ninety minutes of silence. An installed reader that has stopped talking
    // is a fault to go and fix; it is not a crib that never had one, and the
    // screen must not offer the reader-less wording to somebody standing in
    // front of hardware that exists.
    sqlx::query!("update devices set last_seen_at = now() - interval '90 minutes'")
        .execute(&h.pool)
        .await
        .expect("age the device");

    let body = h
        .get_json(TABLET_A, &format!("/api/v1/terminal/status?since={}", since_now()))
        .await;

    assert_eq!(
        body["reader"]["installed"], true,
        "a quiet reader was reported as no reader at all"
    );
    assert_eq!(body["reader"]["online"], false);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn today_counts_trips_each_way_and_never_sums_across_units(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "zk-1", "R. Kumar", "OPERATOR").await;

    // §6: one is measured in NOS, the other in LTR. Adding twenty litres of
    // coolant to three carbide inserts gives a number with no unit, which is
    // what the first version of this strip displayed.
    let inserts = h.item("CNMG120408", dec!(2)).await;
    let coolant = h.item("COOL-SYN-20L", dec!(1)).await;
    h.receipt_stock(inserts, dec!(50), operator).await;
    h.receipt_stock(coolant, dec!(20), operator).await;

    let body = h
        .get_json(TABLET_A, &format!("/api/v1/terminal/status?since={}", since_now()))
        .await;

    assert_eq!(body["today"]["movements"], 2, "two trips to the crib");
    assert_eq!(body["today"]["in_count"], 2);
    assert_eq!(body["today"]["out_count"], 0);
    assert!(body["today"]["last_at"].is_string());

    // The list is scoped to the same window as the counts above it. A panel
    // headed TODAY listing rows its own count excludes teaches the reader to
    // distrust every number on the screen.
    let recent = body["recent"].as_array().expect("recent is a list");
    assert_eq!(recent.len(), 2);
    assert!(recent.iter().any(|r| r["item_code"] == "COOL-SYN-20L"));
    assert_eq!(recent[0]["operator_name"], "R. Kumar");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_implausible_day_falls_back_rather_than_emptying_the_screen(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let operator = h.operator("E1", "zk-1", "R. Kumar", "OPERATOR").await;
    let item = h.item("CNMG120408", dec!(2)).await;
    h.receipt_stock(item, dec!(50), operator).await;

    // A tablet whose clock is ahead asks about a day that has not started.
    // Answering it literally blanks the strip on a crib that has been working
    // all morning, so the window falls back to the last 24 hours.
    let ahead = urlencoding(&(Utc::now() + Duration::days(2)).to_rfc3339());
    let body = h
        .get_json(TABLET_A, &format!("/api/v1/terminal/status?since={ahead}"))
        .await;
    assert_eq!(body["today"]["movements"], 1, "a fast clock emptied the strip");

    // And one whose clock is behind by a week does not get a week-long scan:
    // the window is client-supplied, so it is clamped at both ends.
    //
    // Proved against a row that only an unclamped window could reach. Asserting
    // the count alone would pass on a build with no clamp at all, because
    // everything else here was written seconds ago — which is how an assertion
    // comes to pin nothing.
    sqlx::query!(
        r#"
        insert into stock_ledger (item_id, delta_qty, txn_type, operator_id, created_at)
        values ($1, 5, 'OPENING', $2, now() - interval '3 days')
        "#,
        item,
        operator
    )
    .execute(&h.pool)
    .await
    .expect("book a movement three days ago");

    let behind = urlencoding(&(Utc::now() - Duration::days(7)).to_rfc3339());
    let body = h
        .get_json(TABLET_A, &format!("/api/v1/terminal/status?since={behind}"))
        .await;
    assert_eq!(
        body["today"]["movements"], 1,
        "a slow clock widened TODAY to a week"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_tablet_may_ask_without_being_an_operator(pool: sqlx::PgPool) {
    // The whole point: §11 gives a tablet a device token and deliberately no
    // operator identity, and this is the question it must answer before it can
    // word its own idle screen. `/admin/devices` carries the same facts behind
    // an ADMIN check the terminal can never pass.
    let h = Harness::start(pool).await;

    let (status, _) = h
        .get_raw(TABLET_A, "", "/api/v1/terminal/status")
        .await;
    assert_eq!(status, 401, "the endpoint answered an unauthenticated caller");
}
