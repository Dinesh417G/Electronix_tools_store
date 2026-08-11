//! `store-cli seed` — a demo store you can walk through without hardware.
//!
//! Idempotent, so re-running it on a demo database is harmless. The catalog
//! itself lives in `catalog/demo-catalog.csv` (see [`crate::catalog`]) so it
//! can be edited without touching Rust.
//!
//! This is for demos and development. A real store is commissioned with
//! `store-cli operator add` and a catalog somebody actually counted — see
//! COMMISSIONING.md.

use std::collections::HashMap;

use anyhow::{Context, Result};
use rust_decimal::Decimal;
use sqlx::PgPool;
use store_core::ledger::{Movement, Qty};
use uuid::Uuid;

use crate::catalog::{self, CatalogRow};

pub async fn run(pool: &PgPool, with_stock: bool) -> Result<()> {
    let rows = catalog::parse(catalog::DEMO_CATALOG).context("the built-in demo catalog")?;

    let categories = seed_categories(pool, &catalog::categories(&rows)).await?;
    let operators = seed_operators(pool).await?;
    let machines = seed_machines(pool).await?;
    let items = seed_items(pool, &rows, &categories).await?;

    let mut opening_rows = 0usize;
    if with_stock {
        // Opening balances, booked as OPENING rows — §7, everything that moves
        // stock is a ledger row, including "what was in the bins on day one".
        let storekeeper = operators.storekeeper;
        for (item_id, qty) in &items {
            store_db::ledger::record(
                pool,
                &store_db::ledger::NewMovement {
                    movement: Movement::opening(*item_id, Qty::new(*qty)?),
                    operator_id: storekeeper,
                    session_id: None,
                    machine_id: None,
                    reason_id: None,
                    note: Some("seeded opening balance".into()),
                    unit_cost: None,
                    device_ts: None,
                    client_txn_uuid: None,
                },
            )
            .await?;
            opening_rows += 1;
        }
    }

    report(pool, rows.len(), categories.len(), machines, opening_rows).await?;

    Ok(())
}

async fn report(
    pool: &PgPool,
    items: usize,
    categories: usize,
    machines: usize,
    opening_rows: usize,
) -> Result<()> {
    println!(
        "Seeded: {items} items across {categories} categories, 4 operators, {machines} machines."
    );
    if opening_rows > 0 {
        println!("        {opening_rows} opening balance(s) booked as OPENING ledger rows.");
    }

    // The demo is only useful if the alert console has something in it, so say
    // what state the store is actually in rather than leaving it to be found.
    let stock = sqlx::query!(
        r#"
        select alert_state as "alert_state!", count(*) as "n!"
          from item_stock group by alert_state
        "#
    )
    .fetch_all(pool)
    .await?;

    let counts: HashMap<String, i64> = stock
        .into_iter()
        .map(|r| (r.alert_state, r.n))
        .collect::<HashMap<_, _>>();

    println!();
    println!(
        "Stock: {} OK, {} LOW, {} EMPTY",
        counts.get("OK").copied().unwrap_or(0),
        counts.get("LOW").copied().unwrap_or(0),
        counts.get("EMPTY").copied().unwrap_or(0),
    );

    println!();
    println!("Demo logins (emp code / PIN):");
    println!("  ADMIN        E9001 / 1111");
    println!("  STOREKEEPER  E5001 / 2222");
    println!("  OPERATOR     E1042 / 3333   (terminal user id 1042)");
    println!("  OPERATOR     E2077 / 4444   (terminal user id 2077)");
    println!();
    println!("Set STORE_ENROLMENT_SECRET before putting tablets on the wall.");
    println!("Edit crates/store-cli/catalog/demo-catalog.csv to change this catalog.");

    Ok(())
}

struct SeededOperators {
    storekeeper: Uuid,
}

async fn seed_operators(pool: &PgPool) -> Result<SeededOperators> {
    let people = [
        ("E9001", "S. Rao", Some("9001"), "ADMIN", "1111"),
        ("E5001", "M. Iyer", Some("5001"), "STOREKEEPER", "2222"),
        ("E1042", "R. Kumar", Some("1042"), "OPERATOR", "3333"),
        ("E2077", "A. Singh", Some("2077"), "OPERATOR", "4444"),
    ];

    let mut storekeeper = Uuid::nil();

    for (emp_code, name, zk, role, pin) in people {
        let hash = store_db::auth::hash_pin(pin)?;
        let id = sqlx::query_scalar!(
            r#"
            insert into operators (emp_code, full_name, zk_user_id, role, pin_hash)
            values ($1, $2, $3, $4, $5)
            on conflict (emp_code) do update
               set full_name = excluded.full_name, role = excluded.role
            returning id
            "#,
            emp_code,
            name,
            zk,
            role,
            hash,
        )
        .fetch_one(pool)
        .await?;

        if role == "STOREKEEPER" {
            storekeeper = id;
        }
    }

    Ok(SeededOperators { storekeeper })
}

