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
    /// One item going to several machines in one trip to the crib.
    ///
    /// When present, `qty` and `machine_id` are ignored and one ledger row is
    /// written per split, all in one transaction. A row per machine is what
    /// keeps consumption-by-machine answerable: five inserts tagged with three
    /// machines cannot tell you which machine ate them.
    #[serde(default)]
    pub splits: Vec<IssueSplit>,
}

/// One machine's share of a multi-machine issue.
#[derive(Debug, Deserialize)]
pub struct IssueSplit {
    pub machine_id: Uuid,
    pub qty: Decimal,
    /// Its own idempotency key, so a half-acknowledged batch replays row by row
    /// rather than all-or-nothing.
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
    /// Every row this request wrote. One entry for an ordinary transaction, one
    /// per machine for a split issue — the success screen says how many rows a
    /// single confirm produced, so an operator is never surprised by what turns
    /// up in the ledger.
    pub ledger_ids: Vec<i64>,
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

/// Answer a replay from the record, if this exact transaction is already in the
/// ledger.
///
/// This runs **before** session authorisation, and the order matters. §12's
/// outbox retries a request whose response was lost — the server committed it,
/// the acknowledgement never arrived. By then the session has closed on submit
/// (§10), so authorising first would answer `410 Gone` for a transaction that
/// is sitting in the ledger. The tablet would report it to the operator as
/// refused, and the operator would re-enter it by hand: a real duplicate,
/// created by the very mechanism meant to prevent one.
///
/// An idempotency key means "this exact request was already processed". The
/// only correct answer is the receipt we already produced.
async fn replayed(
    state: &AppState,
    client_txn_uuid: Option<Uuid>,
    item_id: Uuid,
) -> ApiResult<Option<Json<TxnResponse>>> {
    let Some(client_txn_uuid) = client_txn_uuid else {
        return Ok(None);
    };
    let Some(receipt) =
        store_db::ledger::find_by_client_uuid(&state.pool, client_txn_uuid).await?
    else {
        return Ok(None);
    };

    // Guard against a client reusing one key for a different item — that is a
    // bug on the tablet, and answering with the wrong item's receipt would turn
    // it into a stock discrepancy.
    if receipt.item_id != item_id {
        return Err(ApiError::Conflict(
            "That transaction id was already used for a different item.".into(),
        ));
    }

    let item = store_db::items::get(&state.pool, receipt.item_id).await?;
    tracing::info!(%client_txn_uuid, ledger_id = receipt.ledger_id, "replayed transaction answered from the ledger");

    Ok(Some(Json(TxnResponse {
        ledger_id: receipt.ledger_id,
        ledger_ids: vec![receipt.ledger_id],
        item_id: receipt.item_id,
        item_code: item.item_code,
        description: item.description,
        delta_qty: receipt.delta_qty,
        on_hand: receipt.on_hand,
        alert_state: receipt.alert_state,
        // Not a fresh crossing: the banner already fired when this row was
        // first accepted.
        crossed_threshold: false,
    })))
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
        ledger_ids: vec![receipt.ledger_id],
        item_id,
        item_code: item.item_code,
        description: item.description,
        delta_qty: receipt.delta_qty,
        on_hand: receipt.on_hand,
        alert_state: receipt.alert_state,
        crossed_threshold: receipt.crossed_threshold,
    }))
}

/// Close the session and answer for a batch that wrote several rows.
///
/// The balance reported is the one after the *last* row, because that is what
/// the bin holds now; the delta is the total that left it. Reporting one split's
/// figure would be true of nothing the operator did.
async fn finish_many(
    state: &AppState,
    session_id: Uuid,
    item_id: Uuid,
    receipts: Vec<MovementReceipt>,
) -> ApiResult<Json<TxnResponse>> {
    let last = receipts
        .last()
        .ok_or_else(|| ApiError::Conflict("a split issue wrote no rows".into()))?;

    let total: Decimal = receipts.iter().map(|r| r.delta_qty).sum();
    let crossed = receipts.iter().any(|r| r.crossed_threshold);

    let aggregate = MovementReceipt {
        ledger_id: last.ledger_id,
        item_id: last.item_id,
        delta_qty: total,
        on_hand: last.on_hand,
        alert_state: last.alert_state.clone(),
        crossed_threshold: crossed,
        created_at: last.created_at,
    };

    let ledger_ids: Vec<i64> = receipts.iter().map(|r| r.ledger_id).collect();
    let mut response = finish(state, session_id, item_id, aggregate).await?;
    response.0.ledger_id = ledger_ids[0];
    response.0.ledger_ids = ledger_ids;

    Ok(response)
}

/// `POST /api/v1/txn/issue` — TAKE OUT.
pub async fn issue(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<IssueRequest>,
) -> ApiResult<Json<TxnResponse>> {
    if !body.splits.is_empty() {
        return issue_split(state, auth, body).await;
    }

    if let Some(replay) = replayed(&state, body.client_txn_uuid, body.item_id).await? {
        return Ok(replay);
    }

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

/// One item, several machines, one confirm (§11).
///
/// Every split becomes its own ledger row inside one transaction, so the §7
/// negative-stock guard is applied to the total: an operator who asks for more
/// than the bin holds gets nothing written, rather than the first two machines
/// served and the third refused.
async fn issue_split(
    state: AppState,
    auth: Auth,
    body: IssueRequest,
) -> ApiResult<Json<TxnResponse>> {
    // A batch whose acknowledgement was lost is answered from the ledger, for
    // the same reason a single transaction is: by now the session has closed on
    // submit, so authorising first would refuse rows that are already recorded.
    let mut replayed_rows = Vec::new();
    for split in &body.splits {
        let Some(key) = split.client_txn_uuid else {
            break;
        };
        let Some(found) = store_db::ledger::find_by_client_uuid(&state.pool, key).await? else {
            break;
        };
        if found.item_id != body.item_id {
            return Err(ApiError::Conflict(
                "That transaction id was already used for a different item.".into(),
            ));
        }
        replayed_rows.push(found);
    }
    if replayed_rows.len() == body.splits.len() {
        tracing::info!(
            rows = replayed_rows.len(),
            "replayed split issue answered from the ledger"
        );
        return finish_many(&state, body.session_id, body.item_id, replayed_rows).await;
    }

    let operator_id = authorise_session(&state, &auth, body.session_id).await?;

    let mut movements = Vec::with_capacity(body.splits.len());
    for split in &body.splits {
        movements.push(NewMovement {
            movement: Movement::issue(body.item_id, Qty::new(split.qty)?),
            operator_id,
            session_id: Some(body.session_id),
            machine_id: Some(split.machine_id),
            reason_id: body.reason_id,
            note: body.note.clone(),
            unit_cost: None,
            device_ts: None,
            client_txn_uuid: split.client_txn_uuid,
        });
    }

    let receipts = store_db::ledger::record_many(&state.pool, &movements).await?;
    tracing::info!(
        rows = receipts.len(),
        item_id = %body.item_id,
        "split issue recorded, one row per machine"
    );

    finish_many(&state, body.session_id, body.item_id, receipts).await
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
    if let Some(replay) = replayed(&state, body.client_txn_uuid, body.item_id).await? {
        return Ok(replay);
    }

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
        ledger_ids: vec![receipt.ledger_id],
        item_id: receipt.item_id,
        item_code: item.item_code,
        description: item.description,
        delta_qty: receipt.delta_qty,
        on_hand: receipt.on_hand,
        alert_state: receipt.alert_state,
        crossed_threshold: receipt.crossed_threshold,
    }))
}
