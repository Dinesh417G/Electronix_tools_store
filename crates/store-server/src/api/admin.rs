//! Admin endpoints and tablet enrolment (CLAUDE.md §11).

use axum::extract::{Path, State};
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct RegisterTabletRequest {
    pub tablet_id: String,
    #[serde(default)]
    pub name: Option<String>,
    /// The shared enrolment secret, configured on the server and typed once on
    /// each tablet during setup.
    pub enrolment_secret: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterTabletResponse {
    pub tablet_id: String,
    pub token: String,
}

/// `POST /api/v1/auth/tablet`
///
/// The one unauthenticated endpoint, gated by a shared secret. Re-registering
/// revokes the previous token, so a reflashed tablet recovers on its own.
pub async fn register_tablet(
    State(state): State<AppState>,
    Json(body): Json<RegisterTabletRequest>,
) -> ApiResult<Json<RegisterTabletResponse>> {
    let expected = crate::config::enrolment_secret();

    // Constant-time-ish comparison. The secret is long and the LAN is trusted,
    // but leaking it a character at a time through timing is free to avoid.
    if !constant_time_eq(body.enrolment_secret.as_bytes(), expected.as_bytes()) {
        tracing::warn!(tablet_id = %body.tablet_id, "tablet enrolment refused");
        return Err(ApiError::Unauthorized);
    }

    let issued =
        store_db::auth::register_tablet(&state.pool, &body.tablet_id, body.name.as_deref())
            .await?;

    tracing::info!(tablet_id = %body.tablet_id, "tablet registered");

    Ok(Json(RegisterTabletResponse {
        tablet_id: body.tablet_id,
        token: issued.token,
    }))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Deserialize)]
pub struct OperatorLoginRequest {
    pub emp_code: String,
    pub pin: String,
}

#[derive(Debug, Serialize)]
pub struct OperatorLoginResponse {
    pub token: String,
    pub operator_id: Uuid,
    pub full_name: String,
    pub role: String,
}

/// `POST /api/v1/auth/operator` — the admin app's login.
pub async fn operator_login(
    State(state): State<AppState>,
    Json(body): Json<OperatorLoginRequest>,
) -> ApiResult<Json<OperatorLoginResponse>> {
    let operator = store_db::auth::verify_operator_pin(&state.pool, &body.emp_code, &body.pin)
        .await?
        .ok_or(ApiError::Unauthorized)?;

    let issued = store_db::auth::issue_operator_token(&state.pool, operator.id).await?;

    Ok(Json(OperatorLoginResponse {
        token: issued.token,
        operator_id: operator.id,
        full_name: operator.full_name,
        role: operator.role,
    }))
}

/// `POST /api/v1/admin/items`
pub async fn create_item(
    State(state): State<AppState>,
    auth: Auth,
    Json(input): Json<store_db::items::ItemInput>,
) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;
    let id = store_db::items::create(&state.pool, &input).await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(store_db::items::get(&state.pool, id).await?),
    ))
}

/// `PUT /api/v1/admin/items/{id}`
pub async fn update_item(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    Json(input): Json<store_db::items::ItemInput>,
) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;
    store_db::items::update(&state.pool, id, &input).await?;
    Ok(Json(store_db::items::get(&state.pool, id).await?))
}

/// `DELETE /api/v1/admin/items/{id}` — deactivates rather than deletes.
///
/// Deleting would orphan ledger history, and §7's whole point is that history
/// survives.
pub async fn deactivate_item(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;
    store_db::items::deactivate(&state.pool, id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct AddBarcodeRequest {
    pub code: String,
    #[serde(default)]
    pub kind: Option<String>,
}

/// `POST /api/v1/admin/items/{id}/barcodes`
pub async fn add_barcode(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    Json(body): Json<AddBarcodeRequest>,
) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;

    let kind = match body.kind.as_deref().unwrap_or("VENDOR") {
        "OWN" => store_core::BarcodeKind::Own,
        "MFR_EAN" => store_core::BarcodeKind::MfrEan,
        "VENDOR" => store_core::BarcodeKind::Vendor,
        other => {
            return Err(ApiError::BadRequest(format!(
                "unknown barcode kind {other:?}"
            )))
        }
    };

    let barcode_id = store_db::items::add_barcode(&state.pool, id, &body.code, kind).await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(serde_json::json!({ "id": barcode_id })),
    ))
}

#[derive(Debug, Deserialize)]
pub struct LabelBatchRequest {
    /// Items to print. Order is preserved, so a storekeeper can lay a sheet out
    /// rack by rack.
    pub item_ids: Vec<Uuid>,
    /// Copies of each label. Useful when one item lives in two bins.
    #[serde(default)]
    pub copies: Option<usize>,
}

