//! The SSE event bus (CLAUDE.md §4, §11).
//!
//! > Tablets subscribe to `GET /api/v1/sessions/stream`. When a punch arrives
//! > the server emits a `session.opened` event and the tablet foregrounds the
//! > IN/OUT panel. **No polling.**

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Everything a tablet or the admin dashboard is told about, live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    /// A punch arrived and is offering a session. The tablet foregrounds the
    /// claim screen.
    #[serde(rename = "session.opened")]
    SessionOpened {
        session_id: Uuid,
        operator_id: Uuid,
        emp_code: String,
        full_name: String,
        opened_at: DateTime<Utc>,
        expires_in_secs: i64,
    },

    /// A session was claimed. Other tablets remove the card.
    #[serde(rename = "session.claimed")]
    SessionClaimed { session_id: Uuid, tablet_id: String },

    /// A session ended, for any reason.
    #[serde(rename = "session.closed")]
    SessionClosed { session_id: Uuid, reason: String },

    /// An item crossed into LOW or EMPTY. Drives the tablet banner (§12.1) and
    /// the admin console.
    #[serde(rename = "alert.raised")]
    AlertRaised {
        item_id: Uuid,
        item_code: String,
        description: String,
        level: String,
        on_hand: String,
    },

    /// A punch whose `zk_user_id` maps to no operator (§9.4). Never dropped —
    /// the admin needs to know the master is incomplete.
    #[serde(rename = "punch.unknown_user")]
    UnknownUser {
        zk_user_id: String,
        device_serial: String,
        received_at: DateTime<Utc>,
    },

    /// Keeps proxies from closing an idle connection.
    #[serde(rename = "heartbeat")]
    Heartbeat { at: DateTime<Utc> },
}

impl ServerEvent {
    /// The SSE `event:` name, so a client can subscribe by type.
    pub fn name(&self) -> &'static str {
        match self {
            ServerEvent::SessionOpened { .. } => "session.opened",
            ServerEvent::SessionClaimed { .. } => "session.claimed",
            ServerEvent::SessionClosed { .. } => "session.closed",
            ServerEvent::AlertRaised { .. } => "alert.raised",
            ServerEvent::UnknownUser { .. } => "punch.unknown_user",
            ServerEvent::Heartbeat { .. } => "heartbeat",
        }
    }
}

/// Fan-out to every connected tablet and admin client.
#[derive(Debug, Clone)]
pub struct EventBus {
    tx: broadcast::Sender<ServerEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        // Deep enough to absorb a terminal dumping a backlog after an outage
        // without disconnecting a tablet that is briefly behind.
        let (tx, _) = broadcast::channel(1024);
        EventBus { tx }
    }

    /// Publish. A send with no subscribers is not an error — a store with the
    /// tablets powered off is an ordinary state, and the ledger is the record
    /// of what happened regardless.
    pub fn publish(&self, event: ServerEvent) {
        let subscribers = self.tx.receiver_count();
        if subscribers == 0 {
            tracing::debug!(event = event.name(), "no subscribers");
        }
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerEvent> {
        self.tx.subscribe()
    }

    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_match_the_wire_contract() {
        // §11 names these three explicitly; the tablet subscribes by name.
        let opened = ServerEvent::SessionOpened {
            session_id: Uuid::nil(),
            operator_id: Uuid::nil(),
            emp_code: "E1".into(),
            full_name: "R. Kumar".into(),
            opened_at: Utc::now(),
            expires_in_secs: 90,
        };
        assert_eq!(opened.name(), "session.opened");

        let closed = ServerEvent::SessionClosed {
            session_id: Uuid::nil(),
            reason: "SUBMITTED".into(),
        };
        assert_eq!(closed.name(), "session.closed");

        let alert = ServerEvent::AlertRaised {
            item_id: Uuid::nil(),
            item_code: "X".into(),
            description: "Y".into(),
            level: "LOW".into(),
            on_hand: "3".into(),
        };
        assert_eq!(alert.name(), "alert.raised");
    }

    #[test]
    fn events_serialise_with_a_discriminating_type_field() {
        let json = serde_json::to_value(ServerEvent::SessionClaimed {
            session_id: Uuid::nil(),
            tablet_id: "TAB-1".into(),
        })
        .unwrap();

        assert_eq!(json["type"], "session.claimed");
        assert_eq!(json["tablet_id"], "TAB-1");
    }

    #[tokio::test]
    async fn every_subscriber_sees_every_event() {
        let bus = EventBus::new();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();
        assert_eq!(bus.subscriber_count(), 2);

        bus.publish(ServerEvent::Heartbeat { at: Utc::now() });

        assert_eq!(a.recv().await.unwrap().name(), "heartbeat");
        assert_eq!(b.recv().await.unwrap().name(), "heartbeat");
    }

    #[test]
    fn publishing_with_nobody_listening_is_not_an_error() {
        let bus = EventBus::new();
        bus.publish(ServerEvent::Heartbeat { at: Utc::now() });
    }
}
