//! `store-cli seed` — a demo store you can walk through without hardware.
//!
//! Idempotent, so re-running it on a demo database is harmless.

use anyhow::Result;
use rust_decimal::Decimal;
use sqlx::PgPool;
use store_core::ledger::{Movement, Qty};
use uuid::Uuid;

pub async fn run(pool: &PgPool, with_stock: bool) -> Result<()> {
    let categories = seed_categories(pool).await?;
    let operators = seed_operators(pool).await?;
    seed_machines(pool).await?;
    let items = seed_items(pool, &categories).await?;

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
        }
    }

    println!("Seeded: {} items, 3 operators, 4 machines.", items.len());
    println!();
    println!("Demo logins (emp code / PIN):");
    println!("  ADMIN        E9001 / 1111");
    println!("  STOREKEEPER  E5001 / 2222");
    println!("  OPERATOR     E1042 / 3333   (terminal user id 1042)");
    println!();
    println!("Set STORE_ENROLMENT_SECRET before putting tablets on the wall.");

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

async fn seed_machines(pool: &PgPool) -> Result<()> {
    for (code, name) in [
        ("VMC-01", "Vertical machining centre 1"),
        ("VMC-02", "Vertical machining centre 2"),
        ("CNC-L1", "CNC lathe 1"),
        ("CNC-L2", "CNC lathe 2"),
    ] {
        sqlx::query!(
            "insert into machines (code, name) values ($1, $2)
             on conflict (code) do nothing",
            code,
            name
        )
        .execute(pool)
        .await?;
    }
    Ok(())
}

struct Categories {
    turning_inserts: Uuid,
    milling: Uuid,
    drilling: Uuid,
    consumables: Uuid,
}

async fn seed_categories(pool: &PgPool) -> Result<Categories> {
    async fn one(pool: &PgPool, name: &str, sort: i32) -> Result<Uuid> {
        Ok(sqlx::query_scalar!(
            "insert into item_categories (name, sort_order) values ($1, $2)
             on conflict (name) do update set sort_order = excluded.sort_order
             returning id",
            name,
            sort
        )
        .fetch_one(pool)
        .await?)
    }

    Ok(Categories {
        turning_inserts: one(pool, "Turning inserts", 10).await?,
        milling: one(pool, "Milling tools", 20).await?,
        drilling: one(pool, "Drills and taps", 30).await?,
        consumables: one(pool, "Consumables", 40).await?,
    })
}

