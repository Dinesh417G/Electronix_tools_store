//! The `store-server` binary — runs on the store's server PC.

use std::net::SocketAddr;
use std::time::Duration;

use clap::Parser;
use tower_http::trace::TraceLayer;

#[derive(Debug, Parser)]
#[command(name = "store-server", about = "ElectronIx Tool Store server")]
struct Args {
    /// Postgres connection string.
    #[arg(long, env = "DATABASE_URL")]
    database_url: String,

    /// Address to listen on. The door terminal is configured to push here, and
    /// the tablets talk to the same port.
    #[arg(long, env = "STORE_LISTEN", default_value = "0.0.0.0:8080")]
    listen: SocketAddr,

    /// Pool size. Must comfortably exceed the number of tablets: the ADMS
    /// handler waiting on a pool slot means a slow response, and a slow
    /// response makes the terminal retry and duplicate records (§9.2).
    #[arg(long, env = "STORE_DB_POOL", default_value_t = 16)]
    db_pool: u32,

    /// How often to expire stale claims and close idle sessions (§10).
    #[arg(long, env = "STORE_REAP_SECS", default_value_t = 10)]
    reap_secs: u64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let args = Args::parse();

    let state = store_server::bootstrap(&args.database_url, args.db_pool).await?;
    tracing::info!("database ready, migrations applied");

    // Surface drift at boot rather than leaving it to be discovered by someone
    // counting a bin six months from now (§7).
    match store_db::ledger::reconcile(&state.pool).await {
        Ok(drift) if drift.is_empty() => tracing::info!("ledger reconciled: no drift"),
        Ok(drift) => tracing::error!(
            items = drift.len(),
            "LEDGER DRIFT DETECTED — run `store-cli reconcile` for detail"
        ),
        Err(err) => tracing::error!(?err, "could not reconcile ledger"),
    }

    let (router, source) = store_server::app(state.clone());

    store_server::state::spawn_identity_consumer(state.clone(), source);
    store_server::state::spawn_session_reaper(state, Duration::from_secs(args.reap_secs));

    let app = router.layer(TraceLayer::new_for_http());
    let listener = tokio::net::TcpListener::bind(args.listen).await?;

    tracing::info!(addr = %args.listen, "store-server listening");
    tracing::info!("ADMS endpoint: http://{}/iclock/cdata", args.listen);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

/// Finish in-flight requests before exiting. An ADMS push cut off mid-persist
/// would be retried by the device, but a clean stop is one fewer duplicate to
/// reason about.
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}
