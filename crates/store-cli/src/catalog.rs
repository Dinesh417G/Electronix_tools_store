//! The demo catalog, and the small parser that reads it.
//!
//! The catalog lives in `catalog/demo-catalog.csv` rather than in Rust
//! literals, for one reason: somebody who wants a different demo — their own
//! item codes, their own bins — should be able to edit a spreadsheet and re-run
//! `store-cli seed`, not learn `Decimal::new(12050, 2)`.
//!
//! It is embedded with `include_str!`, so a released binary carries its own
//! demo and needs no data files beside it.
//!
//! This is deliberately *not* a general CSV reader. It rejects quoted fields
//! and embedded commas rather than half-supporting them, because a catalog
//! parser that silently mis-splits a row is how an item ends up with the wrong
//! reorder level and nobody notices until the bin is empty.

use anyhow::{bail, Context, Result};
use rust_decimal::Decimal;

/// The demo catalog, compiled in.
pub const DEMO_CATALOG: &str = include_str!("../catalog/demo-catalog.csv");

/// Column order. Changing this without changing the file is a bug, so the
/// header is checked against it at parse time.
const COLUMNS: [&str; 16] = [
    "item_code",
    "description",
    "category",
    "uom",
    "iso_code",
    "grade",
    "manufacturer",
    "mfr_part_no",
    "diameter_mm",
    "flutes",
    "reorder_level",
    "reorder_qty",
    "bin_location",
    "unit_cost",
    "opening_qty",
    "barcode",
];

/// §6 allows these. A typo in the file should be refused, not stored.
const UOMS: [&str; 5] = ["NOS", "SET", "BOX", "LTR", "KG"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogRow {
    pub item_code: String,
    pub description: String,
    pub category: String,
    pub uom: String,
    pub iso_code: Option<String>,
    pub grade: Option<String>,
    pub manufacturer: Option<String>,
    pub mfr_part_no: Option<String>,
    pub diameter_mm: Option<Decimal>,
    pub flutes: Option<i32>,
    pub reorder_level: Decimal,
    pub reorder_qty: Option<Decimal>,
    pub bin_location: String,
    pub unit_cost: Option<Decimal>,
    /// Zero is allowed and means "in the catalog, none in the bin". It books no
    /// ledger row — §7 forbids a zero delta, and "nothing arrived" is not a
    /// movement. The item still appears on the stock views at zero, because
    /// `items_after_insert` gives every item a stock row at birth.
    pub opening_qty: Decimal,
    pub barcode: Option<String>,
}

/// Parse the catalog, reporting the line number of anything wrong.
///
/// Line numbers are 1-based and count comments and blanks, so they match what
/// an editor shows — the whole point of reporting them.
pub fn parse(source: &str) -> Result<Vec<CatalogRow>> {
    let mut rows = Vec::new();
    let mut header_seen = false;

    for (index, raw) in source.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim();

        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if line.contains('"') {
            bail!(
                "line {line_no}: quoted fields are not supported — \
                 remove the quotes and any commas inside a field"
            );
        }

        let fields: Vec<&str> = line.split(',').map(str::trim).collect();

        if !header_seen {
            if fields != COLUMNS {
                bail!(
                    "line {line_no}: the header does not match the expected columns.\n  \
                     expected: {}\n  found:    {}",
                    COLUMNS.join(","),
                    fields.join(",")
                );
            }
            header_seen = true;
            continue;
        }

        if fields.len() != COLUMNS.len() {
            bail!(
                "line {line_no}: expected {} fields but found {}. \
                 A comma inside a description is the usual cause — use a dash.",
                COLUMNS.len(),
                fields.len()
            );
        }

        rows.push(row(&fields, line_no)?);
    }

    if !header_seen {
        bail!("the catalog has no header row");
    }
    if rows.is_empty() {
        bail!("the catalog has a header but no items");
    }

    Ok(rows)
}

fn row(f: &[&str], line_no: usize) -> Result<CatalogRow> {
    let at = |i: usize| -> Result<String> {
        let v = f[i].trim();
        if v.is_empty() {
            bail!("line {line_no}: {} must not be empty", COLUMNS[i]);
        }
        Ok(v.to_owned())
    };
    let opt = |i: usize| -> Option<String> {
        let v = f[i].trim();
        (!v.is_empty()).then(|| v.to_owned())
    };
    let dec = |i: usize| -> Result<Option<Decimal>> {
        match opt(i) {
            None => Ok(None),
            Some(v) => Ok(Some(v.parse::<Decimal>().with_context(|| {
                format!("line {line_no}: {} is not a number: {v}", COLUMNS[i])
            })?)),
        }
    };

    let uom = at(3)?.to_uppercase();
    if !UOMS.contains(&uom.as_str()) {
        bail!(
            "line {line_no}: uom must be one of {} (found {uom})",
            UOMS.join(", ")
        );
    }

    let flutes =
        match opt(9) {
            None => None,
            Some(v) => Some(v.parse::<i32>().with_context(|| {
                format!("line {line_no}: flutes is not a whole number: {v}")
            })?),
        };

    let reorder_level = dec(10)?.unwrap_or_default();
    let opening_qty = dec(14)?.unwrap_or_default();

    // Negative anything here is a typo, and a negative opening balance would
    // seed the store below zero before anybody had touched it.
    if reorder_level.is_sign_negative() {
        bail!("line {line_no}: reorder_level cannot be negative");
    }
    if opening_qty.is_sign_negative() {
        bail!("line {line_no}: opening_qty cannot be negative");
    }

    Ok(CatalogRow {
        item_code: at(0)?,
        description: at(1)?,
        category: at(2)?,
        uom,
        iso_code: opt(4),
        grade: opt(5),
        manufacturer: opt(6),
        mfr_part_no: opt(7),
        diameter_mm: dec(8)?,
        flutes,
        reorder_level,
        reorder_qty: dec(11)?,
        bin_location: at(12)?,
        unit_cost: dec(13)?,
        opening_qty,
        barcode: opt(15),
    })
}

