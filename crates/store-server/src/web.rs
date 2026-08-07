//! Serving the web terminal.
//!
//! The built `store-web` bundle is embedded in this binary, so the product
//! ships as one file on one port. The door terminal is configured with a single
//! server address (§3); asking a shop to open and firewall a second one is a
//! support call waiting to happen, and a separate static-file server is one
//! more thing to forget to start after a power cut.
//!
//! Caching is split deliberately:
//!
//! * hashed assets (`/assets/index-a1b2c3.js`) are immutable — a new build is a
//!   new URL, so they can be cached forever;
//! * `index.html` and the service worker are **never** cached, because they are
//!   what tells a phone that a new build exists. Caching those is exactly how a
//!   PWA gets stuck on an old version.

use axum::body::Body;
use axum::extract::Path;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rust_embed::RustEmbed;
use serde::Serialize;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../store-web/dist"]
struct WebAssets;

/// Build metadata, reported to clients and used by the update check.
#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub version: &'static str,
    pub git_sha: &'static str,
    pub built_at: &'static str,
}

pub const VERSION: VersionInfo = VersionInfo {
    version: env!("CARGO_PKG_VERSION"),
    git_sha: env!("STORE_GIT_SHA"),
    built_at: env!("STORE_BUILT_AT"),
};

/// `GET /api/v1/version`
///
/// Unauthenticated on purpose: a device that cannot authenticate still needs to
/// be able to tell you what it is running when somebody is debugging it, and
/// the build version is not a secret.
pub async fn version() -> Json<VersionInfo> {
    Json(VERSION)
}

/// Routes for the web terminal. Stateless — it only serves embedded bytes.
pub fn router() -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/v1/version", get(version))
        .route("/{*path}", get(asset))
}

async fn index() -> Response {
    serve("index.html")
}

async fn asset(Path(path): Path<String>, uri: Uri) -> Response {
    // Anything under the API or the device protocol is not ours; let the other
    // routers 404 it rather than answering with the SPA shell.
    if uri.path().starts_with("/api/") || uri.path().starts_with("/iclock/") {
        return StatusCode::NOT_FOUND.into_response();
    }

    if WebAssets::get(&path).is_some() {
        return serve(&path);
    }

    // Single-page app: unknown paths are client-side routes, so hand back the
    // shell and let the app decide. A missing *asset* still has to 404 — a
    // script tag that silently receives HTML produces a mystifying error.
    if path.contains('.') {
        return StatusCode::NOT_FOUND.into_response();
    }
    serve("index.html")
}

fn serve(path: &str) -> Response {
    let Some(file) = WebAssets::get(path) else {
        return not_built();
    };

    let mime = mime_guess::from_path(path).first_or_octet_stream();

    let cache = if path == "index.html" || path == "sw.js" || path == "registerSW.js" {
        // Never cached: these are how a device learns a new build exists.
        "no-cache, no-store, must-revalidate"
    } else if path.starts_with("assets/") {
        // Content-hashed by Vite, so the URL changes when the content does.
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };

    let mut response = Response::builder()
        .header(header::CONTENT_TYPE, mime.as_ref())
        .header(header::CACHE_CONTROL, HeaderValue::from_static(cache))
        .body(Body::from(file.data.into_owned()))
        .expect("static response is well-formed");

    // Lets the browser revalidate cheaply on the paths that are not immutable.
    let digest = file.metadata.sha256_hash();
    let etag: String = std::iter::once('"')
        .chain(
            digest
                .iter()
                .take(8)
                .flat_map(|b| format!("{b:02x}").chars().collect::<Vec<_>>()),
        )
        .chain(std::iter::once('"'))
        .collect();
    if let Ok(value) = HeaderValue::from_str(&etag) {
        response.headers_mut().insert(header::ETAG, value);
    }

    response
}

/// What to say when the bundle was never built.
///
/// A blank page would send somebody hunting through logs; this says exactly
/// which command is missing. `store-server` is deliberately still usable
/// without the UI — the ADMS listener and the REST API do not depend on it.
fn not_built() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        "<!doctype html><meta charset=utf-8><title>ElectronIx Tool Store</title>\
         <body style=\"font-family:system-ui;background:#020617;color:#e2e8f0;padding:2rem\">\
         <h1>Web terminal not built</h1>\
         <p>The API and the door listener are running, but no UI bundle is embedded \
         in this binary.</p>\
         <pre style=\"background:#0f172a;padding:1rem;border-radius:.5rem\">\
cd crates/store-web &amp;&amp; npm ci &amp;&amp; npm run build\ncargo build -p store-server</pre>\
         </body>",
    )
        .into_response()
}
