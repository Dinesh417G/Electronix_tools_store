//! `store-cli reconcile` and `store-cli export`.

use std::path::Path;

use anyhow::{Context, Result};
use chrono::{NaiveDate, TimeZone, Utc};
use sqlx::PgPool;

/// Recompute every balance from the ledger and report drift.
///
/// §7: `item_stock.on_hand` is a cached read model. This is the check that
/// keeps it trustworthy, and **any drift is a bug** — not something to be
/// corrected by hand and forgotten. Exits non-zero so a nightly cron notices.
pub async fn run(pool: &PgPool, verbose: bool) -> Result<()> {
    let drift = store_db::ledger::reconcile(pool).await?;

    if verbose {
        let rows = sqlx::query!(
            r#"
            select i.item_code, s.on_hand, s.alert_state,
                   coalesce(sum(l.delta_qty), 0) as "ledger_sum!"
              from item_stock s
              join items i on i.id = s.item_id
              left join stock_ledger l on l.item_id = s.item_id
             group by i.item_code, s.on_hand, s.alert_state
             order by i.item_code
            "#
        )
        .fetch_all(pool)
        .await?;

        println!("{:<28} {:>14} {:>14}  STATE", "ITEM", "CACHED", "LEDGER");
        for r in &rows {
            println!(
                "{:<28} {:>14} {:>14}  {}",
                r.item_code, r.on_hand, r.ledger_sum, r.alert_state
            );
        }
        println!();
    }

    if drift.is_empty() {
        println!("reconcile: no drift. item_stock agrees with the ledger.");
        return Ok(());
    }

    eprintln!(
        "reconcile: {} item(s) DRIFTED — this is a bug (§7)\n",
        drift.len()
    );
    eprintln!(
        "{:<28} {:>14} {:>14} {:>14}",
        "ITEM", "CACHED", "LEDGER", "DIFF "
    );
    for d in &drift {
        eprintln!(
            "{:<28} {:>14} {:>14} {:>14}",
            d.item_code,
            d.cached_on_hand,
            d.ledger_sum,
            d.difference()
        );
    }

    // Non-zero, so a nightly check fails loudly rather than logging quietly.
    std::process::exit(1);
}

/// Export the ledger as CSV.
///
/// Filtered on `created_at` — what the server observed — never on `device_ts`
/// (§9.3), so a drifting terminal clock cannot move rows between periods.
pub async fn export(
    pool: &PgPool,
    out: &Path,
    from: Option<String>,
    to: Option<String>,
) -> Result<()> {
    let from = from.as_deref().map(parse_date).transpose()?;
    let to = to.as_deref().map(parse_date).transpose()?;

    let rows = store_db::ledger::list(
        pool,
        &store_db::ledger::LedgerFilter {
            from,
            to,
            limit: 1000,
            ..Default::default()
        },
    )
    .await?;

    // Paginate rather than trusting one page: an export that silently stopped
    // at 1000 rows would be worse than no export.
    let mut all = rows;
    let mut offset = all.len() as i64;
    loop {
        let page = store_db::ledger::list(
            pool,
            &store_db::ledger::LedgerFilter {
                from,
                to,
                limit: 1000,
                offset,
                ..Default::default()
            },
        )
        .await?;
        if page.is_empty() {
            break;
        }
        offset += page.len() as i64;
        all.extend(page);
    }

    let mut csv = String::from(
        "id,created_at,item_code,description,txn_type,delta_qty,unit_cost,\
         operator,machine,reason,session_id,reverses_id,note\n",
    );

    for r in &all {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{},{},{},{}\n",
            r.id,
            r.created_at.to_rfc3339(),
            quote(&r.item_code),
            quote(&r.description),
            r.txn_type,
            r.delta_qty,
            r.unit_cost.map(|c| c.to_string()).unwrap_or_default(),
            quote(&r.operator_name),
            quote(r.machine_code.as_deref().unwrap_or("")),
            quote(r.reason_code.as_deref().unwrap_or("")),
            r.session_id.map(|s| s.to_string()).unwrap_or_default(),
            r.reverses_id.map(|s| s.to_string()).unwrap_or_default(),
            quote(r.note.as_deref().unwrap_or("")),
        ));
    }

    std::fs::write(out, csv).with_context(|| format!("could not write {}", out.display()))?;

    println!("exported {} ledger rows to {}", all.len(), out.display());
    Ok(())
}

/// RFC 4180 quoting. Tool descriptions contain commas often enough that
/// skipping this would corrupt the file within a week.
fn quote(field: &str) -> String {
    format!("\"{}\"", field.replace('"', "\"\""))
}

fn parse_date(raw: &str) -> Result<chrono::DateTime<Utc>> {
    let date = NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .with_context(|| format!("{raw:?} is not a YYYY-MM-DD date"))?;
    Ok(Utc.from_utc_datetime(&date.and_hms_opt(0, 0, 0).expect("midnight exists")))
}