/// `POST /api/v1/admin/labels/print` — Code128 label batch → PDF (§11).
///
/// The barcode payload is `items.item_code`, which is what
/// `GET /api/v1/items/lookup` resolves — so a label printed here scans back to
/// the item it was printed for. That round trip is the M7 gate.
pub async fn print_labels(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<LabelBatchRequest>,
) -> ApiResult<impl IntoResponse> {
    auth.require_storekeeper()?;

    if body.item_ids.is_empty() {
        return Err(ApiError::BadRequest(
            "Select at least one item to print.".into(),
        ));
    }

    // A batch big enough to be a mistake usually is one — 500 labels is 21
    // sheets, and nobody means to do that by accident.
    const MAX_LABELS: usize = 500;
    let copies = body.copies.unwrap_or(1).clamp(1, 20);
    if body.item_ids.len() * copies > MAX_LABELS {
        return Err(ApiError::BadRequest(format!(
            "That is {} labels. Print at most {MAX_LABELS} at a time.",
            body.item_ids.len() * copies
        )));
    }

    let items = store_db::items::for_label_batch(&state.pool, &body.item_ids).await?;
    if items.is_empty() {
        return Err(ApiError::NotFound("items".into()));
    }

    let specs: Vec<store_label::LabelSpec> = items
        .iter()
        .flat_map(|item| {
            let spec = store_label::LabelSpec {
                item_code: item.item_code.clone(),
                description: item.description.clone(),
                bin_location: item.bin_location.clone(),
                // The grade and ISO code are what tell two visually identical
                // insert boxes apart on a rack.
                detail: match (&item.iso_code, &item.grade) {
                    (Some(iso), Some(grade)) => Some(format!("{iso} · {grade}")),
                    (Some(iso), None) => Some(iso.clone()),
                    (None, Some(grade)) => Some(grade.clone()),
                    (None, None) => item.manufacturer.clone(),
                },
            };
            std::iter::repeat_n(spec, copies)
        })
        .collect();

    let pdf = store_label::render_sheet(&specs, &store_label::SheetLayout::default())
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    tracing::info!(labels = specs.len(), "printed label batch");

    Ok((
        [
            (
                axum::http::header::CONTENT_TYPE,
                "application/pdf".to_owned(),
            ),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=\"bin-labels.pdf\"".to_owned(),
            ),
        ],
        pdf,
    ))
}

/// `GET /api/v1/admin/categories`
pub async fn categories(
    State(state): State<AppState>,
    _auth: Auth,
) -> ApiResult<impl IntoResponse> {
    let rows = sqlx::query!(
        "select id, name, sort_order from item_categories order by sort_order, name"
    )
    .fetch_all(&state.pool)
    .await
    .map_err(store_db::DbError::from)?;

    let json: Vec<_> = rows
        .into_iter()
        .map(|r| serde_json::json!({ "id": r.id, "name": r.name, "sort_order": r.sort_order }))
        .collect();

    Ok(Json(json))
}

/// `GET /api/v1/admin/operators`
pub async fn list_operators(
    State(state): State<AppState>,
    auth: Auth,
) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;
    Ok(Json(store_db::operators::list(&state.pool, true).await?))
}

#[derive(Debug, Deserialize)]
pub struct CreateOperatorRequest {
    #[serde(flatten)]
    pub operator: store_db::operators::OperatorInput,
    /// Optional PIN for the manual fallback path (§8).
    #[serde(default)]
    pub pin: Option<String>,
}

/// `POST /api/v1/admin/operators`
pub async fn create_operator(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<CreateOperatorRequest>,
) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;

    if !matches!(
        body.operator.role.as_str(),
        "OPERATOR" | "STOREKEEPER" | "ADMIN"
    ) {
        return Err(ApiError::BadRequest(format!(
            "unknown role {:?}",
            body.operator.role
        )));
    }

    let pin_hash = body
        .pin
        .as_deref()
        .map(store_db::auth::hash_pin)
        .transpose()?;

    let id =
        store_db::operators::create(&state.pool, &body.operator, pin_hash.as_deref()).await?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(store_db::operators::get(&state.pool, id).await?),
    ))
}

/// `GET /api/v1/admin/devices` — including the unknown-user notices (§9.4).
pub async fn devices(
    State(state): State<AppState>,
    auth: Auth,
) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;

    Ok(Json(serde_json::json!({
        "devices": store_db::punches::device_health(&state.pool).await?,
        "unknown_users": store_db::punches::unknown_user_punches(&state.pool, 50).await?,
        "recent_punches": store_db::punches::recent(&state.pool, 25).await?,
    })))
}

/// `GET /api/v1/admin/health`
///
/// §11 asks for DB, device last-seen and ledger reconciliation status. The
/// reconciliation line is the one that matters: §7 says any drift is a bug, so
/// this is where it becomes visible rather than being discovered six months
/// later by someone counting a bin.
pub async fn health(State(state): State<AppState>, auth: Auth) -> ApiResult<impl IntoResponse> {
    auth.require_admin()?;

    let drift = store_db::ledger::reconcile(&state.pool).await?;
    let devices = store_db::punches::device_health(&state.pool).await?;
    let alerts = store_db::alerts::summary(&state.pool).await?;

    Ok(Json(serde_json::json!({
        "database": "up",
        "ledger_reconciled": drift.is_empty(),
        "drift": drift,
        "devices": devices,
        "alerts": alerts,
        "sse_subscribers": state.bus.subscriber_count(),
    })))
}

/// `GET /health` — unauthenticated liveness, for a process supervisor.
pub async fn liveness(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i32>("select 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => (axum::http::StatusCode::OK, "ok"),
        Err(_) => (axum::http::StatusCode::SERVICE_UNAVAILABLE, "database down"),
    }
}