/// Returns how many machines the demo shop has.
///
/// A spread of machine types, because consumption-by-machine (§11) is only an
/// interesting report when the machines differ — a lathe and a VMC do not eat
/// the same tools.
async fn seed_machines(pool: &PgPool) -> Result<usize> {
    let machines = [
        ("VMC-01", "Vertical machining centre 1 - Haas VF2"),
        ("VMC-02", "Vertical machining centre 2 - Haas VF3"),
        ("VMC-03", "Vertical machining centre 3 - Jyoti VMC640"),
        ("CNC-L1", "CNC turning centre 1 - Ace Jobber XL"),
        ("CNC-L2", "CNC turning centre 2 - Ace Super Jobber"),
        ("HMC-01", "Horizontal machining centre - Makino a51"),
        ("SG-01", "Surface grinder"),
        ("EDM-01", "Wire EDM"),
        ("DRL-01", "Radial drilling machine"),
    ];

    for (code, name) in machines {
        sqlx::query!(
            "insert into machines (code, name) values ($1, $2)
             on conflict (code) do update set name = excluded.name",
            code,
            name
        )
        .execute(pool)
        .await?;
    }

    Ok(machines.len())
}

/// Create the categories the catalog refers to, in file order.
async fn seed_categories(pool: &PgPool, names: &[String]) -> Result<HashMap<String, Uuid>> {
    let mut out = HashMap::new();

    for (index, name) in names.iter().enumerate() {
        // Ten apart, so a category can be slipped between two later without
        // renumbering the rest.
        let sort = (index as i32 + 1) * 10;
        let id = sqlx::query_scalar!(
            "insert into item_categories (name, sort_order) values ($1, $2)
             on conflict (name) do update set sort_order = excluded.sort_order
             returning id",
            name,
            sort
        )
        .fetch_one(pool)
        .await?;
        out.insert(name.clone(), id);
    }

    Ok(out)
}

/// Insert the catalog. Returns `(item_id, opening_qty)` for items that need an
/// opening balance booked.
async fn seed_items(
    pool: &PgPool,
    rows: &[CatalogRow],
    categories: &HashMap<String, Uuid>,
) -> Result<Vec<(Uuid, Decimal)>> {
    let mut out = Vec::new();

    for row in rows {
        let category_id = categories
            .get(&row.category)
            .copied()
            .with_context(|| format!("{}: unknown category {}", row.item_code, row.category))?;

        let id = sqlx::query_scalar!(
            r#"
            insert into items (
                item_code, description, category_id, uom, iso_code, grade,
                manufacturer, mfr_part_no, diameter_mm, flutes, reorder_level,
                reorder_qty, bin_location, unit_cost
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
            on conflict (item_code) do update set
                description   = excluded.description,
                category_id   = excluded.category_id,
                uom           = excluded.uom,
                iso_code      = excluded.iso_code,
                grade         = excluded.grade,
                manufacturer  = excluded.manufacturer,
                mfr_part_no   = excluded.mfr_part_no,
                diameter_mm   = excluded.diameter_mm,
                flutes        = excluded.flutes,
                reorder_level = excluded.reorder_level,
                reorder_qty   = excluded.reorder_qty,
                bin_location  = excluded.bin_location,
                unit_cost     = excluded.unit_cost
            returning id
            "#,
            row.item_code,
            row.description,
            category_id,
            row.uom,
            row.iso_code,
            row.grade,
            row.manufacturer,
            row.mfr_part_no,
            row.diameter_mm,
            row.flutes,
            row.reorder_level,
            row.reorder_qty,
            row.bin_location,
            row.unit_cost,
        )
        .fetch_one(pool)
        .await?;

        // A vendor's own printed barcode, so scanning the box the inserts came
        // in resolves to our item without relabelling it (§6, `item_barcodes`).
        if let Some(barcode) = row.barcode.as_deref() {
            sqlx::query!(
                "insert into item_barcodes (item_id, code, kind)
                 values ($1, $2, 'MFR_EAN')
                 on conflict (code) do nothing",
                id,
                barcode
            )
            .execute(pool)
            .await?;
        }

        // Only book opening stock for genuinely new items; re-running the seed
        // must not keep adding balance.
        let already = sqlx::query_scalar!(
            r#"select count(*) as "n!" from stock_ledger where item_id = $1"#,
            id
        )
        .fetch_one(pool)
        .await?;

        // A zero opening books nothing: §7 forbids a zero delta, and "the bin
        // is empty" is not a movement. The item still shows on the stock views
        // at zero, because every item gets a stock row at birth.
        if already == 0 && !row.opening_qty.is_zero() {
            out.push((id, row.opening_qty));
        }
    }

    Ok(out)
}
