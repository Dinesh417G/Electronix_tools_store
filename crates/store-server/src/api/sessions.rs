//! Session endpoints and the SSE stream (CLAUDE.md §11, §10).

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use futures::stream::Stream;
use serde::{Deserialize, Serialize};
use store_core::session::{CloseReason, TabletId};
use store_db::sessions::UnclaimedSession;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use uuid::Uuid;

use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::events::ServerEvent;
use crate::state::AppState;

/// `GET /api/v1/sessions/stream`
///
/// §4: tablets subscribe here and the server pushes. **No polling.** A punch
/// becomes a `session.opened` event and the tablet foregrounds the IN/OUT
/// panel before the operator has finished walking over.
pub async fn stream(
    State(state): State<AppState>,
    _auth: Auth,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.bus.subscribe();

    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(event) => {
            let sse = Event::default()
                .event(event.name())
                .json_data(&event)
                .unwrap_or_else(|err| {
                    tracing::error!(?err, "could not serialise server event");
                    Event::default().event("error").data("serialisation failed")
                });
            Some(Ok(sse))
        }
        Err(err) => {
            // A lagging tablet has missed events. The ledger is unaffected, but
            // its claim screen may now be stale, so this is worth shouting
            // about.
            tracing::error!(?err, "SSE subscriber lagged");
            None
        }
    });

    // Proxies and Android's radio both like to drop a silent connection.
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}

/// `GET /api/v1/sessions/unclaimed`
///
/// Every unclaimed punch from the last 90 s, as name cards. §10: tailgating is
/// solved socially — each person taps their own card — so we return all of
/// them rather than guessing.
pub async fn unclaimed(
    State(state): State<AppState>,
    _auth: Auth,
) -> ApiResult<Json<Vec<UnclaimedSession>>> {
    Ok(Json(store_db::sessions::unclaimed(&state.pool).await?))
}

#[derive(Debug, Deserialize)]
pub struct ClaimRequest {
    pub tablet_id: String,
}

#[derive(Debug, Serialize)]
pub struct SessionResponse {
    pub session_id: Uuid,
    pub operator_id: Uuid,
    pub emp_code: String,
    pub full_name: String,
    pub state: String,
    pub manual_identity: bool,
    pub tablet_id: Option<String>,
}

async fn describe(state: &AppState, session_id: Uuid) -> ApiResult<SessionResponse> {
    let session = store_db::sessions::get(&state.pool, session_id).await?;
    let operator = store_db::operators::get(&state.pool, session.operator_id).await?;

    Ok(SessionResponse {
        session_id: session.id,
        operator_id: operator.id,
        emp_code: operator.emp_code,
        full_name: operator.full_name,
        state: session.state.as_str().to_owned(),
        manual_identity: session.identity.is_manual(),
        tablet_id: session.state.tablet_id().map(|t| t.0.clone()),
    })
}

/// `POST /api/v1/sessions/{id}/claim`
///
/// A second tablet claiming an already-claimed session gets `409` naming the
/// holder (§10).
pub async fn claim(
    State(state): State<AppState>,
    auth: Auth,
    Path(id): Path<Uuid>,
    Json(body): Json<ClaimRequest>,
) -> ApiResult<Json<SessionResponse>> {
    let caller_tablet = auth.require_tablet()?;

    // A tablet may only claim in its own name. Otherwise one tablet could bind
    // a session to another and strand the operator standing in front of it.
    if caller_tablet != body.tablet_id {
        return Err(ApiError::Forbidden(
            "A tablet can only claim a session for itself.".into(),
        ));
    }

    let tablet_id = TabletId(body.tablet_id);
    store_db::sessions::claim(&state.pool, id, &tablet_id).await?;

    state.bus.publish(ServerEvent::SessionClaimed {
        session_id: id,
        tablet_id: tablet_id.0,
    });

    Ok(Json(describe(&state, id).await?))
}

#[derive(Debug, Deserialize)]
pub struct ManualSessionRequest {
    pub emp_code: String,
    pub pin: String,
    pub tablet_id: String,
}

/// `POST /api/v1/sessions/manual`
///
/// §10's fallback for when the device or the network is down. The resulting
/// session is flagged `manual_identity` and shown distinctly in reports,
/// because a typed PIN is weaker evidence than a fingerprint at the door.
pub async fn manual(
    State(state): State<AppState>,
    auth: Auth,
    Json(body): Json<ManualSessionRequest>,
) -> ApiResult<Json<SessionResponse>> {
    let caller_tablet = auth.require_tablet()?;
    if caller_tablet != body.tablet_id {
        return Err(ApiError::Forbidden(
            "A tablet can only open a session for itself.".into(),
        ));
    }

    let operator = store_db::auth::verify_operator_pin(&state.pool, &body.emp_code, &body.pin)
        .await?
        // One message for every failure mode, so the tablet cannot be used to
        // enumerate which employee codes exist.
        .ok_or_else(|| ApiError::Unauthorized)?;

    let session = store_db::sessions::open_manual(
        &state.pool,
        operator.id,
        &TabletId(body.tablet_id.clone()),
    )
    .await?;

    tracing::info!(
        session_id = %session.id,
        emp_code = %operator.emp_code,
        "manual-identity session opened"
    );

    state.bus.publish(ServerEvent::SessionClaimed {
        session_id: session.id,
        tablet_id: body.tablet_id,
    });

    Ok(Json(describe(&state, session.id).await?))
}

#[derive(Debug, Default, Deserialize)]
pub struct CloseRequest {
    /// Defaults to `DONE` — the operator tapped Done or backed out.
    #[serde(default)]
    pub reason: Option<String>,
}

/// `POST /api/v1/sessions/{id}/close`
pub async fn close(
    State(state): State<AppState>,
    _auth: Auth,
    Path(id): Path<Uuid>,
    body: Option<Json<CloseRequest>>,
) -> ApiResult<Json<SessionResponse>> {
    let reason = match body.and_then(|Json(b)| b.reason).as_deref() {
        Some("SUBMITTED") => CloseReason::Submitted,
        Some("IDLE_TIMEOUT") => CloseReason::IdleTimeout,
        _ => CloseReason::Done,
    };

    store_db::sessions::close(&state.pool, id, reason).await?;

    state.bus.publish(ServerEvent::SessionClosed {
        session_id: id,
        reason: reason.as_str().to_owned(),
    });

    Ok(Json(describe(&state, id).await?))
}

/// `GET /api/v1/sessions/{id}`
pub async fn get(
    State(state): State<AppState>,
    _auth: Auth,
    Path(id): Path<Uuid>,
) -> ApiResult<Json<SessionResponse>> {
    Ok(Json(describe(&state, id).await?))
}
