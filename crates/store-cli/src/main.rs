//! `store-cli` — seed, reconcile, export and device probe (CLAUDE.md §5).

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

mod probe;
mod reconcile;
mod seed;

#[derive(Debug, Parser)]
#[command(name = "store-cli", about = "ElectronIx Tool Store operations tool")]
struct Cli {
    #[arg(long, env = "DATABASE_URL", global = true)]
    database_url: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Load demo catalog, operators and machines for a walkthrough.
    Seed {
        /// Also book opening stock, so the demo has something to issue.
        #[arg(long, default_value_t = true)]
        with_stock: bool,
    },

    /// Recompute every balance from the ledger and report drift.
    ///
    /// §7: any drift is a bug, not a data-entry problem. Exits non-zero when it
    /// finds some, so it can be wired into a nightly check.
    Reconcile {
        /// Print every item, not only the ones that disagree.
        #[arg(long)]
        verbose: bool,
    },

    /// Export the ledger as CSV.
    Export {
        #[arg(long)]
        out: PathBuf,
        /// Inclusive start date, `YYYY-MM-DD`.
        #[arg(long)]
        from: Option<String>,
        /// Exclusive end date, `YYYY-MM-DD`.
        #[arg(long)]
        to: Option<String>,
    },

    /// Listen as an ADMS host and dump every raw request to disk.
    ///
    /// §9 requires this before the protocol notes are trusted: point a real
    /// terminal at it, capture the traffic, and reconcile CLAUDE.md against
    /// what the firmware actually sends.
    DeviceProbe {
        #[arg(long, default_value_t = 8080)]
        listen: u16,
        /// Directory for the capture. Kept as a CI fixture afterwards (§14).
        #[arg(long, default_value = "adms-capture")]
        out_dir: PathBuf,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let cli = Cli::parse();

    // device-probe deliberately needs no database: the whole point is to run it
    // against a terminal before anything else is set up.
    if let Command::DeviceProbe { listen, out_dir } = &cli.command {
        return probe::run(*listen, out_dir.clone()).await;
    }

    let database_url = cli
        .database_url
        .context("DATABASE_URL is not set (pass --database-url)")?;
    let pool = store_db::connect(&database_url, 4).await?;

    match cli.command {
        Command::Seed { with_stock } => seed::run(&pool, with_stock).await,
        Command::Reconcile { verbose } => reconcile::run(&pool, verbose).await,
        Command::Export { out, from, to } => reconcile::export(&pool, &out, from, to).await,
        Command::DeviceProbe { .. } => unreachable!("handled above"),
    }
}
