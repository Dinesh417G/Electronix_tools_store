//! The REST surface (CLAUDE.md §11).

pub mod admin;
pub mod catalog;
pub mod sessions;
pub mod txn;

use axum::routing::{delete, get, post, put};
use axum::Router;

use crate::state::AppState;

/// Everything under `/api/v1`, plus unauthenticated liveness.
///
/// Auth is applied per-handler through the `Auth` extractor rather than as
/// blanket middleware, so a handler that writes to the ledger cannot compile
/// without naming who is doing it (§11: there are no anonymous ledger rows).
pub fn router(state: AppState) -> Router {
    let v1 = Router::new()
        // auth
        .route("/auth/tablet", post(admin::register_tablet))
        .route("/auth/operator", post(admin::operator_login))
        // sessions
        .route("/sessions/stream", get(sessions::stream))
        .route("/sessions/unclaimed", get(sessions::unclaimed))
        .route("/sessions/manual", post(sessions::manual))
        .route("/sessions/{id}", get(sessions::get))
        .route("/sessions/{id}/claim", post(sessions::claim))
        .route("/sessions/{id}/touch", post(sessions::touch))
        .route("/sessions/{id}/close", post(sessions::close))
        // catalog
        .route("/items/lookup", get(catalog::lookup))
        .route("/items/search", get(catalog::search))
        .route("/items/{id}", get(catalog::get_item))
        .route("/machines", get(catalog::machines))
        .route("/reason-codes", get(catalog::reason_codes))
        // transactions
        .route("/txn/issue", post(txn::issue))
        .route("/txn/receipt", post(txn::receipt))
        .route("/txn/{id}/reverse", post(txn::reverse))
        // stock, history, alerts, reports
        .route("/stock", get(catalog::stock))
        .route("/ledger", get(catalog::ledger))
        .route("/alerts", get(catalog::alerts))
        .route("/alerts/summary", get(catalog::alert_summary))
        .route("/alerts/{id}/ack", post(catalog::ack_alert))
        .route("/reports/consumption", get(catalog::consumption))
        .route("/reports/consumption.csv", get(catalog::consumption_csv))
        // admin
        .route("/admin/items", post(admin::create_item))
        .route("/admin/items/{id}", put(admin::update_item))
        .route("/admin/items/{id}", delete(admin::deactivate_item))
        .route("/admin/items/{id}/barcodes", post(admin::add_barcode))
        .route("/admin/categories", get(admin::categories))
        .route("/admin/labels/print", post(admin::print_labels))
        .route("/admin/operators", get(admin::list_operators))
        .route("/admin/operators", post(admin::create_operator))
        .route("/admin/devices", get(admin::devices))
        .route("/admin/health", get(admin::health));

    Router::new()
        .nest("/api/v1", v1)
        .route("/health", get(admin::liveness))
        .with_state(state)
}
