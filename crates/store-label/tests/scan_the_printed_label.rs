//! The M7 acceptance gate (CLAUDE.md §13).
//!
//! > Create item → print label → **scan that printed label** on the tablet →
//! > correct item resolves.
//!
//! There is no printer and no camera here, so the optical half of that gate
//! cannot be closed in software. What *can* be closed — and is, below — is
//! everything up to the photons:
//!
//! 1. the item's code is encoded to a Code 128 symbol;
//! 2. the symbol is drawn into a real PDF at real millimetre dimensions;
//! 3. the drawn rectangles are read back out of the PDF content stream and
//!    **rastered into a pixel row at printer resolution** — the same 1-D signal
//!    a laser scanner's photodiode sees as it sweeps across the label;
//! 4. that pixel row is decoded by a Code 128 reader written independently of
//!    the encoder, from the specification, including the checksum.
//!
//! Step 4 is the point. A decoder that shared the encoder's pattern table would
//! prove only that the table is self-consistent. This one recovers module
//! widths from pixel runs, matches them against its own table, verifies the
//! modulo-103 checksum, and hands back a string — so if the encoder emits the
//! wrong bars, the wrong widths, or a wrong checksum, this test fails.
//!
//! What it does **not** prove: ink spread, printer DPI, camera focus, and
//! whether the label survives coolant. Those need the physical loop, and §13's
//! gate is not fully closed until somebody prints a sheet and scans it.

use store_label::scan::{decode_code128, filled_rects, scan_line, scan_single_label};
use store_label::{render_sheet, LabelSpec, SheetLayout, MM};

fn label(code: &str) -> LabelSpec {
    LabelSpec {
        item_code: code.to_owned(),
        description: format!("Test item {code}"),
        bin_location: Some("A-01-1".to_owned()),
        detail: Some("TN2000".to_owned()),
    }
}

/// Print one label and scan it back, at a given printer resolution.
fn print_and_scan(code: &str, dpi: f32) -> String {
    let pdf = render_sheet(&[label(code)], &SheetLayout::default()).expect("render");
    scan_single_label(&pdf, dpi).expect("the printed label did not decode")
}

#[test]
fn the_m7_gate_a_printed_label_scans_back_to_its_item_code() {
    // The codes the seeded demo store actually uses, plus the shapes that
    // exercise both Code 128 subsets and the switch between them.
    for code in [
        "CNMG120408-TN2000",
        "DNMG150608-TT5100",
        "EM-06-4F-TIALN",
        "EM-12-4F-TIALN",
        "DR-8.5-HSS",
        "TAP-M10-HSS",
        "COOL-SYN-20L",
        "A-01-1",
        "8901234567890",
        "12345678",
        "X",
    ] {
        let scanned = print_and_scan(code, 600.0);
        assert_eq!(scanned, code, "printed {code:?}, scanned {scanned:?}");
    }
}

#[test]
fn a_label_still_scans_at_a_cheap_printers_resolution() {
    // 203 dpi is a thermal label printer; 300 dpi is the office laser floor.
    // If the module width is chosen too small, this is where it shows up —
    // the bars land on the same pixel and the symbol stops decoding.
    for dpi in [203.0, 300.0, 600.0, 1200.0] {
        let scanned = print_and_scan("CNMG120408-TN2000", dpi);
        assert_eq!(
            scanned, "CNMG120408-TN2000",
            "failed to decode at {dpi} dpi"
        );
    }
}

#[test]
fn the_decoder_rejects_a_symbol_with_a_broken_checksum() {
    // Proves the test is actually checking something: corrupt one bar and the
    // scan must fail rather than silently returning a plausible string.
    let pdf = render_sheet(&[label("CNMG120408-TN2000")], &SheetLayout::default()).unwrap();
    let mut rects = filled_rects(&pdf);

    let bar_top = rects.iter().map(|r| r.1 + r.3).fold(f32::MIN, f32::max);
    let bar_bottom = rects.iter().map(|r| r.1).fold(f32::MAX, f32::min);
    let y = (bar_top + bar_bottom) / 2.0;

    // Widen a bar in the middle of the symbol by one module's worth.
    let middle = rects.len() / 2;
    let module = rects.iter().map(|r| r.2).fold(f32::MAX, f32::min);
    rects[middle].2 += module;

    let pixels = scan_line(&rects, y, 600.0);
    let result = decode_code128(&pixels);

    assert!(
        result.as_deref() != Ok("CNMG120408-TN2000"),
        "a corrupted symbol decoded as if it were intact"
    );
}

