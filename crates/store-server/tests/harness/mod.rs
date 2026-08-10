//! Test harness: the whole server, in-process, against a throwaway Postgres and
//! a `MockIdentitySource`.
//!
//! §14: no test may require the physical door terminal, and no test mocks the
//! database. Both halves of that matter — the door is what we cannot have on a
//! laptop, and the ledger is what we must not fake.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::PgPool;
use store_core::identity::{IdentitySource, MockIdentitySource};
use store_server::events::ServerEvent;
use store_server::AppState;
use tokio::sync::broadcast;
use tower::ServiceExt;
use uuid::Uuid;

pub const TABLET_A: &str = "TAB-STORE-A";
pub const TABLET_B: &str = "TAB-STORE-B";
pub const DEVICE_SERIAL: &str = "ZK-STORE-001";

pub struct Harness {
    pub pool: PgPool,
    pub router: Router,
    pub state: AppState,
    /// Present only on a harness built by `start()`.
    pub identity: Option<Arc<MockIdentitySource>>,
    /// The listener's own identity source, for harnesses driving real ADMS
    /// traffic.
    pub adms_source: Arc<dyn IdentitySource>,
    pub tablet_token: String,
    pub tablet_b_token: String,
}

impl Harness {
    /// Build the server and drive it from a `MockIdentitySource` (§8, §14).
    pub async fn start(pool: PgPool) -> Self {
        let mut h = Harness::build(pool).await;

        let identity = Arc::new(MockIdentitySource::new("mock", DEVICE_SERIAL));
        store_server::state::spawn_identity_consumer(
            h.state.clone(),
            identity.clone() as Arc<dyn IdentitySource>,
        );

        // Wait for the consumer to subscribe, so the first punch is not
        // published into the void.
        for _ in 0..100 {
            if identity.subscriber_count() > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        h.identity = Some(identity);
        h
    }

    /// Build the server and drive it from the *real* ADMS listener instead.
    ///
    /// This is the composition `start()` cannot exercise: the listener persists
    /// punches on the hot path (§9.2) and the consumer processes the same rows
    /// off it. A harness that always injects punches through the mock never
    /// sees the second look.
    pub async fn start_without_mock_identity(pool: PgPool) -> Self {
        let h = Harness::build(pool).await;
        store_server::state::spawn_identity_consumer(h.state.clone(), h.adms_source.clone());
        // Let the consumer subscribe before any device pushes.
        tokio::time::sleep(Duration::from_millis(20)).await;
        h
    }

    async fn build(pool: PgPool) -> Self {
        let state = AppState::new(pool.clone());
        let (router, adms_source) = store_server::app(state.clone());

        let tablet_token = store_db::auth::register_tablet(&pool, TABLET_A, Some("Store A"))
            .await
            .expect("register tablet A")
            .token;
        let tablet_b_token = store_db::auth::register_tablet(&pool, TABLET_B, Some("Store B"))
            .await
            .expect("register tablet B")
            .token;

        Harness {
            pool,
            router,
            state,
            identity: None,
            adms_source,
            tablet_token,
            tablet_b_token,
        }
    }

    fn mock(&self) -> &MockIdentitySource {
        self.identity
            .as_ref()
            .expect("this harness was built without a MockIdentitySource")
    }

    pub async fn punch_count(&self) -> i64 {
        sqlx::query_scalar!(r#"select count(*) as "n!" from punches"#)
            .fetch_one(&self.pool)
            .await
            .unwrap_or(0)
    }

    /// Wait for the identity consumer to have opened `n` sessions.
    ///
    /// The budget is generous because the consumer opens each session in its
    /// own transaction: five hundred of them is five hundred round trips, and
    /// on a busy machine running the whole suite in parallel that is seconds,
    /// not milliseconds. A bounded wait costs nothing when the condition is
    /// already met, and a too-tight one turns a passing test into a flake.
    pub async fn wait_for_sessions(&self, n: i64) {
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        let mut last = -1;

        while std::time::Instant::now() < deadline {
            let count = self.session_count().await;
            if count >= n {
                return;
            }
            // Stalled rather than slow is worth failing fast on, but only after
            // giving the consumer a fair chance to make progress.
            last = count;
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        panic!(
            "only {} session(s) opened, expected {n} (last seen {last})",
            self.session_count().await
        );
    }

    fn token_for(&self, tablet: &str) -> &str {
        if tablet == TABLET_B {
            &self.tablet_b_token
        } else {
            &self.tablet_token
        }
    }

    // ── HTTP ─────────────────────────────────────────────────────────────

    async fn send(&self, request: Request<Body>) -> (StatusCode, String) {
        let response = self
            .router
            .clone()
            .oneshot(request)
            .await
            .expect("router responded");
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    pub async fn get_raw(&self, _tablet: &str, token: &str, path: &str) -> (u16, String) {
        let (status, body) = self
            .send(
                Request::builder()
                    .method("GET")
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        (status.as_u16(), body)
    }

    pub async fn get_raw_unauthenticated(&self, path: &str) -> (u16, String) {
        let (status, body) = self
            .send(
                Request::builder()
                    .method("GET")
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        (status.as_u16(), body)
    }

    pub async fn get_json(&self, tablet: &str, path: &str) -> Value {
        let (status, body) = self.get_raw(tablet, self.token_for(tablet), path).await;
        assert!(
            (200..300).contains(&status),
            "GET {path} returned {status}: {body}"
        );
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("GET {path} body {body}: {e}"))
    }

    pub async fn get_text(&self, tablet: &str, path: &str) -> String {
        let (status, body) = self.get_raw(tablet, self.token_for(tablet), path).await;
        assert!((200..300).contains(&status), "GET {path} returned {status}");
        body
    }

    pub async fn post_raw(&self, tablet: &str, path: &str, body: Value) -> (u16, Value) {
        self.post_raw_with_token(self.token_for(tablet), path, body)
            .await
    }

    pub async fn post_raw_with_token(
        &self,
        token: &str,
        path: &str,
        body: Value,
    ) -> (u16, Value) {
        let (status, text) = self
            .send(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await;

        let parsed = serde_json::from_str(&text).unwrap_or(Value::String(text));
        (status.as_u16(), parsed)
    }

    pub async fn post_json(&self, tablet: &str, path: &str, body: Value) -> Value {
        let (status, parsed) = self.post_raw(tablet, path, body).await;
        assert!(
            (200..300).contains(&status),
            "POST {path} returned {status}: {parsed}"
        );
        parsed
    }

    pub async fn post_json_with_token(&self, token: &str, path: &str, body: Value) -> Value {
        let (status, parsed) = self.post_raw_with_token(token, path, body).await;
        assert!(
            (200..300).contains(&status),
            "POST {path} returned {status}: {parsed}"
        );
        parsed
    }

    /// Log in as an operator and return their bearer token.
    pub async fn login(&self, emp_code: &str, pin: &str) -> String {
        let (status, body) = self
            .post_raw_with_token(
                "unused",
                "/api/v1/auth/operator",
                serde_json::json!({ "emp_code": emp_code, "pin": pin }),
            )
            .await;
        assert_eq!(status, 200, "login failed: {body}");
        body["token"].as_str().expect("token").to_owned()
    }

    // ── Fixtures ─────────────────────────────────────────────────────────

    pub async fn operator(
        &self,
        emp_code: &str,
        zk_user_id: &str,
        full_name: &str,
        role: &str,
    ) -> Uuid {
        sqlx::query_scalar!(
            r#"
            insert into operators (emp_code, full_name, zk_user_id, role)
            values ($1, $2, $3, $4) returning id
            "#,
            emp_code,
            full_name,
            zk_user_id,
            role,
        )
        .fetch_one(&self.pool)
        .await
        .expect("create operator")
    }

    pub async fn item(&self, item_code: &str, reorder_level: Decimal) -> Uuid {
        sqlx::query_scalar!(
            r#"
            insert into items (item_code, description, uom, reorder_level, unit_cost)
            values ($1, $2, 'NOS', $3, 120.50) returning id
            "#,
            item_code,
            format!("Test item {item_code}"),
            reorder_level,
        )
        .fetch_one(&self.pool)
        .await
        .expect("create item")
    }

    pub async fn item_full(
        &self,
        item_code: &str,
        description: &str,
        iso_code: Option<&str>,
        grade: Option<&str>,
    ) -> Uuid {
        sqlx::query_scalar!(
            r#"
            insert into items (item_code, description, uom, iso_code, grade, unit_cost)
            values ($1, $2, 'NOS', $3, $4, 120.50) returning id
            "#,
            item_code,
            description,
            iso_code,
            grade,
        )
        .fetch_one(&self.pool)
        .await
        .expect("create item")
    }

    pub async fn machine(&self, code: &str) -> Uuid {
        sqlx::query_scalar!(
            "insert into machines (code, name) values ($1, $1) returning id",
            code
        )
        .fetch_one(&self.pool)
        .await
        .expect("create machine")
    }

    /// Book opening stock directly, bypassing the API — this is arranging the
    /// world for a test, not a behaviour under test.
    pub async fn receipt_stock(&self, item_id: Uuid, qty: Decimal, operator_id: Uuid) -> i64 {
        let receipt = store_db::ledger::record(
            &self.pool,
            &store_db::ledger::NewMovement {
                movement: store_core::Movement::opening(
                    item_id,
                    store_core::Qty::new(qty).expect("valid qty"),
                ),
                operator_id,
                session_id: None,
                machine_id: None,
                reason_id: None,
                note: Some("test fixture".into()),
                unit_cost: None,
                device_ts: None,
                client_txn_uuid: None,
            },
        )
        .await
        .expect("book opening stock");

        receipt.ledger_id
    }

    pub async fn on_hand(&self, item_id: Uuid) -> Decimal {
        sqlx::query_scalar!("select on_hand from item_stock where item_id = $1", item_id)
            .fetch_one(&self.pool)
            .await
            .expect("read on_hand")
    }

    // ── Driving the door ─────────────────────────────────────────────────

    /// Simulate a punch and wait for the session it opens.
    ///
    /// Resolves the *unclaimed session for this operator* rather than "the
    /// newest session": a test that punches repeatedly would otherwise pick up
    /// the previous, already-closed one.
    pub async fn punch(&self, zk_user_id: &str) -> Uuid {
        self.mock().punch(zk_user_id);

        // The consumer runs on its own task; wait for it to catch up rather
        // than sleeping a fixed amount and hoping.
        for _ in 0..500 {
            if let Some(id) = self.unclaimed_session_for(zk_user_id).await {
                return id;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        panic!("no session was opened for zk_user_id {zk_user_id}");
    }

    /// Punch without expecting a session.
    ///
    /// §9.4: a punch from a user with no matching operator is recorded and
    /// reported, but offers nobody a session — so a test about that case cannot
    /// use `punch()`.
    pub async fn punch_expecting_no_session(&self, zk_user_id: &str) {
        self.mock().punch(zk_user_id);
        self.settle().await;
    }

    async fn unclaimed_session_for(&self, zk_user_id: &str) -> Option<Uuid> {
        sqlx::query_scalar!(
            r#"
            select s.id from sessions s
              join operators o on o.id = s.operator_id
             where s.state = 'UNCLAIMED' and o.zk_user_id = $1
             order by s.opened_at desc
             limit 1
            "#,
            zk_user_id
        )
        .fetch_optional(&self.pool)
        .await
        .expect("query sessions")
    }

    /// Punch, then claim on the given tablet. The common preamble.
    pub async fn punch_and_claim(&self, zk_user_id: &str, tablet: &str) -> Uuid {
        let session_id = self.punch(zk_user_id).await;
        self.post_json(
            tablet,
            &format!("/api/v1/sessions/{session_id}/claim"),
            serde_json::json!({ "tablet_id": tablet }),
        )
        .await;
        session_id
    }

    pub async fn session_count(&self) -> i64 {
        sqlx::query_scalar!(r#"select count(*) as "n!" from sessions"#)
            .fetch_one(&self.pool)
            .await
            .unwrap_or(0)
    }

    /// Let background tasks catch up when a test does not have a specific
    /// condition to wait on.
    pub async fn settle(&self) {
        tokio::time::sleep(Duration::from_millis(60)).await;
    }

    /// Backdate a session's `opened_at`, so expiry can be tested without
    /// waiting 90 real seconds.
    pub async fn age_session(&self, session_id: Uuid, secs: i64) {
        sqlx::query!(
            "update sessions
                set opened_at = opened_at - make_interval(secs => $2::double precision)
              where id = $1",
            session_id,
            secs as f64,
        )
        .execute(&self.pool)
        .await
        .expect("age session");
    }

    /// Backdate `last_activity_at`, for the idle timeout.
    pub async fn age_activity(&self, session_id: Uuid, secs: i64) {
        sqlx::query!(
            "update sessions
                set last_activity_at = last_activity_at - make_interval(secs => $2::double precision)
              where id = $1",
            session_id,
            secs as f64,
        )
        .execute(&self.pool)
        .await
        .expect("age activity");
    }

    // ── Events ───────────────────────────────────────────────────────────

    pub fn subscribe_events(&self) -> EventStream {
        EventStream {
            rx: self.state.bus.subscribe(),
        }
    }
}

/// Parse a numeric JSON field into a `Decimal`.
///
/// Quantities cross the wire as strings to avoid float rounding, and Postgres
/// does not always echo a column's full scale back (zero in particular comes
/// back as `0`, not `0.000`). Comparing parsed values rather than text keeps
/// tests about the number rather than its formatting.
pub fn dec_of(value: &Value) -> Decimal {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected a numeric string, got {value}"))
        .parse()
        .unwrap_or_else(|e| panic!("could not parse {value} as a decimal: {e}"))
}

/// A subscriber to the SSE bus, for asserting on event order.
pub struct EventStream {
    rx: broadcast::Receiver<ServerEvent>,
}

impl EventStream {
    /// The next event, as JSON. Panics on timeout, so a test that expects an
    /// event and gets silence fails with a clear message rather than hanging.
    pub async fn next_event(&mut self) -> Value {
        let event = tokio::time::timeout(Duration::from_secs(5), self.rx.recv())
            .await
            .expect("timed out waiting for a server event")
            .expect("event bus closed");

        serde_json::to_value(event).expect("serialise event")
    }

    /// Skip ahead to the next event of a given type.
    pub async fn next_event_named(&mut self, name: &str) -> Value {
        for _ in 0..20 {
            let event = self.next_event().await;
            if event["type"] == name {
                return event;
            }
        }
        panic!("never saw a {name} event");
    }
}