/// The categories the demo uses, in the order they should appear in pickers.
///
/// Derived from the file rather than listed separately, so adding a section to
/// the CSV cannot leave a category missing. First appearance wins the order,
/// which is why the file is grouped.
pub fn categories(rows: &[CatalogRow]) -> Vec<String> {
    let mut seen = Vec::new();
    for row in rows {
        if !seen.iter().any(|c| c == &row.category) {
            seen.push(row.category.clone());
        }
    }
    seen
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_demo_catalog_parses() {
        let rows = parse(DEMO_CATALOG).expect("the shipped catalog must parse");

        // If this ever drops sharply, somebody has truncated the file.
        assert!(rows.len() > 60, "only {} rows", rows.len());

        // Every item code is unique — a duplicate would silently overwrite on
        // the upsert and lose a bin location.
        let mut codes: Vec<&str> = rows.iter().map(|r| r.item_code.as_str()).collect();
        codes.sort_unstable();
        let before = codes.len();
        codes.dedup();
        assert_eq!(before, codes.len(), "duplicate item_code in the catalog");

        // Same for barcodes: `item_barcodes.code` is unique, so a duplicate
        // would fail the insert halfway through seeding.
        let mut barcodes: Vec<&str> =
            rows.iter().filter_map(|r| r.barcode.as_deref()).collect();
        assert!(!barcodes.is_empty(), "no vendor barcodes to demonstrate");
        barcodes.sort_unstable();
        let before = barcodes.len();
        barcodes.dedup();
        assert_eq!(before, barcodes.len(), "duplicate barcode in the catalog");
    }

    #[test]
    fn the_demo_catalog_covers_what_a_cnc_shop_actually_holds() {
        let rows = parse(DEMO_CATALOG).unwrap();
        let cats = categories(&rows);

        for expected in [
            "Turning inserts",
            "Milling inserts",
            "Milling tools",
            "Drilling",
            "Threading",
            "Boring and reaming",
            "Toolholding",
            "Consumables",
        ] {
            assert!(cats.iter().any(|c| c == expected), "missing {expected}");
        }
    }

    #[test]
    fn the_demo_has_something_for_the_alert_console_to_show() {
        // A demo where everything is comfortably in stock cannot demonstrate
        // the thing the storekeeper most needs to see.
        let rows = parse(DEMO_CATALOG).unwrap();

        let low = rows
            .iter()
            .filter(|r| r.opening_qty > Decimal::ZERO && r.opening_qty <= r.reorder_level)
            .count();
        let empty = rows
            .iter()
            .filter(|r| r.opening_qty.is_zero() && r.reorder_level > Decimal::ZERO)
            .count();

        assert!(low >= 3, "only {low} item(s) start LOW");
        assert!(empty >= 1, "no item starts EMPTY");
    }

    #[test]
    fn fractional_quantities_survive_the_round_trip() {
        // Coolant is drawn by the litre. §6 makes quantities numeric(12,3)
        // precisely so this is not rounded to a whole drum.
        let rows = parse(DEMO_CATALOG).unwrap();
        let coolant = rows
            .iter()
            .find(|r| r.item_code == "COOL-SYN-20L")
            .expect("the coolant is the fractional-quantity example");

        assert_eq!(coolant.uom, "LTR");
        assert_eq!(coolant.opening_qty, "160.500".parse::<Decimal>().unwrap());
    }

    #[test]
    fn a_row_with_the_wrong_field_count_names_its_line() {
        let src = "item_code,description,category,uom,iso_code,grade,manufacturer,\
                   mfr_part_no,diameter_mm,flutes,reorder_level,reorder_qty,\
                   bin_location,unit_cost,opening_qty,barcode\n\
                   ONLY,TWO\n";
        let err = parse(src).unwrap_err().to_string();
        assert!(err.contains("line 2"), "{err}");
        assert!(err.contains("use a dash"), "{err}");
    }

    #[test]
    fn a_bad_uom_is_refused_rather_than_stored() {
        let src = format!(
            "{}\nX,A thing,Cat,EACH,,,,,,,1,,A-1,1.00,1,\n",
            COLUMNS.join(",")
        );
        let err = parse(&src).unwrap_err().to_string();
        assert!(err.contains("uom must be one of"), "{err}");
    }

    #[test]
    fn a_negative_opening_balance_is_refused() {
        let src = format!(
            "{}\nX,A thing,Cat,NOS,,,,,,,1,,A-1,1.00,-5,\n",
            COLUMNS.join(",")
        );
        let err = parse(&src).unwrap_err().to_string();
        assert!(err.contains("opening_qty cannot be negative"), "{err}");
    }

    #[test]
    fn a_shifted_header_is_caught_before_anything_is_stored() {
        let src = "item_code,description\nX,Y\n";
        let err = parse(src).unwrap_err().to_string();
        assert!(err.contains("header does not match"), "{err}");
    }
}
