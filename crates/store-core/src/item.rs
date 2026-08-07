//! Catalog domain: items, categories, units of measure and the barcode rules.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{CoreError, Result};

/// Unit of measure. Deliberately a closed set — a free-text UOM column is how
/// you end up with "NOS", "Nos", "nos." and "pcs" all meaning the same thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Uom {
    /// Discrete pieces — inserts, end mills, drills.
    Nos,
    /// A matched set sold and issued as one unit.
    Set,
    /// A sealed box issued whole.
    Box,
    /// Litres — coolant, cutting oil.
    Ltr,
    /// Kilograms — bar stock, swarf-facing consumables.
    Kg,
}

impl Uom {
    /// The token stored in `items.uom`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Uom::Nos => "NOS",
            Uom::Set => "SET",
            Uom::Box => "BOX",
            Uom::Ltr => "LTR",
            Uom::Kg => "KG",
        }
    }

    /// True when this unit only ever moves in whole numbers.
    ///
    /// Inserts and end mills do. Coolant and bar stock do not — which is the
    /// whole reason quantities are `numeric(12,3)` rather than integers.
    pub const fn is_discrete(self) -> bool {
        matches!(self, Uom::Nos | Uom::Set | Uom::Box)
    }

    pub const ALL: [Uom; 5] = [Uom::Nos, Uom::Set, Uom::Box, Uom::Ltr, Uom::Kg];
}

impl std::fmt::Display for Uom {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for Uom {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "NOS" => Ok(Uom::Nos),
            "SET" => Ok(Uom::Set),
            "BOX" => Ok(Uom::Box),
            "LTR" => Ok(Uom::Ltr),
            "KG" => Ok(Uom::Kg),
            _ => Err(CoreError::UnknownUom(s.to_owned())),
        }
    }
}

/// A catalog grouping — "Turning inserts", "Solid carbide end mills", "Taps".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Category {
    pub id: Uuid,
    pub name: String,
    pub sort_order: i32,
}

/// The tooling-specific attributes. All optional: a tin of coolant has none of
/// them, a CNMG insert has most of them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolingSpec {
    /// e.g. `CNMG120408`
    pub iso_code: Option<String>,
    /// e.g. `TN2000`
    pub grade: Option<String>,
    pub manufacturer: Option<String>,
    pub mfr_part_no: Option<String>,
    pub diameter_mm: Option<Decimal>,
    pub flutes: Option<i32>,
}

/// Stock-control policy for one item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StockPolicy {
    /// On-hand at or below this raises a `LOW` alert. Zero disables the alert.
    pub reorder_level: Decimal,
    /// Suggested purchase quantity, shown on the alert. Advisory only.
    pub reorder_qty: Option<Decimal>,
    /// When true, an ISSUE may drive on-hand below zero (§7 guard is bypassed).
    /// Reserve this for items the shop genuinely consumes faster than it books.
    pub allow_negative: bool,
}

impl Default for StockPolicy {
    fn default() -> Self {
        Self {
            reorder_level: Decimal::ZERO,
            reorder_qty: None,
            allow_negative: false,
        }
    }
}

/// A catalog item. Note there is no `qty` field, and there never will be —
/// on-hand is the sum of the ledger (§7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Item {
    pub id: Uuid,
    /// Our internal code. This is also the payload printed on the bin label.
    pub item_code: String,
    pub description: String,
    pub category_id: Option<Uuid>,
    pub uom: Uom,
    #[serde(flatten)]
    pub tooling: ToolingSpec,
    #[serde(flatten)]
    pub policy: StockPolicy,
    /// Rack / shelf, printed on the label.
    pub bin_location: Option<String>,
    pub unit_cost: Option<Decimal>,
    pub active: bool,
}

/// Where a barcode came from.
///
/// A vendor's own printed barcode resolving to our item is the difference
/// between scanning the box as it arrives and re-labelling every box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BarcodeKind {
    /// Printed by us from `item_code`.
    Own,
    /// The manufacturer's EAN/UPC on the retail box.
    MfrEan,
    /// A distributor's own label.
    Vendor,
}

impl BarcodeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            BarcodeKind::Own => "OWN",
            BarcodeKind::MfrEan => "MFR_EAN",
            BarcodeKind::Vendor => "VENDOR",
        }
    }
}

/// An alternate barcode that resolves to an item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemBarcode {
    pub id: Uuid,
    pub item_id: Uuid,
    pub code: String,
    pub kind: BarcodeKind,
}

