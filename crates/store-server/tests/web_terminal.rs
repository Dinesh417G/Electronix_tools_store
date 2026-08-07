//! Tests for serving the web terminal, and for the SSE authentication path it
//! depends on.
//!
//! The SSE tests exist because that path broke once and nothing noticed: the
//! browser could not authenticate the event stream, `EventSource` retried
//! quietly in the background, and the claim screen still appeared — via the
//! slow poll that is only meant to be a backstop. §4 says **no polling**, so a
//! working-looking screen was hiding a broken requirement. These pin it.

mod harness;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use harness::Harness;
use http_body_util::BodyExt;
use tower::ServiceExt;

async fn get(h: &Harness, uri: &str) -> (StatusCode, String, Option<String>) {
    let response = h
        .router
        .clone()
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .expect("router responded");

    let status = response.status();
    let cache = response
        .headers()
        .get("cache-control")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = response.into_body().collect().await.unwrap().to_bytes();

    (status, String::from_utf8_lossy(&body).into_owned(), cache)
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_event_stream_accepts_a_token_in_the_query_string(pool: sqlx::PgPool) {
    // `EventSource` cannot set headers. If this regresses, the tablet falls
    // back to polling and §4's "no polling" quietly stops being true.
    let h = Harness::start(pool).await;

    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/sessions/stream?access_token={}",
                    h.tablet_token
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("router responded");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("text/event-stream"),
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_event_stream_still_accepts_a_bearer_header(pool: sqlx::PgPool) {
    // Non-browser clients must never need to put a secret in a URL.
    let h = Harness::start(pool).await;

    let response = h
        .router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/sessions/stream")
                .header("authorization", format!("Bearer {}", h.tablet_token))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("router responded");

    assert_eq!(response.status(), StatusCode::OK);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_event_stream_refuses_a_bad_or_missing_token(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;

    for uri in [
        "/api/v1/sessions/stream",
        "/api/v1/sessions/stream?access_token=",
        "/api/v1/sessions/stream?access_token=not-a-real-token",
    ] {
        let (status, _, _) = get(&h, uri).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "for {uri}");
    }
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn a_query_token_does_not_open_any_other_endpoint(pool: sqlx::PgPool) {
    // The query-string token is scoped to the stream. If it worked everywhere,
    // a stream URL in a proxy log would be a working credential for writes.
    let h = Harness::start(pool).await;

    for uri in [
        "/api/v1/sessions/unclaimed",
        "/api/v1/stock",
        "/api/v1/alerts",
    ] {
        let (status, _, _) = get(&h, &format!("{uri}?access_token={}", h.tablet_token)).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "for {uri}");
    }
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_terminal_is_served_at_the_root(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (status, body, cache) = get(&h, "/").await;

    assert_eq!(
        status,
        StatusCode::OK,
        "run `npm run build` in crates/store-web"
    );
    assert!(body.contains("<div id=\"root\">"), "not the app shell");

    // index.html is how a device learns a new build exists. Caching it is
    // exactly how a PWA gets stuck on an old version.
    let cache = cache.expect("index.html must carry a cache-control header");
    assert!(
        cache.contains("no-store"),
        "index.html was cacheable: {cache}"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_service_worker_is_never_cached(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (status, _, cache) = get(&h, "/sw.js").await;

    assert_eq!(status, StatusCode::OK);
    let cache = cache.expect("sw.js must carry a cache-control header");
    assert!(
        cache.contains("no-store"),
        "the update channel was cacheable: {cache}"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn hashed_assets_are_immutable(pool: sqlx::PgPool) {
    let h = Harness::start(pool).await;
    let (_, index, _) = get(&h, "/").await;

    let asset = index
        .split('"')
        .find(|s| s.starts_with("/assets/") && s.ends_with(".js"))
        .expect("index.html should reference a hashed asset");

    let (status, _, cache) = get(&h, asset).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        cache.as_deref().unwrap_or_default().contains("immutable"),
        "hashed assets should be cached forever: {cache:?}"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn unknown_client_routes_fall_back_to_the_shell_but_missing_assets_do_not(
    pool: sqlx::PgPool,
) {
    let h = Harness::start(pool).await;

    // A client-side route: hand back the shell and let the app decide.
    let (status, body, _) = get(&h, "/live").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("<div id=\"root\">"));

    // A missing asset must 404. A script tag that silently receives HTML
    // produces an error nobody can read.
    let (status, _, _) = get(&h, "/assets/does-not-exist.js").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_web_fallback_never_shadows_the_api_or_the_device_protocol(pool: sqlx::PgPool) {
    // The terminal's catch-all route is merged last, but "last" is a property
    // of one line in lib.rs. If it ever moves, the door stops working.
    let h = Harness::start(pool).await;

    let (status, _, _) = get(&h, "/api/v1/stock").await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the API was shadowed by the SPA"
    );

    let (status, body, _) = get(&h, "/iclock/cdata?SN=ZK-1&options=all").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.starts_with("GET OPTION FROM:"),
        "the door listener was shadowed by the SPA: {body}"
    );
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_version_endpoint_reports_the_build(pool: sqlx::PgPool) {
    // Unauthenticated on purpose: a device that cannot authenticate still has
    // to be able to say what it is running.
    let h = Harness::start(pool).await;
    let (status, body, _) = get(&h, "/api/v1/version").await;

    assert_eq!(status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_str(&body).expect("version is JSON");
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
    assert!(json["git_sha"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(json["built_at"].as_str().is_some_and(|s| !s.is_empty()));
}

#[sqlx::test(migrator = "store_db::MIGRATOR")]
async fn the_manifest_and_icons_are_served(pool: sqlx::PgPool) {
    // Without these the app cannot be installed to a home screen, which is how
    // a phone becomes a terminal.
    let h = Harness::start(pool).await;

    for (path, expected) in [
        ("/manifest.webmanifest", "application/manifest+json"),
        ("/icon-192.png", "image/png"),
        ("/favicon.ico", "image/x-icon"),
    ] {
        let response = h
            .router
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "for {path}");
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some(expected),
            "for {path}"
        );
    }
}
