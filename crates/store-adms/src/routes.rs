//! The `/iclock/*` listener (CLAUDE.md §9).
//!
//! Two rules shape every handler here:
//!
//! 1. **Respond fast.** A slow or non-`OK` response makes the device retry,
//!    which duplicates records. The ATTLOG handler persists (one bulk insert)
//!    and acknowledges; session logic goes onto a channel and is somebody
//!    else's problem.
//! 2. **Never drop data.** Unparseable lines and unknown users are recorded and
//!    surfaced, never discarded, because a gap in this log is unrecoverable.

use std::sync::Arc;

use async_trait::async_trait;
use axum::extract::{RawQuery, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::Router;
use futures::stream::{BoxStream, StreamExt};
use store_core::identity::{IdentityEvent, IdentitySource};
use tokio::sync::broadcast;

use crate::commands::CommandQueue;
use crate::protocol::{
    attlog_ack, parse_attlog, parse_command_results, AttlogRecord, DeviceQuery,
    HandshakeOptions,
};

/// Where punches get persisted.
///
/// `store-adms` depends on `store-core` only (§5), so it cannot reach the
/// database itself. The server supplies this.
#[async_trait]
pub trait PunchSink: Send + Sync {
    /// Note that a device is alive. Called on every handshake and poll.
    async fn device_seen(&self, serial: &str, firmware: Option<&str>) -> Result<(), SinkError>;

    /// Persist a batch of records.
    ///
    /// **Must be idempotent** on `(serial, user_id, device_ts)`: §9.1, the
    /// device retries on any non-`OK`, so the same batch arrives repeatedly as
    /// a matter of course. Returns how many rows were genuinely new.
    async fn persist(&self, serial: &str, records: &[AttlogRecord])
        -> Result<usize, SinkError>;
}

#[derive(Debug, thiserror::Error)]
#[error("punch sink failed: {0}")]
pub struct SinkError(pub String);

/// The ADMS-backed [`IdentitySource`] (§8).
///
/// The listener publishes here; the session service subscribes. Keeping the
/// two apart is what lets every integration test run against
/// `MockIdentitySource` with no hardware present.
#[derive(Debug, Clone)]
pub struct AdmsIdentitySource {
    source_id: String,
    tx: broadcast::Sender<IdentityEvent>,
}

impl AdmsIdentitySource {
    pub fn new(source_id: impl Into<String>) -> Self {
        // Sized for a terminal dumping a backlog after a network outage: 500
        // rows is the M2 gate's batch, and a subscriber briefly behind should
        // not miss punches.
        let (tx, _) = broadcast::channel(2048);
        AdmsIdentitySource {
            source_id: source_id.into(),
            tx,
        }
    }

    /// Publish an event. A send with no subscribers is not an error — the
    /// punch is already persisted by the time we get here.
    pub fn publish(&self, event: IdentityEvent) {
        let _ = self.tx.send(event);
    }
}

#[async_trait]
impl IdentitySource for AdmsIdentitySource {
    async fn subscribe(&self) -> BoxStream<'static, IdentityEvent> {
        tokio_stream::wrappers::BroadcastStream::new(self.tx.subscribe())
            .filter_map(|r| async move {
                if let Err(err) = &r {
                    // Lagging means we dropped events for this subscriber. The
                    // punches are safe in Postgres; what is lost is the live
                    // wake-up, so this deserves a loud log.
                    tracing::error!(?err, "ADMS identity subscriber lagged");
                }
                r.ok()
            })
            .boxed()
    }

    fn source_id(&self) -> &str {
        &self.source_id
    }
}

/// Everything the `/iclock/*` handlers need.
#[derive(Clone)]
pub struct AdmsState {
    pub sink: Arc<dyn PunchSink>,
    pub source: Arc<AdmsIdentitySource>,
    pub commands: Arc<CommandQueue>,
}

impl AdmsState {
    pub fn new(sink: Arc<dyn PunchSink>) -> Self {
        AdmsState {
            sink,
            source: Arc::new(AdmsIdentitySource::new("adms")),
            commands: Arc::new(CommandQueue::new()),
        }
    }
}

impl std::fmt::Debug for AdmsState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdmsState")
            .field("source", &self.source.source_id)
            .finish_non_exhaustive()
    }
}

/// The router a terminal talks to. Mount it at the root of the ADMS port.
pub fn router(state: AdmsState) -> Router {
    Router::new()
        .route("/iclock/cdata", get(handshake).post(push_data))
        .route("/iclock/getrequest", get(get_request))
        .route("/iclock/devicecmd", post(device_cmd))
        // Some firmware appends a trailing slash.
        .route("/iclock/cdata/", get(handshake).post(push_data))
        .route("/iclock/getrequest/", get(get_request))
        .route("/iclock/devicecmd/", post(device_cmd))
        .with_state(state)
}

