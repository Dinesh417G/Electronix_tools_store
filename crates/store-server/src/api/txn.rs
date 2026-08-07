//! Transaction endpoints — the only way stock moves (CLAUDE.md §7, §11).
//!
//! Every write here goes through `store-core`'s `Movement` constructors, so
//! direction comes from the transaction type rather than from a sign the tablet
//! sent, and every write names an operator taken from the *session* rather than
//! from the token — a tablet acts for whoever claimed it, not on its own behalf.

use axum::extract::{Path, State};
use axum::Json;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use store_core::ledger::{Movement, Qty};
use store_core::session::TabletId;
use store_db::ledger::{MovementReceipt, NewMovement};
use uuid::Uuid;

use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::events::ServerEvent;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct IssueRequest {
    pub session_id: Uuid,
    pub item_id: Uuid,
    pub qty: Decimal,
    #[serde(default)]
    pub machine_id: Option<Uuid>,
    #[serde(default)]
    pub reason_id: Option<Uuid>,
    #[serde(default)]
    pub note: Option<String>,
    /// §12: the tablet's offline outbox generates this before the row can reach
    /// the server, so a replayed queue deduplicates instead of double-booking.
    #[serde(default)]
    pub client_txn_uuid: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptRequest {
    pub session_id: Uuid,
    pub item_id: Uuid,
    pub qty: Decimal,
    #[serde(default)]
    pub unit_cost: Option<Decimal>,
    #[serde(default)]
    pub reason_id: Option<Uuid>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub client_txn_uuid: Option<Uuid>,
}

/// What the tablet's success screen renders (§12.7).
#[derive(Debug, Serialize)]
pub struct TxnResponse {
    pub ledger_id: i64,
    pub item_id: Uuid,
    pub item_code: String,
    pub description: String,
    pub delta_qty: Decimal,
    pub on_hand: Decimal,
    pub alert_state: String,
    /// True when this transaction is what pushed the item into LOW or EMPTY.
    /// The tablet turns it into *"This item is now LOW — storekeeper notified."*
    pub crossed_threshold: bool,
}

/// Check that the session is live, belongs to this tablet, and yield the
/// operator to bill the movement to.
///
/// §10: work submitted after close is `410 Gone`, so the tablet re-opens the
/// claim screen rather than silently discarding the operator's typing.
async fn authorise_session(state: &AppState, auth: &Auth, session_id: Uuid) -> ApiResult<Uuid> {
    let session = store_db::sessions::get(&state.pool, session_id).await?;

    match &auth.0 {
        store_db::auth::Principal::Tablet { tablet_id } => {
            session.accepts_work_from(&TabletId(tablet_id.clone()))?;
        }
        store_db::auth::Principal::Operator { .. } => {
            // The admin app can post against a session too, but it must still
            // be a live one.
            if session.state.is_terminal() {
                return Err(ApiError::Gone("That session has closed.".into()));
            }
        }
    }

    Ok(session.operator_id)
}

async fn finish(
    state: &AppState,
    session_id: Uuid,
    item_id: Uuid,
    receipt: MovementReceipt,
) -> ApiResult<Json<TxnResponse>> {
    let item = store_db::items::get(&state.pool, item_id).await?;

    if receipt.crossed_threshold {
        state.bus.publish(ServerEvent::AlertRaised {
            item_id,
            item_code: item.item_code.clone(),
            description: item.description.clone(),
            level: receipt.alert_state.clone(),
            on_hand: receipt.on_hand.to_string(),
        });
    }

    // §10: submit closes the session. Doing it here rather than making the
    // tablet call close means a tablet that dies mid-confirm still leaves a
    // tidy session behind.
    let closed =
        store_db::sessions::close(&state.pool, session_id, store_core::CloseReason::Submitted)
            .await;
    match closed {
        Ok(_) => state.bus.publish(ServerEvent::SessionClosed {
            session_id,
            reason: "SUBMITTED".into(),
        }),
        Err(err) => tracing::warn!(?err, %session_id, "could not close session after submit"),
    }

    Ok(Json(TxnResponse {
        ledger_id: receipt.ledger_id,
        item_id,
        item_code: item.item_code,
        description: item.description,
        delta_qty: receipt.delta_qty,
        on_hand: receipt.on_hand,
        alert_state: receipt.alert_state,
        crossed_threshold: receipt.crossed_threshold,
    }))
}

/// `POST /api/v1/txn/issue` — TAKE OUT.
pub async fn issue(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<IssueRequest>,
) -> ApiResult<Json<TxnResponse>> {
    let operator_id = authorise_session(&state, &auth, body.session_id).await?;
    let qty = Qty::new(body.qty)?;

    let receipt = store_db::ledger::record(
        &state.pool,
        &NewMovement {
            movement: Movement::issue(body.item_id, qty),
            operator_id,
            session_id: Some(body.session_id),
            machine_id: body.machine_id,
            reason_id: body.reason_id,
            note: body.note,
            unit_cost: None,
            device_ts: None,
            client_txn_uuid: body.client_txn_uuid,
        },
    )
    .await?;

    finish(&state, body.session_id, body.item_id, receipt).await
}

/// `POST /api/v1/txn/receipt` — PUT IN.
///
/// §2: the storekeeper enters IN on the tablet. There is no PO, no GRN and no
/// ERP import, so this endpoint is the entire inward path.
pub async fn receipt(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<ReceiptRequest>,
) -> ApiResult<Json<TxnResponse>> {
    let operator_id = authorise_session(&state, &auth, body.session_id).await?;
    let qty = Qty::new(body.qty)?;

    let receipt = store_db::ledger::record(
        &state.pool,
        &NewMovement {
            movement: Movement::receipt(body.item_id, qty),
            operator_id,
            session_id: Some(body.session_id),
            machine_id: None,
            reason_id: body.reason_id,
            note: body.note,
            unit_cost: body.unit_cost,
            device_ts: None,
            client_txn_uuid: body.client_txn_uuid,
        },
    )
    .await?;

    finish(&state, body.session_id, body.item_id, receipt).await
}

#[derive(Debug, Default, Deserialize)]
pub struct ReverseRequest {
    #[serde(default)]
    pub note: Option<String>,
}

/// `POST /api/v1/txn/{id}/reverse` — admin only.
///
/// §7: inserts the reversing row. It never edits or deletes the original, and
/// the append-only trigger would refuse if it tried.
pub async fn reverse(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<i64>,
    body: Option<Json<ReverseRequest>>,
) -> ApiResult<Json<TxnResponse>> {
    let operator_id = auth.require_admin()?;
    let note = body.and_then(|Json(b)| b.note);

    let receipt = store_db::ledger::reverse(&state.pool, id, operator_id, note).await?;
    let item = store_db::items::get(&state.pool, receipt.item_id).await?;

    tracing::info!(ledger_id = id, %operator_id, "ledger row reversed");

    Ok(Json(TxnResponse {
        ledger_id: receipt.ledger_id,
        item_id: receipt.item_id,
        item_code: item.item_code,
        description: item.description,
        delta_qty: receipt.delta_qty,
        on_hand: receipt.on_hand,
        alert_state: receipt.alert_state,
        crossed_threshold: receipt.crossed_threshold,
    }))
}