// ── Barcode rules ────────────────────────────────────────────────────────

/// Longest payload we will put on a bin label.
///
/// Code128 has no hard limit, but a 32-character payload at a readable module
/// width is already wider than most bin fronts.
pub const MAX_ITEM_CODE_LEN: usize = 32;

/// Longest barcode we will accept from a scanner, vendor labels included.
pub const MAX_BARCODE_LEN: usize = 64;

/// Normalise a scanned payload for lookup.
///
/// Scanners commonly append a carriage return or a newline as the "enter" key,
/// and some prepend a symbology prefix character. Trimming whitespace and
/// upper-casing gives us one canonical form to index on. We deliberately do
/// *not* strip anything else — a payload that needs more mangling than this is
/// a payload we should not be silently guessing at.
pub fn normalize_barcode(raw: &str) -> String {
    raw.trim()
        .trim_matches(['\r', '\n'])
        .trim()
        .to_ascii_uppercase()
}

/// True when `c` is encodable in Code128 subsets A/B — printable 7-bit ASCII.
const fn is_code128_printable(c: char) -> bool {
    (c as u32) >= 0x20 && (c as u32) <= 0x7E
}

/// Validate an `item_code` for use as a Code128 label payload.
///
/// The item code *is* the barcode (§6), so a code we cannot print is a code we
/// cannot accept into the catalog.
pub fn validate_item_code(code: &str) -> Result<String> {
    let normalized = normalize_barcode(code);
    let invalid = normalized.is_empty()
        || normalized.len() > MAX_ITEM_CODE_LEN
        || !normalized.chars().all(is_code128_printable)
        // A leading or trailing space survives normalisation only if it is a
        // non-breaking or otherwise exotic space, which no scanner will return.
        || normalized.contains("  ");
    if invalid {
        return Err(CoreError::InvalidItemCode(code.to_owned()));
    }
    Ok(normalized)
}

/// Validate any barcode we are willing to store against an item, including
/// vendor and manufacturer codes we did not print.
pub fn validate_barcode(code: &str) -> Result<String> {
    let normalized = normalize_barcode(code);
    if normalized.is_empty()
        || normalized.len() > MAX_BARCODE_LEN
        || !normalized.chars().all(is_code128_printable)
    {
        return Err(CoreError::InvalidBarcode(code.to_owned()));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn uom_round_trips_through_its_token() {
        for uom in Uom::ALL {
            assert_eq!(Uom::from_str(uom.as_str()).unwrap(), uom);
        }
    }

    #[test]
    fn uom_parsing_is_forgiving_about_case_and_padding() {
        assert_eq!(Uom::from_str("  nos ").unwrap(), Uom::Nos);
        assert!(Uom::from_str("PCS").is_err());
    }

    #[test]
    fn liquids_and_bar_stock_are_not_discrete() {
        assert!(Uom::Nos.is_discrete());
        assert!(!Uom::Ltr.is_discrete());
        assert!(!Uom::Kg.is_discrete());
    }

    #[test]
    fn scanner_line_endings_are_stripped() {
        assert_eq!(normalize_barcode("CNMG120408\r\n"), "CNMG120408");
        assert_eq!(normalize_barcode(" em-06-4f \n"), "EM-06-4F");
    }

    #[test]
    fn item_code_rejects_what_we_cannot_print() {
        assert!(validate_item_code("").is_err());
        assert!(validate_item_code("   ").is_err());
        assert!(validate_item_code("TOOL\u{00e9}").is_err(), "non-ASCII");
        assert!(validate_item_code("TOOL\u{0007}").is_err(), "control char");
        assert!(validate_item_code(&"X".repeat(MAX_ITEM_CODE_LEN + 1)).is_err());
        assert!(validate_item_code("A  B").is_err(), "collapsed whitespace");
    }

    #[test]
    fn item_code_accepts_ordinary_shop_codes() {
        assert_eq!(
            validate_item_code("cnmg-120408-tn2000").unwrap(),
            "CNMG-120408-TN2000"
        );
        assert_eq!(validate_item_code("EM 06 4F").unwrap(), "EM 06 4F");
    }

    #[test]
    fn vendor_barcodes_may_be_longer_than_our_own() {
        let vendor = "4".repeat(MAX_ITEM_CODE_LEN + 4);
        assert!(validate_item_code(&vendor).is_err());
        assert!(validate_barcode(&vendor).is_ok());
    }
}
