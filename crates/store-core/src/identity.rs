//! Identity sources — CLAUDE.md §8.
//!
//! The ADMS listener is never wired directly into the session service. It sits
//! behind this trait, exactly as ElectronIx DNC puts FTP and raw-TCP behind
//! `Transport`. That is what lets the whole issue flow be driven with no
//! hardware present, which in turn is what lets §14's "testable on a laptop on
//! a plane" rule hold.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use futures::channel::mpsc;
use futures::stream::{BoxStream, StreamExt};
use serde::{Deserialize, Serialize};

/// How the reader verified the person at the door.
///
/// `Other` exists because ZK firmware families do not agree on their verify
/// codes (§9); an unrecognised mode is recorded, not dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum VerifyMode {
    Fingerprint,
    Card,
    Face,
    Password,
    Other(u8),
}

impl VerifyMode {
    /// Decode the `verify` column of an ATTLOG line.
    ///
    /// The common mapping across iClock-family firmware. Verified against a
    /// real capture at M2 — see §9's warning.
    pub const fn from_code(code: u8) -> Self {
        match code {
            0 | 1 => VerifyMode::Password,
            2 => VerifyMode::Fingerprint,
            3 | 4 => VerifyMode::Card,
            15 | 25 => VerifyMode::Face,
            other => VerifyMode::Other(other),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            VerifyMode::Fingerprint => "FINGERPRINT",
            VerifyMode::Card => "CARD",
            VerifyMode::Face => "FACE",
            VerifyMode::Password => "PASSWORD",
            VerifyMode::Other(_) => "OTHER",
        }
    }
}

/// A person was verified at a reader.
///
/// Note what this does *not* say: nothing about doors or locks. The terminal
/// owns the lock and opens it on its own (§2); we are told after the fact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityEvent {
    /// The PIN / user id programmed into the terminal — `operators.zk_user_id`.
    pub external_user_id: String,
    pub device_serial: String,
    /// What the terminal claimed. Diagnostic only (§9.3) — device clocks drift,
    /// and Indian half-hour offsets are a known trouble spot.
    pub device_ts: Option<DateTime<Utc>>,
    pub verify_mode: VerifyMode,
    /// The original line, kept verbatim so a firmware surprise is debuggable
    /// after the fact.
    pub raw: String,
}

/// A physical reader that reports verified identities.
#[async_trait]
pub trait IdentitySource: Send + Sync {
    /// Stream of verified-identity events from a physical reader.
    async fn subscribe(&self) -> BoxStream<'static, IdentityEvent>;

    /// Stable identifier used in logs and in `devices.name`.
    fn source_id(&self) -> &str;
}

/// An in-memory source for tests and demos (§8).
///
/// Must be able to drive a full issue flow with no hardware present — that is
/// its entire reason for existing, and every integration test runs against it.
///
/// Fan-out is a list of unbounded senders rather than a `tokio::sync::broadcast`
/// so that `store-core` keeps its §5 promise of depending on no runtime.
/// Unbounded is the right call here: dropping a punch under backpressure would
/// make tests flaky in exactly the way that teaches people to distrust them.
#[derive(Debug, Clone)]
pub struct MockIdentitySource {
    source_id: String,
    device_serial: String,
    subscribers: Arc<Mutex<Vec<mpsc::UnboundedSender<IdentityEvent>>>>,
}

impl MockIdentitySource {
    pub fn new(source_id: impl Into<String>, device_serial: impl Into<String>) -> Self {
        MockIdentitySource {
            source_id: source_id.into(),
            device_serial: device_serial.into(),
            subscribers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Simulate a fingerprint punch by `zk_user_id`.
    ///
    /// Returns the event that was published so a test can assert against the
    /// exact payload the server will see.
    pub fn punch(&self, zk_user_id: impl Into<String>) -> IdentityEvent {
        self.punch_with(zk_user_id, VerifyMode::Fingerprint, None)
    }

    pub fn punch_with(
        &self,
        zk_user_id: impl Into<String>,
        verify_mode: VerifyMode,
        device_ts: Option<DateTime<Utc>>,
    ) -> IdentityEvent {
        let zk_user_id = zk_user_id.into();
        let event = IdentityEvent {
            raw: format!("{zk_user_id}\tmock\t0\t{}\t0\t0", verify_mode.as_str()),
            external_user_id: zk_user_id,
            device_serial: self.device_serial.clone(),
            device_ts,
            verify_mode,
        };
        // A send with no subscribers is not an error here: a demo may punch
        // before anything is listening. Senders whose receiver has been dropped
        // are pruned as we go.
        let mut subscribers = self.subscribers.lock().expect("mock source poisoned");
        subscribers.retain(|tx| tx.unbounded_send(event.clone()).is_ok());
        event
    }

    /// Number of live subscribers, for tests that need to wait for readiness.
    pub fn subscriber_count(&self) -> usize {
        self.subscribers.lock().expect("mock source poisoned").len()
    }
}

#[async_trait]
impl IdentitySource for MockIdentitySource {
    async fn subscribe(&self) -> BoxStream<'static, IdentityEvent> {
        let (tx, rx) = mpsc::unbounded();
        self.subscribers
            .lock()
            .expect("mock source poisoned")
            .push(tx);
        rx.boxed()
    }

    fn source_id(&self) -> &str {
        &self.source_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_verify_codes_are_recorded_not_dropped() {
        assert_eq!(VerifyMode::from_code(2), VerifyMode::Fingerprint);
        assert_eq!(VerifyMode::from_code(3), VerifyMode::Card);
        assert_eq!(VerifyMode::from_code(200), VerifyMode::Other(200));
    }

    #[test]
    fn the_mock_source_drives_a_punch_with_no_hardware() {
        futures::executor::block_on(async {
            let src = MockIdentitySource::new("mock-1", "SN-TEST-001");
            let mut stream = src.subscribe().await;

            src.punch("1042");
            let got = stream.next().await.expect("event");

            assert_eq!(got.external_user_id, "1042");
            assert_eq!(got.device_serial, "SN-TEST-001");
            assert_eq!(got.verify_mode, VerifyMode::Fingerprint);
            assert_eq!(src.source_id(), "mock-1");
        });
    }

    #[test]
    fn two_people_walking_in_produce_two_events_in_order() {
        futures::executor::block_on(async {
            let src = MockIdentitySource::new("mock-1", "SN-TEST-001");
            let mut stream = src.subscribe().await;

            src.punch("1042");
            src.punch("2077");

            assert_eq!(stream.next().await.unwrap().external_user_id, "1042");
            assert_eq!(stream.next().await.unwrap().external_user_id, "2077");
        });
    }

    #[test]
    fn every_subscriber_sees_every_punch() {
        futures::executor::block_on(async {
            let src = MockIdentitySource::new("mock-1", "SN-TEST-001");
            let mut a = src.subscribe().await;
            let mut b = src.subscribe().await;
            assert_eq!(src.subscriber_count(), 2);

            src.punch("1042");

            assert_eq!(a.next().await.unwrap().external_user_id, "1042");
            assert_eq!(b.next().await.unwrap().external_user_id, "1042");
        });
    }

    #[test]
    fn dropped_subscribers_are_pruned() {
        futures::executor::block_on(async {
            let src = MockIdentitySource::new("mock-1", "SN-TEST-001");
            let a = src.subscribe().await;
            drop(a);
            src.punch("1042");
            assert_eq!(src.subscriber_count(), 0);
        });
    }
}
