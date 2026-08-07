//! Shared server state, the punch sink, and the two background tasks.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use sqlx::PgPool;
use store_adms::protocol::AttlogRecord;
use store_adms::routes::{PunchSink, SinkError};
use store_adms::CommandQueue;
use store_core::identity::{IdentityEvent, IdentitySource};
use store_db::sessions::SessionOffer;
use tokio::task::JoinHandle;

use crate::events::{EventBus, ServerEvent};

/// Everything the API handlers share.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub bus: EventBus,
    pub commands: Arc<CommandQueue>,
}

impl AppState {
    pub fn new(pool: PgPool) -> Self {
        AppState {
            pool,
            bus: EventBus::new(),
            commands: Arc::new(CommandQueue::new()),
        }
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("subscribers", &self.bus.subscriber_count())
            .finish_non_exhaustive()
    }
}

/// Persists punches for the ADMS listener.
///
/// §9.2 asks for persist-then-acknowledge inside ~200 ms, so this does exactly
/// one bulk insert and nothing else. Opening sessions is deliberately *not*
/// here: that happens off the hot path, driven by the identity stream.
pub struct DbPunchSink {
    pool: PgPool,
}

impl DbPunchSink {
    pub fn new(pool: PgPool) -> Self {
        DbPunchSink { pool }
    }
}

#[async_trait]
impl PunchSink for DbPunchSink {
    async fn device_seen(&self, serial: &str, firmware: Option<&str>) -> Result<(), SinkError> {
        store_db::punches::upsert_device(&self.pool, serial, firmware, None)
            .await
            .map(|_| ())
            .map_err(|e| SinkError(e.to_string()))
    }

    async fn persist(
        &self,
        serial: &str,
        records: &[AttlogRecord],
    ) -> Result<usize, SinkError> {
        let device_id = store_db::punches::upsert_device(&self.pool, serial, None, None)
            .await
            .map_err(|e| SinkError(e.to_string()))?;

        let mut new = 0;
        for record in records {
            let event = record.to_identity_event(serial);
            let (_, is_new) = store_db::punches::record(&self.pool, device_id, &event)
                .await
                .map_err(|e| SinkError(e.to_string()))?;
            if is_new {
                new += 1;
            }
        }

        Ok(new)
    }
}

/// Consume verified identities and turn them into session offers.
///
/// This is the seam §8 exists for: it takes `dyn IdentitySource`, so the same
/// code path runs against the real terminal, against `ManualPinSource`, and
/// against `MockIdentitySource` in every integration test.
///
/// Note what happens to a punch from an unknown user: it is already persisted,
/// and here it raises an admin notice. §9.4 — never drop data because the
/// operator master is incomplete.
pub fn spawn_identity_consumer(
    state: AppState,
    source: Arc<dyn IdentitySource>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let source_id = source.source_id().to_owned();
        let mut stream = source.subscribe().await;
        tracing::info!(%source_id, "identity consumer started");

        while let Some(event) = stream.next().await {
            if let Err(err) = handle_identity_event(&state, &event).await {
                // One bad punch must not take the consumer down; the store
                // would stop working at the door.
                tracing::error!(?err, ?event, "failed to handle identity event");
            }
        }

        tracing::warn!(%source_id, "identity consumer stopped");
    })
}

async fn handle_identity_event(
    state: &AppState,
    event: &IdentityEvent,
) -> Result<(), store_db::DbError> {
    let pool = &state.pool;

    let device_id =
        store_db::punches::upsert_device(pool, &event.device_serial, None, None).await?;

    // Idempotent: the ADMS handler has usually persisted this already (§9.2
    // persists before acknowledging), in which case we get the existing row
    // back. A MockIdentitySource punch lands here for the first time.
    //
    // Note we deliberately do *not* branch on whether this insert was new:
    // on the ADMS path it never is, and an early return here would mean no
    // session was ever offered for a real punch. What decides is whether the
    // punch has already offered a session, which is what `open_from_punch`
    // answers.
    let (punch_id, _) = store_db::punches::record(pool, device_id, event).await?;

    match store_db::sessions::open_from_punch(pool, punch_id).await? {
        SessionOffer::AlreadyOffered(session_id) => {
            tracing::debug!(%punch_id, %session_id, "punch already offered a session");
        }
        SessionOffer::Opened(session_id) => {
            let session = store_db::sessions::get(pool, session_id).await?;
            let operator = store_db::operators::get(pool, session.operator_id).await?;

            tracing::info!(
                %session_id,
                emp_code = %operator.emp_code,
                "session offered"
            );

            state.bus.publish(ServerEvent::SessionOpened {
                session_id,
                operator_id: operator.id,
                emp_code: operator.emp_code,
                full_name: operator.full_name,
                opened_at: session.opened_at,
                expires_in_secs: store_core::session::CLAIM_WINDOW_SECS,
            });
        }
        SessionOffer::UnknownOperator => {
            // §9.4. The punch is on record; we just have nobody to offer to.
            tracing::warn!(
                zk_user_id = %event.external_user_id,
                serial = %event.device_serial,
                "punch from a user with no matching operator"
            );
            state.bus.publish(ServerEvent::UnknownUser {
                zk_user_id: event.external_user_id.clone(),
                device_serial: event.device_serial.clone(),
                received_at: chrono::Utc::now(),
            });
        }
    }

    Ok(())
}

/// Expire stale claims and close idle sessions on a timer (§10).
///
/// A tablet whose session timed out under it is told, rather than left showing
/// a screen that silently no longer works.
pub fn spawn_session_reaper(state: AppState, interval: Duration) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;

            match store_db::sessions::reap(&state.pool).await {
                Ok(reaped) if reaped.is_empty() => {}
                Ok(reaped) => {
                    for session_id in reaped.expired {
                        state.bus.publish(ServerEvent::SessionClosed {
                            session_id,
                            reason: "EXPIRED".into(),
                        });
                    }
                    for session_id in reaped.idle_closed {
                        state.bus.publish(ServerEvent::SessionClosed {
                            session_id,
                            reason: "IDLE_TIMEOUT".into(),
                        });
                    }
                }
                Err(err) => tracing::error!(?err, "session reaper failed"),
            }
        }
    })
}
