//! Item lookup, search, stock views, ledger history, alerts and reports.

use axum::extract::{Path, Query, State};
use axum::response::IntoResponse;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct LookupQuery {
    pub barcode: String,
}

/// `GET /api/v1/items/lookup?barcode=`
///
/// §11 budgets under 100 ms for this: it is the first thing that happens after
/// an operator scans, and it is the difference between the tablet feeling
/// instant and feeling broken. One indexed query, reading the cached balance.
pub async fn lookup(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<LookupQuery>,
) -> ApiResult<impl IntoResponse> {
    let item = store_db::items::lookup_by_barcode(&state.pool, &q.barcode)
        .await?
        .ok_or_else(|| {
            // An unknown barcode is an ordinary shop-floor event, not a fault.
            ApiError::NotFound(format!("No item with barcode {}", q.barcode.trim()))
        })?;

    Ok(Json(item))
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    #[serde(default)]
    pub limit: Option<i64>,
}

/// `GET /api/v1/items/search?q=` — the "Search instead" path (§12.4).
pub async fn search(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<SearchQuery>,
) -> ApiResult<impl IntoResponse> {
    let items = store_db::items::search(&state.pool, &q.q, q.limit.unwrap_or(25)).await?;
    Ok(Json(items))
}

/// `GET /api/v1/items/{id}`
pub async fn get_item(
    State(state): State<AppState>,
    _auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(store_db::items::get(&state.pool, id).await?))
}

#[derive(Debug, Default, Deserialize)]
pub struct StockQuery {
    #[serde(default)]
    pub low: bool,
    #[serde(default)]
    pub empty: bool,
    #[serde(default)]
    pub category: Option<Uuid>,
    #[serde(default)]
    pub bin: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

/// `GET /api/v1/stock`
pub async fn stock(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<StockQuery>,
) -> ApiResult<impl IntoResponse> {
    let rows = store_db::items::stock(
        &state.pool,
        &store_db::items::StockFilter {
            low: q.low,
            empty: q.empty,
            category_id: q.category,
            bin_location: q.bin,
            limit: q.limit.unwrap_or(200),
            offset: q.offset.unwrap_or(0),
        },
    )
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Default, Deserialize)]
pub struct LedgerQuery {
    #[serde(default)]
    pub item: Option<Uuid>,
    #[serde(default)]
    pub operator: Option<Uuid>,
    #[serde(default)]
    pub machine: Option<Uuid>,
    #[serde(default)]
    pub txn_type: Option<String>,
    #[serde(default)]
    pub from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub to: Option<DateTime<Utc>>,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
}

/// `GET /api/v1/ledger`
pub async fn ledger(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<LedgerQuery>,
) -> ApiResult<impl IntoResponse> {
    let txn_type = q
        .txn_type
        .as_deref()
        .map(str::parse::<store_core::TxnType>)
        .transpose()?;

    let rows = store_db::ledger::list(
        &state.pool,
        &store_db::ledger::LedgerFilter {
            item_id: q.item,
            operator_id: q.operator,
            machine_id: q.machine,
            txn_type,
            from: q.from,
            to: q.to,
            limit: q.limit.unwrap_or(100),
            offset: q.offset.unwrap_or(0),
        },
    )
    .await?;

    Ok(Json(rows))
}

#[derive(Debug, Default, Deserialize)]
pub struct AlertsQuery {
    #[serde(default)]
    pub include_acknowledged: bool,
}

/// `GET /api/v1/alerts`
pub async fn alerts(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<AlertsQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        store_db::alerts::list_open(&state.pool, q.include_acknowledged).await?,
    ))
}

/// `GET /api/v1/alerts/summary` — the tablet's idle banner (§12.1).
pub async fn alert_summary(
    State(state): State<AppState>,
    _auth: Auth,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(store_db::alerts::summary(&state.pool).await?))
}

/// `POST /api/v1/alerts/{id}/ack`
///
/// Acknowledging is not fixing: the row stays open until stock actually
/// arrives, so the dashboard keeps showing the shortage.
pub async fn ack_alert(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<impl IntoResponse> {
    let operator_id = auth.require_storekeeper()?;
    store_db::alerts::acknowledge(&state.pool, id, operator_id).await?;
    Ok(axum::http::StatusCode::NO_CONTENT)
}

#[derive(Debug, Default, Deserialize)]
pub struct ConsumptionQuery {
    #[serde(default)]
    pub group_by: Option<String>,
    #[serde(default)]
    pub from: Option<DateTime<Utc>>,
    #[serde(default)]
    pub to: Option<DateTime<Utc>>,
}

fn parse_group_by(q: &ConsumptionQuery) -> ApiResult<store_db::reports::GroupBy> {
    q.group_by
        .as_deref()
        .unwrap_or("item")
        .parse::<store_db::reports::GroupBy>()
        .map_err(ApiError::from)
}

/// `GET /api/v1/reports/consumption`
pub async fn consumption(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<ConsumptionQuery>,
) -> ApiResult<impl IntoResponse> {
    let group_by = parse_group_by(&q)?;
    let rows = store_db::reports::consumption(
        &state.pool,
        group_by,
        &store_db::reports::ConsumptionFilter {
            from: q.from,
            to: q.to,
        },
    )
    .await?;

    Ok(Json(rows))
}

/// `GET /api/v1/reports/consumption.csv`
pub async fn consumption_csv(
    State(state): State<AppState>,
    _auth: Auth,
    Query(q): Query<ConsumptionQuery>,
) -> ApiResult<impl IntoResponse> {
    let group_by = parse_group_by(&q)?;
    let rows = store_db::reports::consumption(
        &state.pool,
        group_by,
        &store_db::reports::ConsumptionFilter {
            from: q.from,
            to: q.to,
        },
    )
    .await?;

    let csv = store_db::reports::to_csv(group_by, &rows);

    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "text/csv; charset=utf-8"),
            (
                axum::http::header::CONTENT_DISPOSITION,
                "attachment; filename=\"consumption.csv\"",
            ),
        ],
        csv,
    ))
}

/// `GET /api/v1/reason-codes`
pub async fn reason_codes(
    State(state): State<AppState>,
    _auth: Auth,
) -> ApiResult<impl IntoResponse> {
    let rows = sqlx::query!(
        r#"
        select id, code, label, applies_to, sort_order
          from reason_codes where active
         order by applies_to, sort_order
        "#
    )
    .fetch_all(&state.pool)
    .await
    .map_err(store_db::DbError::from)?;

    let json: Vec<_> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.id,
                "code": r.code,
                "label": r.label,
                "applies_to": r.applies_to,
                "sort_order": r.sort_order,
            })
        })
        .collect();

    Ok(Json(json))
}

/// `GET /api/v1/machines`
pub async fn machines(
    State(state): State<AppState>,
    _auth: Auth,
) -> ApiResult<impl IntoResponse> {
    let rows = sqlx::query!("select id, code, name from machines where active order by code")
        .fetch_all(&state.pool)
        .await
        .map_err(store_db::DbError::from)?;

    let json: Vec<_> = rows
        .into_iter()
        .map(|r| serde_json::json!({ "id": r.id, "code": r.code, "name": r.name }))
        .collect();

    Ok(Json(json))
}