/// `GET /iclock/cdata?SN=<serial>&options=all&pushver=...`
///
/// The device's boot handshake. Answer with the plain-text option block.
async fn handshake(
    State(state): State<AdmsState>,
    RawQuery(query): RawQuery,
) -> (StatusCode, String) {
    let q = DeviceQuery::parse(query.as_deref().unwrap_or_default());
    let Some(serial) = q.serial else {
        // No serial means we cannot attribute anything. Say so plainly rather
        // than inventing a device.
        return (StatusCode::BAD_REQUEST, "ERROR: missing SN\n".to_owned());
    };

    if let Err(err) = state.sink.device_seen(&serial, q.pushver.as_deref()).await {
        tracing::error!(%serial, %err, "failed to record device handshake");
    }

    tracing::info!(%serial, pushver = ?q.pushver, "device handshake");
    (StatusCode::OK, HandshakeOptions::new(&serial).render())
}

/// `POST /iclock/cdata?SN=<serial>&table=ATTLOG`
///
/// The hot path. Everything here is on the clock: §9.2 budgets ~200 ms, and
/// overrunning it makes the device retry the whole batch.
async fn push_data(
    State(state): State<AdmsState>,
    RawQuery(query): RawQuery,
    body: String,
) -> (StatusCode, String) {
    let q = DeviceQuery::parse(query.as_deref().unwrap_or_default());
    let Some(serial) = q.serial else {
        return (StatusCode::BAD_REQUEST, "ERROR: missing SN\n".to_owned());
    };

    // Tables other than ATTLOG (OPERLOG, ATTPHOTO, …) are acknowledged and
    // ignored. Refusing them would make the device retry forever.
    let table = q.table.as_deref().unwrap_or("ATTLOG");
    if table != "ATTLOG" {
        tracing::debug!(%serial, %table, "ignoring non-attendance table");
        return (StatusCode::OK, attlog_ack(0));
    }

    let (records, rejected) = parse_attlog(&body);

    for (line, err) in &rejected {
        // Logged, not dropped silently, and never a reason to fail the batch.
        tracing::warn!(%serial, %line, %err, "unparseable ATTLOG line");
    }

    if !records.is_empty() {
        if let Err(err) = state.sink.persist(&serial, &records).await {
            // Persist failed: do *not* acknowledge. The device will retry, and
            // the dedup index makes that safe. Losing the punch is the one
            // outcome we cannot accept.
            tracing::error!(%serial, %err, count = records.len(), "failed to persist punches");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "ERROR: persist failed\n".to_owned(),
            );
        }

        // Persisted. Now hand the session service its work and get out of the
        // way — publishing is a non-blocking channel send.
        for record in &records {
            state.source.publish(record.to_identity_event(&serial));
        }
    }

    // §9: the count is of records received. Answering with a post-dedup count
    // would tell a retrying device that we lost rows, and it would retry again.
    let acknowledged = records.len() + rejected.len();
    (StatusCode::OK, attlog_ack(acknowledged))
}

/// `GET /iclock/getrequest?SN=<serial>`
///
/// The device polling for work. `OK` when there is none.
async fn get_request(
    State(state): State<AdmsState>,
    RawQuery(query): RawQuery,
) -> (StatusCode, String) {
    let q = DeviceQuery::parse(query.as_deref().unwrap_or_default());
    let Some(serial) = q.serial else {
        return (StatusCode::BAD_REQUEST, "ERROR: missing SN\n".to_owned());
    };

    if let Err(err) = state.sink.device_seen(&serial, None).await {
        tracing::warn!(%serial, %err, "failed to record device poll");
    }

    match state.commands.take_next(&serial) {
        Some(cmd) => {
            tracing::info!(%serial, id = %cmd.id, "dispatching command to device");
            (StatusCode::OK, cmd.render())
        }
        None => (StatusCode::OK, "OK".to_owned()),
    }
}

/// `POST /iclock/devicecmd?SN=<serial>`
///
/// The device reporting what happened to a command.
async fn device_cmd(
    State(state): State<AdmsState>,
    RawQuery(query): RawQuery,
    body: String,
) -> (StatusCode, String) {
    let q = DeviceQuery::parse(query.as_deref().unwrap_or_default());
    let serial = q.serial.unwrap_or_else(|| "<unknown>".to_owned());

    let results = parse_command_results(&body);
    for result in &results {
        state.commands.complete(result);
    }

    tracing::debug!(%serial, count = results.len(), "device command results");
    (StatusCode::OK, "OK".to_owned())
}
