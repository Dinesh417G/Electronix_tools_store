//! Bin-label generation for the ElectronIx Tool Store (CLAUDE.md §11, M7).
//!
//! A label carries three things, in the order somebody standing at a rack needs
//! them:
//!
//! 1. the **bin location**, biggest — that is what you read from two metres
//!    away when you are looking for the right shelf;
//! 2. the **barcode** of `item_code`, which is what the terminal scans;
//! 3. the **description**, so a human can confirm the bin holds what they think.
//!
//! §5's dependency rule applies: this crate depends on `store-core` only. It has
//! no database access — the caller passes in what to print.

#![forbid(unsafe_code)]

pub mod code128;
pub mod pdf;

#[cfg(feature = "scan-verify")]
pub mod scan;

pub use code128::{encode, Code128Error, Symbol};
pub use pdf::{render, Page, A4, MM};

/// One label's worth of content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelSpec {
    /// The barcode payload. This is `items.item_code` (§6).
    pub item_code: String,
    pub description: String,
    pub bin_location: Option<String>,
    /// Printed small, so a storekeeper can tell two grades apart by eye.
    pub detail: Option<String>,
}

/// The physical grid a sheet is cut into.
///
/// Defaults to a 3×8 grid on A4 — 24 labels of 63.5 × 33.9 mm, which is the
/// most widely sold self-adhesive sheet in India and therefore the one a shop
/// can actually buy.
#[derive(Debug, Clone, Copy)]
pub struct SheetLayout {
    pub page: (f32, f32),
    pub columns: usize,
    pub rows: usize,
    pub margin_x: f32,
    pub margin_y: f32,
    /// Drawn as a faint outline so hand-cutting has a guide.
    pub draw_cut_guides: bool,
}

impl Default for SheetLayout {
    fn default() -> Self {
        SheetLayout {
            page: pdf::A4,
            columns: 3,
            rows: 8,
            margin_x: 7.0 * MM,
            margin_y: 12.0 * MM,
            draw_cut_guides: true,
        }
    }
}

impl SheetLayout {
    pub fn per_page(&self) -> usize {
        self.columns * self.rows
    }

    fn cell_size(&self) -> (f32, f32) {
        (
            (self.page.0 - 2.0 * self.margin_x) / self.columns as f32,
            (self.page.1 - 2.0 * self.margin_y) / self.rows as f32,
        )
    }