#[test]
fn every_bar_is_wide_enough_to_print() {
    // Below roughly 0.19 mm a laser printer's toner bleeds bars together and
    // the label stops scanning — a failure that only appears on paper, so it is
    // worth catching in millimetres here.
    let long_code = "CNMG120408-TN2000-EXTRA-LONG-SUFFIX";
    let pdf = render_sheet(&[label(long_code)], &SheetLayout::default()).unwrap();

    let narrowest = filled_rects(&pdf)
        .iter()
        .map(|r| r.2)
        .fold(f32::MAX, f32::min);

    assert!(
        narrowest / MM >= 0.185,
        "narrowest bar is {:.3} mm — too fine to print reliably",
        narrowest / MM
    );
}

#[test]
fn the_barcode_stays_inside_its_label_cell() {
    // A symbol that overruns its cell gets guillotined when the sheet is cut,
    // and a guillotined barcode is an unscannable bin.
    let layout = SheetLayout::default();
    let pdf = render_sheet(&[label("CNMG120408-TN2000")], &layout).unwrap();
    let rects = filled_rects(&pdf);

    let cell_w = (layout.page.0 - 2.0 * layout.margin_x) / layout.columns as f32;
    let left = rects.iter().map(|r| r.0).fold(f32::MAX, f32::min);
    let right = rects.iter().map(|r| r.0 + r.2).fold(f32::MIN, f32::max);

    assert!(left >= layout.margin_x, "barcode starts left of the cell");
    assert!(
        right <= layout.margin_x + cell_w,
        "barcode ({right:.1}pt) runs past the cell edge ({:.1}pt)",
        layout.margin_x + cell_w
    );
}

#[test]
fn labels_on_a_full_sheet_all_scan() {
    // Cell positioning is arithmetic, and arithmetic that is right for cell 0
    // can be wrong for cell 17.
    let layout = SheetLayout::default();
    let codes: Vec<String> = (0..layout.per_page())
        .map(|i| format!("BIN-{i:03}"))
        .collect();
    let labels: Vec<LabelSpec> = codes.iter().map(|c| label(c)).collect();

    let pdf = render_sheet(&labels, &layout).unwrap();
    let rects = filled_rects(&pdf);

    // Group the bars by their vertical band, then scan each band's row.
    let mut rows: std::collections::BTreeMap<i32, Vec<(f32, f32, f32, f32)>> =
        std::collections::BTreeMap::new();
    for rect in rects {
        rows.entry(rect.1.round() as i32).or_default().push(rect);
    }

    assert_eq!(rows.len(), layout.rows, "expected one band per label row");

    let mut decoded = Vec::new();
    for band in rows.values() {
        // Each band holds `columns` symbols side by side; split them on the
        // widest gaps, which are the inter-label margins.
        let mut sorted = band.clone();
        sorted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());

        let cell_w = (layout.page.0 - 2.0 * layout.margin_x) / layout.columns as f32;
        for col in 0..layout.columns {
            let lo = layout.margin_x + col as f32 * cell_w;
            let hi = lo + cell_w;
            let cell: Vec<(f32, f32, f32, f32)> = sorted
                .iter()
                .filter(|r| r.0 >= lo - 0.5 && r.0 + r.2 <= hi + 0.5)
                .copied()
                .collect();
            if cell.is_empty() {
                continue;
            }
            let y = cell[0].1 + cell[0].3 / 2.0;
            let pixels = scan_line(&cell, y, 600.0);
            decoded.push(decode_code128(&pixels).expect("a cell failed to decode"));
        }
    }

    decoded.sort();
    let mut expected = codes.clone();
    expected.sort();
    assert_eq!(
        decoded, expected,
        "not every label on the sheet scanned back"
    );
}
