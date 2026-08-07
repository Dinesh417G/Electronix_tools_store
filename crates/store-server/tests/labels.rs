//! The M7 acceptance gate, end to end through the API (CLAUDE.md §13).
//!
//! > Create item → print label → scan that printed label on the tablet →
//! > correct item resolves.
//!
//! `store-label`'s own tests prove the encoder and the sheet layout. This file
//! proves the *loop*: an item created through `POST /admin/items`, a label
//! fetched from `POST /admin/labels/print`, that label rastered and decoded, and
//! the decoded string fed to `GET /items/lookup` — the same endpoint the
//! terminal calls when an operator scans a bin.
//!
//! The optical half — toner, focus, coolant on the label — still needs a real
//! printer and a real scan. Everything short of the photons is here.

mod harness;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use harness::{Harness, TABLET_A};
use http_body_util::BodyExt;
use rust_decimal_macros::dec;
use serde_json::json;
use store_label::scan::scan_single_label;
use tower::ServiceExt;
use uuid::Uuid;

/// Sign in as a seeded admin and return their bearer token.
async fn admin_token(h: &Harness) -> String {
    let admin = h.operator("E9001", "9001", "S. Rao", "ADMIN").await;
    store_db::auth::set_pin(&h.pool, admin, Some("1111"))
        .await
        .unwrap();
    h.login("E9001", "1111").await
}

/// Fetch a label PDF for the given items.
async fn print_labels(h: &Harness, token: &str, item_ids: &[Uuid]) -> (StatusCode, Vec<u8>) {
    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/labels/print")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "item_ids": item_ids }).to_string()))
                .unwrap(),
        )
        .await
        .expect("router responded");

    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, bytes.to_vec())
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_m7_gate_create_item_print_label_scan_it_back(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let token = admin_token(&h).await;

    // 1. Create an item through the admin API, exactly as the console does.
    let created = h
        .post_json_with_token(
            &token,
            "/api/v1/admin/items",
            json!({
                "item_code": "VBMT160404-TT8020",
                "description": "VBMT 160404 finishing insert",
                "uom": "NOS",
                "iso_code": "VBMT160404",
                "grade": "TT8020",
                "reorder_level": "10",
                "bin_location": "A-02-3",
                "unit_cost": "98.25",
                "allow_negative": false
            }),
        )
        .await;

    let item_id: Uuid = serde_json::from_value(created["id"].clone()).expect("id");
    assert_eq!(created["item_code"], "VBMT160404-TT8020");

    // 2. Print its label.
    let (status, pdf) = print_labels(&h, &token, &[item_id]).await;
    assert_eq!(status, StatusCode::OK);
    assert!(pdf.starts_with(b"%PDF"), "not a PDF");

    // 3. Scan the printed label — raster a scan line across the bars and decode
    //    it the way a reader would.
    let scanned = scan_single_label(&pdf, 600.0).expect("the printed label did not decode");
    assert_eq!(scanned, "VBMT160404-TT8020");

    // 4. Resolve it through the endpoint the terminal actually calls on a scan.
    let resolved = h
        .get_json(
            TABLET_A,
            &format!("/api/v1/items/lookup?barcode={}", urlencode(&scanned)),
        )
        .await;

    assert_eq!(resolved["id"], json!(item_id), "the wrong item resolved");
    assert_eq!(resolved["description"], "VBMT 160404 finishing insert");
    assert_eq!(resolved["bin_location"], "A-02-3");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn every_seeded_item_prints_a_label_that_scans_back_to_itself(pool: sqlx::PgPool) {
    // One item proves the path; a catalog proves the path is not accidentally
    // right for one shape of code.
    let h = Harness::start(pool).await;
    let token = admin_token(&h).await;

    let codes = [
        "CNMG120408-TN2000",
        "DNMG150608-TT5100",
        "EM-06-4F-TIALN",
        "DR-8.5-HSS",
        "TAP-M10-HSS",
        "COOL-SYN-20L",
        "8901234567890",
    ];

    for code in codes {
        let item_id = h.item(code, dec!(0)).await;
        let (status, pdf) = print_labels(&h, &token, &[item_id]).await;
        assert_eq!(status, StatusCode::OK, "printing {code}");

        let scanned = scan_single_label(&pdf, 600.0)
            .unwrap_or_else(|e| panic!("{code} did not decode: {e}"));
        assert_eq!(scanned, code);

        let resolved = h
            .get_json(
                TABLET_A,
                &format!("/api/v1/items/lookup?barcode={}", urlencode(&scanned)),
            )
            .await;
        assert_eq!(resolved["id"], json!(item_id), "{code} resolved wrongly");
    }
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_tablet_cannot_print_labels_or_touch_the_catalog(pool: sqlx::PgPool) {
    // §11: a tablet is not an operator. The terminal in the store must not be
    // able to rewrite the catalog or spend a roll of label stock.
    let h = Harness::start(pool).await;
    let item_id = h.item("ITEM-1", dec!(0)).await;

    let (status, _) = print_labels(&h, &h.tablet_token, &[item_id]).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = h
        .post_raw(
            TABLET_A,
            "/api/v1/admin/items",
            json!({
                "item_code": "SNEAKY-1",
                "description": "should not exist",
                "uom": "NOS",
                "reorder_level": "0",
                "allow_negative": false
            }),
        )
        .await;
    assert_eq!(status, 403);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn an_empty_or_oversized_batch_is_refused(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let token = admin_token(&h).await;

    let (status, _) = print_labels(&h, &token, &[]).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "an empty batch");

    // 501 labels is 21 sheets. Nobody means to do that by accident.
    let many: Vec<Uuid> = (0..501).map(|_| Uuid::new_v4()).collect();
    let (status, _) = print_labels(&h, &token, &many).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "an oversized batch");
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn printing_an_unknown_item_is_a_404_not_a_blank_sheet(pool: sqlx::PgPool) {
    // A blank label gets stuck on a bin. A 404 gets noticed.
    let h = Harness::start(pool).await;
    let token = admin_token(&h).await;

    let (status, _) = print_labels(&h, &token, &[Uuid::new_v4()]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_batch_is_returned_as_a_downloadable_pdf(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let token = admin_token(&h).await;
    let item_id = h.item("ITEM-1", dec!(0)).await;

    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/admin/labels/print")
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "item_ids": [item_id] }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("application/pdf")
    );
    assert!(
        response
            .headers()
            .get("content-disposition")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .contains("bin-labels.pdf"),
        "the browser should be offered a filename"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_retired_item_keeps_its_ledger_history(pool: sqlx::PgPool) {
    // §7: retiring is not deleting. Deleting would orphan history, which is the
    // one thing the ledger exists to prevent.
    let h = Harness::start(pool).await;
    let token = admin_token(&h).await;
    let operator = h.operator("E1", "1042", "R. Kumar", "OPERATOR").await;

    let item_id = h.item("RETIRE-1", dec!(0)).await;
    h.receipt_stock(item_id, dec!(50), operator).await;

    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/admin/items/{item_id}"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // The ledger row is still there, and still reconciles.
    let rows = h
        .get_json(TABLET_A, &format!("/api/v1/ledger?item={item_id}"))
        .await;
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert!(store_db::ledger::reconcile(&h.pool)
        .await
        .unwrap()
        .is_empty());
}

/// Percent-encode a barcode for a query string.
///
/// Item codes contain characters like `+` and `/` that would otherwise be
/// reinterpreted, and a lookup that silently searches for the wrong string is
/// exactly the bug this whole file exists to rule out.
fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(b).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}