/// Returns `(item_id, opening_qty)`.
async fn seed_items(pool: &PgPool, cats: &Categories) -> Result<Vec<(Uuid, Decimal)>> {
    struct Seed {
        code: &'static str,
        description: &'static str,
        category: Uuid,
        uom: &'static str,
        iso: Option<&'static str>,
        grade: Option<&'static str>,
        manufacturer: Option<&'static str>,
        diameter: Option<Decimal>,
        flutes: Option<i32>,
        reorder_level: Decimal,
        reorder_qty: Option<Decimal>,
        bin: &'static str,
        cost: Decimal,
        opening: Decimal,
    }

    let d = Decimal::from;

    let seeds = vec![
        Seed {
            code: "CNMG120408-TN2000",
            description: "CNMG 120408 turning insert, medium roughing",
            category: cats.turning_inserts,
            uom: "NOS",
            iso: Some("CNMG120408"),
            grade: Some("TN2000"),
            manufacturer: Some("Taegutec"),
            diameter: None,
            flutes: None,
            reorder_level: d(20),
            reorder_qty: Some(d(100)),
            bin: "A-01-1",
            cost: Decimal::new(12050, 2),
            opening: d(120),
        },
        Seed {
            code: "DNMG150608-TT5100",
            description: "DNMG 150608 turning insert, finishing",
            category: cats.turning_inserts,
            uom: "NOS",
            iso: Some("DNMG150608"),
            grade: Some("TT5100"),
            manufacturer: Some("Taegutec"),
            diameter: None,
            flutes: None,
            reorder_level: d(15),
            reorder_qty: Some(d(50)),
            bin: "A-01-2",
            cost: Decimal::new(14500, 2),
            opening: d(60),
        },
        Seed {
            code: "EM-06-4F-TIALN",
            description: "6mm 4-flute carbide end mill, TiAlN coated",
            category: cats.milling,
            uom: "NOS",
            iso: None,
            grade: None,
            manufacturer: Some("OSG"),
            diameter: Some(Decimal::new(6000, 3)),
            flutes: Some(4),
            reorder_level: d(5),
            reorder_qty: Some(d(20)),
            bin: "B-02-1",
            cost: Decimal::new(89000, 2),
            opening: d(18),
        },
        Seed {
            code: "EM-12-4F-TIALN",
            description: "12mm 4-flute carbide end mill, TiAlN coated",
            category: cats.milling,
            uom: "NOS",
            iso: None,
            grade: None,
            manufacturer: Some("OSG"),
            diameter: Some(Decimal::new(12000, 3)),
            flutes: Some(4),
            reorder_level: d(4),
            reorder_qty: Some(d(10)),
            bin: "B-02-2",
            cost: Decimal::new(178000, 2),
            opening: d(7),
        },
        Seed {
            code: "DR-8.5-HSS",
            description: "8.5mm HSS jobber drill",
            category: cats.drilling,
            uom: "NOS",
            iso: None,
            grade: None,
            manufacturer: Some("Addison"),
            diameter: Some(Decimal::new(8500, 3)),
            flutes: Some(2),
            reorder_level: d(10),
            reorder_qty: Some(d(25)),
            bin: "C-03-1",
            cost: Decimal::new(21000, 2),
            opening: d(30),
        },
        Seed {
            code: "TAP-M10-HSS",
            description: "M10 x 1.5 HSS machine tap",
            category: cats.drilling,
            uom: "NOS",
            iso: None,
            grade: None,
            manufacturer: Some("Totem"),
            diameter: Some(Decimal::new(10000, 3)),
            flutes: Some(3),
            reorder_level: d(6),
            reorder_qty: Some(d(12)),
            bin: "C-03-4",
            cost: Decimal::new(31500, 2),
            opening: d(8),
        },
        Seed {
            code: "COOL-SYN-20L",
            description: "Synthetic cutting coolant concentrate, 20 L",
            category: cats.consumables,
            uom: "LTR",
            iso: None,
            grade: None,
            manufacturer: Some("Houghton"),
            diameter: None,
            flutes: None,
            // Fractional, because coolant is drawn by the litre — this is the
            // reason quantities are numeric(12,3) rather than integers (§6).
            reorder_level: Decimal::new(40000, 3),
            reorder_qty: Some(d(200)),
            bin: "D-04-1",
            cost: Decimal::new(48000, 2),
            opening: Decimal::new(160500, 3),
        },
    ];

    let mut out = Vec::new();

    for s in seeds {
        let id = sqlx::query_scalar!(
            r#"
            insert into items (
                item_code, description, category_id, uom, iso_code, grade,
                manufacturer, diameter_mm, flutes, reorder_level, reorder_qty,
                bin_location, unit_cost
            )
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            on conflict (item_code) do update set description = excluded.description
            returning id
            "#,
            s.code,
            s.description,
            s.category,
            s.uom,
            s.iso,
            s.grade,
            s.manufacturer,
            s.diameter,
            s.flutes,
            s.reorder_level,
            s.reorder_qty,
            s.bin,
            s.cost,
        )
        .fetch_one(pool)
        .await?;

        // Only book opening stock for genuinely new items; re-running the seed
        // must not keep adding balance.
        let already = sqlx::query_scalar!(
            r#"select count(*) as "n!" from stock_ledger where item_id = $1"#,
            id
        )
        .fetch_one(pool)
        .await?;

        if already == 0 {
            out.push((id, s.opening));
        }
    }

    Ok(out)
}
