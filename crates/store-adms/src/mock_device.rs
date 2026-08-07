//! A test harness that behaves like a real terminal (CLAUDE.md §5, §14).
//!
//! This exists so the whole system is testable on a laptop on a plane. It
//! speaks the protocol the way the firmware does — including the parts that are
//! inconvenient, like retrying a batch it has already sent, because those are
//! exactly the parts a bug hides in.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use chrono::{DateTime, Duration, TimeZone, Utc};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// What the device got back from one request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceResponse {
    pub status: StatusCode,
    pub body: String,
}

impl DeviceResponse {
    /// Real firmware treats anything that is not a 2xx `OK…` as a failure and
    /// schedules a retry. The mock applies the same rule so tests see what the
    /// terminal would see.
    pub fn is_accepted(&self) -> bool {
        self.status == StatusCode::OK && self.body.starts_with("OK")
    }

    /// The `<n>` from an `OK: <n>` acknowledgement.
    pub fn ack_count(&self) -> Option<usize> {
        self.body.strip_prefix("OK: ")?.trim().parse().ok()
    }
}

/// A simulated ZKTeco terminal driving a [`Router`].
#[derive(Debug, Clone)]
pub struct MockDevice {
    router: Router,
    pub serial: String,
    pub firmware: String,
    /// Rows this device has sent, so a retry can resend the identical batch.
    sent: Vec<String>,
}

impl MockDevice {
    pub fn new(router: Router, serial: impl Into<String>) -> Self {
        MockDevice {
            router,
            serial: serial.into(),
            firmware: "2.4.1".to_owned(),
            sent: Vec::new(),
        }
    }

    async fn call(&self, request: Request<Body>) -> DeviceResponse {
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("router did not respond");
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("read body")
            .to_bytes();

        DeviceResponse {
            status,
            body: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }

    /// `GET /iclock/cdata?SN=..&options=all&pushver=..` — the boot handshake.
    pub async fn handshake(&self) -> DeviceResponse {
        let uri = format!(
            "/iclock/cdata?SN={}&options=all&pushver={}",
            self.serial, self.firmware
        );
        self.call(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    /// True when the handshake response carries the option block the firmware
    /// needs to start pushing.
    pub fn handshake_is_usable(response: &DeviceResponse) -> bool {
        response.status == StatusCode::OK
            && response.body.starts_with("GET OPTION FROM:")
            && response.body.contains("Realtime=1")
            && response.body.contains("ServerVer=")
    }

    /// Push a batch of ATTLOG rows.
    pub async fn push_attlog(&mut self, lines: &[String]) -> DeviceResponse {
        self.sent.extend_from_slice(lines);
        self.resend(lines).await
    }

    /// Send a batch without recording it — used to replay an earlier one.
    async fn resend(&self, lines: &[String]) -> DeviceResponse {
        let body = lines.join("\n");
        let uri = format!("/iclock/cdata?SN={}&table=ATTLOG", self.serial);
        self.call(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "text/plain")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
    }

    /// Retry a batch verbatim, the way firmware does when an acknowledgement
    /// is slow or malformed (§9.1).
    pub async fn retry(&self, lines: &[String]) -> DeviceResponse {
        self.resend(lines).await
    }

    /// Replay everything this device has ever sent. This is what a terminal
    /// does after a power cut with `ATTLOGStamp=0`.
    pub async fn resend_everything(&self) -> DeviceResponse {
        let all = self.sent.clone();
        self.resend(&all).await
    }

    /// `GET /iclock/getrequest?SN=..` — poll for a queued command.
    pub async fn poll_for_command(&self) -> DeviceResponse {
        let uri = format!("/iclock/getrequest?SN={}", self.serial);
        self.call(
            Request::builder()
                .method("GET")
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
    }

    /// `POST /iclock/devicecmd?SN=..` — report a command result.
    pub async fn report_command(&self, command_id: &str, return_code: i32) -> DeviceResponse {
        let uri = format!("/iclock/devicecmd?SN={}", self.serial);
        let body = format!("ID={command_id}&Return={return_code}&CMD=DATA");
        self.call(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header("content-type", "text/plain")
                .body(Body::from(body))
                .unwrap(),
        )
        .await
    }
}

/// Build `count` distinct ATTLOG lines, one second apart.
///
/// Distinct `(user_id, device_ts)` pairs matter: the dedup key is
/// `(device, user, device_ts)`, so a generator that repeated timestamps would
/// make a deduplication test pass for the wrong reason.
pub fn attlog_batch(count: usize, start: DateTime<Utc>, user_ids: &[&str]) -> Vec<String> {
    (0..count)
        .map(|i| {
            let ts = start + Duration::seconds(i as i64);
            let user = user_ids[i % user_ids.len()];
            format!("{user}\t{}\t0\t2\t0\t0", ts.format("%Y-%m-%d %H:%M:%S"))
        })
        .collect()
}

/// A fixed timestamp for tests that need a deterministic starting point.
pub fn fixture_start() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 8, 7, 6, 0, 0).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_batches_have_distinct_dedup_keys() {
        let lines = attlog_batch(500, fixture_start(), &["1042", "2077"]);
        assert_eq!(lines.len(), 500);

        let unique: std::collections::HashSet<&String> = lines.iter().collect();
        assert_eq!(unique.len(), 500, "generator produced duplicate rows");
    }

    #[test]
    fn ack_counts_are_read_back_from_the_response() {
        let r = DeviceResponse {
            status: StatusCode::OK,
            body: "OK: 500".into(),
        };
        assert!(r.is_accepted());
        assert_eq!(r.ack_count(), Some(500));

        let bad = DeviceResponse {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            body: "ERROR: persist failed\n".into(),
        };
        assert!(!bad.is_accepted());
        assert_eq!(bad.ack_count(), None);
    }
}
