//! `store-cli backup` — the nightly `pg_dump` (CLAUDE.md §13, M9).
//!
//! Three things separate this from a cron line that just calls `pg_dump`:
//!
//! * **It verifies.** A dump is restored into a scratch database and the ledger
//!   is re-summed there. A backup nobody has ever restored is a hope, not a
//!   backup, and the day you find out is the day you needed it.
//! * **It reconciles first.** §7 says any drift between `item_stock` and
//!   `SUM(delta_qty)` is a bug. Backing up a drifted database preserves the bug;
//!   the run is marked so somebody knows before they restore from it.
//! * **It rotates.** A disk that fills up stops the *server*, not just the
//!   backup — and on a shop-floor PC nobody is watching free space.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use chrono::Utc;
use sqlx::PgPool;

/// Where the dump goes and how many to keep.
#[derive(Debug, Clone)]
pub struct Options {
    pub out_dir: PathBuf,
    /// Dumps to keep. Two weeks of nightlies is the default — long enough to
    /// notice a problem that started on a Monday.
    pub keep: usize,
    /// Restore the dump into a scratch database and re-check the ledger.
    pub verify: bool,
}

pub async fn run(pool: &PgPool, database_url: &str, opts: &Options) -> Result<()> {
    std::fs::create_dir_all(&opts.out_dir)
        .with_context(|| format!("could not create {}", opts.out_dir.display()))?;

    // Reconcile before dumping, so the operator knows what they are preserving.
    let drift = store_db::ledger::reconcile(pool).await?;
    if drift.is_empty() {
        println!("ledger: reconciled, no drift");
    } else {
        // Not fatal — a drifted database is exactly the one you most want a
        // copy of — but the filename says so, loudly.
        eprintln!(
            "WARNING: {} item(s) have drifted (§7). The dump is still taken, \
             and its name is marked DRIFTED.",
            drift.len()
        );
        for d in drift.iter().take(10) {
            eprintln!(
                "  {:<28} cached {} vs ledger {}",
                d.item_code, d.cached_on_hand, d.ledger_sum
            );
        }
    }

    // The fidelity fingerprint, taken before the dump: a faithful restore has
    // to reproduce exactly this.
    let source = fingerprint(pool)
        .await
        .context("could not fingerprint the ledger")?;

    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let marker = if drift.is_empty() { "" } else { "-DRIFTED" };
    let path = opts
        .out_dir
        .join(format!("electronix-store-{stamp}{marker}.dump"));

    dump(database_url, &path)?;

    let size = std::fs::metadata(&path)
        .with_context(|| format!("{} vanished after pg_dump", path.display()))?
        .len();

    // A zero-length or absurdly small dump means pg_dump failed in a way that
    // still exited zero — it happens, usually a permissions problem.
    if size < 1024 {
        bail!(
            "{} is only {size} bytes — that is not a real dump",
            path.display()
        );
    }

    println!("dump:   {} ({} KiB)", path.display(), size / 1024);

    if opts.verify {
        verify(database_url, &path, &source).await?;
    }

    rotate(&opts.out_dir, opts.keep)?;

    Ok(())
}

