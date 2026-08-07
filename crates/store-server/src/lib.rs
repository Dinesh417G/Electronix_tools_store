//! `store-server` — the service on the store's server PC (CLAUDE.md §1).
//!
//! Composes four things:
//!
//! * the ADMS listener (`store-adms`), which the door terminal pushes to;
//! * the session claim machine (`store-core`), driven off an `IdentitySource`;
//! * the ledger (`store-db`), which is the only thing that decides stock;
//! * the REST + SSE API the tablets and the admin app talk to.
//!
//! Exposed as a library as well as a binary so integration tests can build the
//! whole thing in-process, against a throwaway Postgres and a
//! `MockIdentitySource` — §14: no test may require the physical door terminal.

#![forbid(unsafe_code)]

pub mod api;
pub mod auth;
pub mod config;
pub mod error;
pub mod events;
pub mod state;

use std::sync::Arc;

use axum::Router;
use sqlx::PgPool;
use store_adms::routes::AdmsState;
use store_core::identity::IdentitySource;

pub use state::{AppState, DbPunchSink};

/// Build the full application: the API and the `/iclock/*` listener on one
/// router.
///
/// They share a port because the terminal is configured with a single server
/// address, and asking a shop to open two is a support call waiting to happen.
pub fn app(state: AppState) -> (Router, Arc<dyn IdentitySource>) {
    let sink = Arc::new(DbPunchSink::new(state.pool.clone()));
    let adms = AdmsState {
        sink,
        source: Arc::new(store_adms::AdmsIdentitySource::new("adms")),
        commands: state.commands.clone(),
    };
    let source: Arc<dyn IdentitySource> = adms.source.clone();

    let router = Router::new()
        .merge(api::router(state))
        .merge(store_adms::router(adms));

    (router, source)
}

/// Connect, migrate and build state.
pub async fn bootstrap(database_url: &str, max_connections: u32) -> anyhow::Result<AppState> {
    let pool: PgPool = store_db::connect(database_url, max_connections).await?;
    store_db::migrate(&pool).await?;
    Ok(AppState::new(pool))
}