    /// Bottom-left corner of cell `index` on a page.
    ///
    /// Filled left-to-right, top-to-bottom: that is the order a human reads,
    /// and a sheet half-used from the bottom looks like a mistake.
    fn cell_origin(&self, index: usize) -> (f32, f32) {
        let (w, h) = self.cell_size();
        let col = index % self.columns;
        let row = index / self.columns;
        (
            self.margin_x + col as f32 * w,
            self.page.1 - self.margin_y - (row + 1) as f32 * h,
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum LabelError {
    #[error("nothing to print")]
    Empty,
    #[error("item {item_code:?}: {source}")]
    Barcode {
        item_code: String,
        #[source]
        source: Code128Error,
    },
}

/// Render a batch of labels to a PDF.
///
/// One item that cannot be encoded fails the whole batch rather than printing a
/// sheet with a silent hole in it — a label that is missing is noticed; a label
/// that is blank gets stuck on a bin.
pub fn render_sheet(labels: &[LabelSpec], layout: &SheetLayout) -> Result<Vec<u8>, LabelError> {
    if labels.is_empty() {
        return Err(LabelError::Empty);
    }

    let per_page = layout.per_page();
    let mut pages = Vec::with_capacity(labels.len().div_ceil(per_page));

    for chunk in labels.chunks(per_page) {
        let mut page = Page::new();
        for (index, label) in chunk.iter().enumerate() {
            draw_label(&mut page, label, layout, index)?;
        }
        pages.push(page);
    }

    Ok(render(&pages, layout.page))
}

fn draw_label(
    page: &mut Page,
    label: &LabelSpec,
    layout: &SheetLayout,
    index: usize,
) -> Result<(), LabelError> {
    let (cell_w, cell_h) = layout.cell_size();
    let (ox, oy) = layout.cell_origin(index);

    if layout.draw_cut_guides {
        page.stroke_rect(ox + 1.0, oy + 1.0, cell_w - 2.0, cell_h - 2.0);
    }

    let pad = 3.0 * MM;
    let inner_w = cell_w - 2.0 * pad;

    let symbol = encode(&label.item_code).map_err(|source| LabelError::Barcode {
        item_code: label.item_code.clone(),
        source,
    })?;

    // Bin location, top-left and large. It is what somebody scanning a rack for
    // the right shelf actually reads.
    let mut cursor_y = oy + cell_h - pad - 8.0;
    if let Some(bin) = &label.bin_location {
        page.text_bold(ox + pad, cursor_y, 10.0, bin);
    }

    // Description, top-right-ish under the bin.
    cursor_y -= 8.0;
    let description = pdf::truncate_to_width(&label.description, 6.5, inner_w);
    page.text(ox + pad, cursor_y, 6.5, &description);

    if let Some(detail) = &label.detail {
        cursor_y -= 7.0;
        let detail = pdf::truncate_to_width(detail, 6.0, inner_w);
        page.text(ox + pad, cursor_y, 6.0, &detail);
    }

    // The barcode fills the width it is given, but never below the module width
    // a laser printer can hold. Below about 0.19 mm the bars bleed into each
    // other and the label stops scanning — better a narrower symbol that works.
    const MIN_MODULE: f32 = 0.19 * MM;
    let module = (inner_w / symbol.width_modules() as f32).max(MIN_MODULE);
    let bar_width = module * symbol.width_modules() as f32;

    // Centre it, and let a wide symbol run into the padding rather than
    // shrinking below the printable module width.
    let bar_x = ox + ((cell_w - bar_width) / 2.0).max(1.0);
    let bar_bottom = oy + pad + 8.0;
    let bar_height = (cursor_y - 3.0 - bar_bottom).max(8.0 * MM);

    for (start, width) in symbol.bars() {
        page.fill_rect(
            bar_x + start as f32 * module,
            bar_bottom,
            width as f32 * module,
            bar_height,
        );
    }

    // The human-readable line. Without it, a damaged barcode is an unidentified
    // bin, and somebody has to open the box to find out what is in it.
    let caption_size = 7.0;
    let caption_w = pdf::text_width(&label.item_code, caption_size);
    page.text(
        ox + ((cell_w - caption_w) / 2.0).max(pad),
        oy + pad,
        caption_size,
        &label.item_code,
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(code: &str) -> LabelSpec {
        LabelSpec {
            item_code: code.to_owned(),
            description: format!("Test item {code}"),
            bin_location: Some("A-01-1".to_owned()),
            detail: Some("TN2000".to_owned()),
        }
    }

    #[test]
    fn a_sheet_renders_to_a_pdf() {
        let pdf = render_sheet(&[spec("CNMG120408-TN2000")], &SheetLayout::default()).unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        assert!(pdf.len() > 500, "suspiciously small: {} bytes", pdf.len());
    }

    #[test]
    fn labels_spill_onto_extra_pages() {
        let layout = SheetLayout::default();
        let labels: Vec<LabelSpec> = (0..layout.per_page() + 1)
            .map(|i| spec(&format!("ITEM-{i:03}")))
            .collect();

        let pdf = render_sheet(&labels, &layout).unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Count 2"));
    }

    #[test]
    fn an_exactly_full_sheet_does_not_add_a_blank_page() {
        let layout = SheetLayout::default();
        let labels: Vec<LabelSpec> = (0..layout.per_page())
            .map(|i| spec(&format!("ITEM-{i:03}")))
            .collect();

        let pdf = render_sheet(&labels, &layout).unwrap();
        assert!(String::from_utf8_lossy(&pdf).contains("/Count 1"));
    }

    #[test]
    fn an_empty_batch_is_refused() {
        assert!(matches!(
            render_sheet(&[], &SheetLayout::default()),
            Err(LabelError::Empty)
        ));
    }

    #[test]
    fn one_bad_code_fails_the_whole_batch() {
        // A sheet with a silent hole in it gets stuck on a bin. A refused batch
        // gets noticed.
        let labels = vec![spec("GOOD-1"), spec("BAD\u{00e9}"), spec("GOOD-2")];
        let err = render_sheet(&labels, &SheetLayout::default()).unwrap_err();
        assert!(matches!(err, LabelError::Barcode { .. }), "{err}");
    }

    #[test]
    fn cells_are_laid_out_left_to_right_top_to_bottom() {
        let layout = SheetLayout::default();

        let (x0, y0) = layout.cell_origin(0);
        let (x1, y1) = layout.cell_origin(1);
        let (x3, y3) = layout.cell_origin(layout.columns);

        assert!(x1 > x0, "the second cell should be to the right");
        assert_eq!(y1, y0, "the second cell should be on the same row");
        assert!(y3 < y0, "the next row should be lower down the page");
        assert_eq!(x3, x0, "the next row should restart at the left");
    }

    #[test]
    fn every_cell_stays_on_the_page() {
        let layout = SheetLayout::default();
        let (w, h) = layout.cell_size();

        for i in 0..layout.per_page() {
            let (x, y) = layout.cell_origin(i);
            assert!(x >= 0.0 && y >= 0.0, "cell {i} starts off-page at {x},{y}");
            assert!(
                x + w <= layout.page.0 + 0.01 && y + h <= layout.page.1 + 0.01,
                "cell {i} runs off the page"
            );
        }
    }

    #[test]
    fn the_standard_sheet_is_the_one_a_shop_can_buy() {
        // 3x8 on A4 ≈ 63.5 x 33.9 mm labels — the common self-adhesive sheet.
        let layout = SheetLayout::default();
        let (w, h) = layout.cell_size();
        assert!((w / MM - 60.0).abs() < 6.0, "cell width {} mm", w / MM);
        assert!((h / MM - 34.0).abs() < 4.0, "cell height {} mm", h / MM);
        assert_eq!(layout.per_page(), 24);
    }

    #[test]
    fn a_label_with_no_bin_or_detail_still_prints() {
        // Most of the catalog has no bin assigned on day one.
        let bare = LabelSpec {
            item_code: "ITEM-1".to_owned(),
            description: "Something".to_owned(),
            bin_location: None,
            detail: None,
        };
        assert!(render_sheet(&[bare], &SheetLayout::default()).is_ok());
    }
}
