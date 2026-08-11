//! `store-cli` — seed, reconcile, export and device probe (CLAUDE.md §5).

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

mod backup;
mod catalog;
mod operator;
mod probe;
mod reconcile;
mod seed;
mod update;

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

    /// Create and manage people, from the server PC.
    ///
    /// §11 puts operator CRUD behind an `ADMIN` token, which needs an `ADMIN`
    /// operator to exist — so on a fresh database nobody can sign in and
    /// nothing can create the person who would. This is that first person.
    Operator {
        #[command(subcommand)]
        command: OperatorCommand,
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

    /// Take a verified `pg_dump`, then rotate old ones (M9).
    ///
    /// Restores the dump into a scratch database and re-sums the ledger there.
    /// A backup nobody has ever restored is a hope, not a backup.
    Backup {
        /// Where the dumps live. Defaults to the install layout for this
        /// platform; the systemd unit and the scheduled task both pass it
        /// explicitly anyway.
        #[arg(long, default_value = default_backup_dir())]
        out_dir: PathBuf,

        /// How many nightly dumps to keep.
        #[arg(long, default_value_t = 14)]
        keep: usize,

        /// Skip the restore-and-check step. Faster, and worth much less.
        #[arg(long)]
        no_verify: bool,
    },

    /// Check for, or apply, an over-the-air update (OTA).
    ///
    /// Updates the server binary. The web terminal needs no updater: it is
    /// embedded in that binary, so every phone and tablet picks up the new
    /// version on its next load.
    Update {
        /// Only report what is available; change nothing.
        #[arg(long, conflicts_with = "apply")]
        check: bool,

        /// Download, verify and install.
        #[arg(long)]
        apply: bool,

        /// Which binary to replace. Defaults to `store-server` next to this one.
        #[arg(long)]
        target: Option<PathBuf>,

        /// Reinstall even when the available version is not newer.
        #[arg(long)]
        force: bool,

        /// Override the release manifest URL (for a staging channel).
        #[arg(long, env = "STORE_UPDATE_MANIFEST")]
        manifest: Option<String>,
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

#[derive(Debug, Subcommand)]
enum OperatorCommand {
    /// Add somebody. Use this once at commissioning to create the first ADMIN.
    Add {
        #[arg(long)]
        emp_code: String,

        #[arg(long)]
        name: String,

        /// OPERATOR | STOREKEEPER | ADMIN.
        #[arg(long, default_value = "OPERATOR")]
        role: String,

        /// The user id programmed into the door terminal. Without it their
        /// punch cannot be matched to them (§6).
        #[arg(long)]
        zk_user_id: Option<String>,

        #[arg(long)]
        department: Option<String>,

        /// Needed for ADMIN and STOREKEEPER, who sign in to the console.
        /// Omit it and the PIN is read from stdin instead — a PIN passed here
        /// is visible in shell history and in `ps`.
        #[arg(long)]
        pin: Option<String>,
    },

    /// Set somebody's PIN — a forgotten one, or the first for a promotion.
    SetPin {
        #[arg(long)]
        emp_code: String,

        /// Omit to read from stdin. See the note on `add --pin`.
        #[arg(long)]
        pin: Option<String>,
    },

    /// Show everybody, and flag anyone the door cannot recognise.
    List,
}

/// Where backups go when nobody says otherwise.
const fn default_backup_dir() -> &'static str {
    if cfg!(windows) {
        r"C:\ElectronIx\ToolStore\backups"
    } else {
        "/var/backups/electronix-store"
    }
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    match run().await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(err) => {
            // A storekeeper standing at the server PC needs a sentence, not a
            // Rust backtrace. The chain of causes is kept because that is the
            // part that says *why*; the frames are not.
            eprintln!("error: {err}");
            for cause in err.chain().skip(1) {
                eprintln!("  caused by: {cause}");
            }
            std::process::ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<()> {
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

    // Nor does update: a server too broken to reach its database is exactly the
    // one you most need to be able to update.
    if let Command::Update {
        check,
        apply,
        target,
        force,
        manifest,
    } = &cli.command
    {
        let url = manifest.as_deref().unwrap_or(update::DEFAULT_MANIFEST_URL);
        let current = env!("CARGO_PKG_VERSION");
        return if *apply {
            update::apply(url, current, target.clone(), *force).await
        } else {
            // Checking is the default: an update command that installs
            // something because you forgot a flag is a bad update command.
            let _ = check;
            update::check(url, current).await
        };
    }

    let database_url = cli
        .database_url
        .context("DATABASE_URL is not set (pass --database-url)")?;
    let pool = store_db::connect(&database_url, 4).await?;

    match cli.command {
        Command::Seed { with_stock } => seed::run(&pool, with_stock).await,
        Command::Backup {
            out_dir,
            keep,
            no_verify,
        } => {
            backup::run(
                &pool,
                &database_url,
                &backup::Options {
                    out_dir,
                    keep,
                    verify: !no_verify,
                },
            )
            .await
        }
        Command::Operator { command } => match command {
            OperatorCommand::Add {
                emp_code,
                name,
                role,
                zk_user_id,
                department,
                pin,
            } => {
                operator::add(
                    &pool,
                    operator::NewOperator {
                        emp_code,
                        name,
                        role,
                        zk_user_id,
                        department,
                        pin,
                    },
                )
                .await
            }
            OperatorCommand::SetPin { emp_code, pin } => {
                operator::set_pin(&pool, &emp_code, pin).await
            }
            OperatorCommand::List => operator::list(&pool).await,
        },
        Command::Reconcile { verbose } => reconcile::run(&pool, verbose).await,
        Command::Export { out, from, to } => reconcile::export(&pool, &out, from, to).await,
        Command::DeviceProbe { .. } | Command::Update { .. } => {
            unreachable!("handled above")
        }
    }
}