/// Run `pg_dump` in custom format, which is what `pg_restore` wants and what
/// compresses.
fn dump(database_url: &str, path: &Path) -> Result<()> {
    let output = Command::new("pg_dump")
        .arg("--format=custom")
        .arg("--no-owner")
        .arg("--no-acl")
        .arg("--file")
        .arg(path)
        .arg(database_url)
        .output()
        .context("could not run pg_dump — is postgresql-client installed?")?;

    if !output.status.success() {
        bail!(
            "pg_dump failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    Ok(())
}

/// What a faithful restore has to reproduce.
///
/// Deliberately about the *ledger*, not about `item_stock`: the ledger is what
/// actually happened, and the cached balance is derived from it. A backup that
/// preserves the ledger preserves the store.
#[derive(Debug, PartialEq, Eq)]
struct Fingerprint {
    rows: i64,
    /// Sum of every delta, as text — the exact numeric, not a float.
    total_delta: String,
    highest_id: i64,
}

async fn fingerprint(pool: &PgPool) -> Result<Fingerprint> {
    let row: (i64, String, i64) = sqlx::query_as(
        r#"
        select count(*)::bigint,
               coalesce(sum(delta_qty), 0)::text,
               coalesce(max(id), 0)::bigint
          from stock_ledger
        "#,
    )
    .fetch_one(pool)
    .await?;

    Ok(Fingerprint {
        rows: row.0,
        total_delta: row.1,
        highest_id: row.2,
    })
}

/// Restore into a scratch database and check the copy against the original.
///
/// This is the step that turns a file into a backup. It costs a few seconds a
/// night and it is the only thing that can tell you the dump is restorable
/// *before* the morning you need it to be.
///
/// Note what it does **not** do: re-judge drift. If the source database has
/// drifted, a faithful restore reproduces that drift exactly, and refusing to
/// back it up would deny you a copy of precisely the database you most need one
/// of. Drift is reported above and marked in the filename; verification is
/// about fidelity.
async fn verify(database_url: &str, path: &Path, source: &Fingerprint) -> Result<()> {
    let scratch = format!("electronix_verify_{}", Utc::now().timestamp());
    let admin_url = base_url(database_url, "postgres");
    let scratch_url = base_url(database_url, &scratch);

    let admin = sqlx::PgPool::connect(&admin_url)
        .await
        .context("could not connect to the postgres database to create a scratch copy")?;

    sqlx::query(&format!(r#"create database "{scratch}""#))
        .execute(&admin)
        .await
        .context("could not create the scratch database")?;

    // Whatever happens next, drop the scratch database.
    let result = verify_into(&scratch_url, path, source).await;

    let _ = sqlx::query(&format!(
        r#"drop database if exists "{scratch}" with (force)"#
    ))
    .execute(&admin)
    .await;
    admin.close().await;

    result
}

async fn verify_into(scratch_url: &str, path: &Path, source: &Fingerprint) -> Result<()> {
    let output = Command::new("pg_restore")
        .arg("--no-owner")
        .arg("--no-acl")
        .arg("--dbname")
        .arg(scratch_url)
        .arg(path)
        .output()
        .context("could not run pg_restore")?;

    if !output.status.success() {
        bail!(
            "pg_restore failed — the dump is not restorable: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let pool = sqlx::PgPool::connect(scratch_url)
        .await
        .context("could not connect to the restored copy")?;

    let restored = fingerprint(&pool)
        .await
        .context("the restored copy has no usable stock_ledger")?;
    pool.close().await;

    if &restored != source {
        bail!(
            "the restored copy does not match the original — the dump is not trustworthy.\n  \
             original: {source:?}\n  restored: {restored:?}"
        );
    }

    println!(
        "verify: restored and matched the original ({} ledger rows, net {})",
        restored.rows, restored.total_delta
    );
    Ok(())
}

/// Swap the database name in a connection URL.
fn base_url(database_url: &str, database: &str) -> String {
    match database_url.rsplit_once('/') {
        Some((prefix, tail)) => {
            // Keep any query string (sslmode, and so on).
            let query = tail.split_once('?').map(|(_, q)| q);
            match query {
                Some(q) => format!("{prefix}/{database}?{q}"),
                None => format!("{prefix}/{database}"),
            }
        }
        None => format!("{database_url}/{database}"),
    }
}

/// Delete all but the newest `keep` dumps.
///
/// Drifted dumps are kept alongside clean ones rather than preferred or
/// discarded: they are evidence, and rotation should not be the thing that
/// decides which evidence survives.
fn rotate(dir: &Path, keep: usize) -> Result<()> {
    let mut dumps: Vec<PathBuf> = std::fs::read_dir(dir)
        .with_context(|| format!("could not read {}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|e| e == "dump")
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("electronix-store-"))
        })
        .collect();

    // Filenames are timestamped, so a lexical sort is a chronological one — and
    // it does not depend on mtime, which a copy or a restore would rewrite.
    dumps.sort();

    if dumps.len() <= keep {
        println!("keep:   {} dump(s), keeping {keep}", dumps.len());
        return Ok(());
    }

    let doomed = dumps.len() - keep;
    for path in dumps.iter().take(doomed) {
        std::fs::remove_file(path)
            .with_context(|| format!("could not delete {}", path.display()))?;
        println!("rotate: removed {}", path.display());
    }

    println!("keep:   {keep} dump(s)");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_database_name_is_swapped_without_losing_the_rest() {
        assert_eq!(
            base_url("postgres://user:pw@host:5432/electronix_store", "scratch"),
            "postgres://user:pw@host:5432/scratch"
        );
        assert_eq!(
            base_url(
                "postgres://localhost/electronix_store?sslmode=require",
                "scratch"
            ),
            "postgres://localhost/scratch?sslmode=require"
        );
    }

    #[test]
    fn rotation_keeps_the_newest_and_deletes_the_rest() {
        let dir = std::env::temp_dir().join(format!("store-backup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Timestamped names sort chronologically.
        for stamp in [
            "20260801-020000",
            "20260802-020000",
            "20260803-020000",
            "20260804-020000",
        ] {
            std::fs::write(dir.join(format!("electronix-store-{stamp}.dump")), b"x").unwrap();
        }
        // Something else in the directory must survive untouched.
        std::fs::write(dir.join("notes.txt"), b"keep me").unwrap();

        rotate(&dir, 2).unwrap();

        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();

        assert_eq!(
            left,
            vec![
                "electronix-store-20260803-020000.dump".to_owned(),
                "electronix-store-20260804-020000.dump".to_owned(),
                "notes.txt".to_owned(),
            ]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rotation_is_a_no_op_when_there_is_nothing_to_remove() {
        let dir = std::env::temp_dir().join(format!("store-backup-few-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("electronix-store-20260801-020000.dump"), b"x").unwrap();

        rotate(&dir, 14).unwrap();

        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_drifted_dump_is_still_rotated_like_any_other() {
        // Drift marks the filename; it must not change which files survive.
        let dir =
            std::env::temp_dir().join(format!("store-backup-drift-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("electronix-store-20260801-020000.dump"), b"x").unwrap();
        std::fs::write(
            dir.join("electronix-store-20260802-020000-DRIFTED.dump"),
            b"x",
        )
        .unwrap();
        std::fs::write(dir.join("electronix-store-20260803-020000.dump"), b"x").unwrap();

        rotate(&dir, 2).unwrap();

        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left.len(), 2);
        assert!(left.iter().any(|n| n.contains("DRIFTED")), "{left:?}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
