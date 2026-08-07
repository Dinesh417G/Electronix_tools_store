//! A minimal PDF writer — just enough for bin labels.
//!
//! Hand-rolled rather than pulled in as a dependency, for one reason: a label
//! sheet needs filled rectangles and Helvetica text, and nothing else. A PDF
//! library would bring a few hundred kilobytes of font subsetting, image codecs
//! and layout engine to draw ninety black boxes.
//!
//! Everything here is in PostScript points (1/72 inch), origin bottom-left,
//! which is what PDF itself uses. Converting at the edges rather than
//! throughout keeps the arithmetic in one place.

use std::fmt::Write as _;

/// A4, in points. The size every Indian shop's printer is loaded with.
pub const A4: (f32, f32) = (595.28, 841.89);

pub const MM: f32 = 72.0 / 25.4;

/// One page's drawing commands.
#[derive(Debug, Default, Clone)]
pub struct Page {
    content: String,
}

impl Page {
    pub fn new() -> Self {
        Page::default()
    }

    /// Fill a rectangle in black. This is how a bar gets drawn.
    pub fn fill_rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
        let _ = writeln!(
            self.content,
            "0 g {x:.3} {y:.3} {width:.3} {height:.3} re f"
        );
    }

    /// Stroke a thin grey rectangle — the cut guide around each label.
    pub fn stroke_rect(&mut self, x: f32, y: f32, width: f32, height: f32) {
        let _ = writeln!(
            self.content,
            "0.75 G 0.4 w {x:.3} {y:.3} {width:.3} {height:.3} re S"
        );
    }

    /// Draw text in Helvetica at the given baseline.
    pub fn text(&mut self, x: f32, y: f32, size: f32, text: &str) {
        let _ = writeln!(
            self.content,
            "BT 0 g /F1 {size:.2} Tf {x:.3} {y:.3} Td ({}) Tj ET",
            escape(text)
        );
    }

    /// Draw text in Helvetica-Bold.
    pub fn text_bold(&mut self, x: f32, y: f32, size: f32, text: &str) {
        let _ = writeln!(
            self.content,
            "BT 0 g /F2 {size:.2} Tf {x:.3} {y:.3} Td ({}) Tj ET",
            escape(text)
        );
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }
}

/// Escape a string for a PDF literal.
///
/// Non-Latin-1 characters are replaced rather than dropped: a description with
/// a stray character should print as `Ø 12mm?` rather than silently losing a
/// word, and the barcode carries the machine-readable truth anyway.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 32 => out.push(' '),
            c if (c as u32) < 128 => out.push(c),
            c if (c as u32) < 256 => {
                let _ = write!(out, "\\{:03o}", c as u32);
            }
            _ => out.push('?'),
        }
    }
    out
}

/// Assemble pages into a PDF document.
pub fn render(pages: &[Page], page_size: (f32, f32)) -> Vec<u8> {
    // Object numbering: 1 catalog, 2 page tree, 3 Helvetica, 4 Helvetica-Bold,
    // then a (page, content) pair per page.
    const FIRST_PAGE_OBJ: usize = 5;

    let page_count = pages.len().max(1);
    let mut objects: Vec<String> = Vec::with_capacity(4 + page_count * 2);

    let kids: String = (0..page_count)
        .map(|i| format!("{} 0 R", FIRST_PAGE_OBJ + i * 2))
        .collect::<Vec<_>>()
        .join(" ");

    objects.push("<< /Type /Catalog /Pages 2 0 R >>".to_owned());
    objects.push(format!(
        "<< /Type /Pages /Kids [{kids}] /Count {page_count} >>"
    ));
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    );
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    );

    let empty = Page::new();
    for i in 0..page_count {
        let page = pages.get(i).unwrap_or(&empty);
        let content_obj = FIRST_PAGE_OBJ + i * 2 + 1;

        objects.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] \
             /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {content_obj} 0 R >>",
            page_size.0, page_size.1
        ));
        objects.push(format!(
            "<< /Length {} >>\nstream\n{}endstream",
            page.content.len(),
            page.content
        ));
    }

    // Byte offsets have to be exact or every reader rejects the file, so the
    // document is assembled as bytes and the offsets recorded as we go.
    let mut out: Vec<u8> = Vec::with_capacity(4096 + objects.len() * 256);
    out.extend_from_slice(b"%PDF-1.4\n");
    // A binary comment marks the file as binary for transfer tools.
    out.extend_from_slice(b"%\xE2\xE3\xCF\xD3\n");

    let mut offsets = Vec::with_capacity(objects.len());
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }

    let xref_offset = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", objects.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for offset in &offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }

    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );

    out
}

/// Width of a Helvetica string at a given size, in points.
///
/// Approximate — the real Helvetica widths table is 256 entries and this is
/// only used to centre a caption and to decide when to truncate a description.
/// Being a few percent out moves a label's text by a fraction of a millimetre.
pub fn text_width(text: &str, size: f32) -> f32 {
    let units: f32 = text
        .chars()
        .map(|c| match c {
            'i' | 'j' | 'l' | '.' | ',' | ':' | ';' | '\'' | '|' | '!' => 0.28,
            'f' | 't' | 'r' | '(' | ')' | '[' | ']' | '-' | ' ' => 0.36,
            'm' | 'M' | 'W' | 'w' => 0.86,
            'A'..='Z' => 0.68,
            _ => 0.55,
        })
        .sum();
    units * size
}

/// Cut a string to fit a width, with an ellipsis when it does not.
pub fn truncate_to_width(text: &str, size: f32, max_width: f32) -> String {
    if text_width(text, size) <= max_width {
        return text.to_owned();
    }
    let mut out = String::new();
    for ch in text.chars() {
        let mut candidate = out.clone();
        candidate.push(ch);
        if text_width(&candidate, size) + text_width("…", size) > max_width {
            break;
        }
        out = candidate;
    }
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let mut page = Page::new();
        page.fill_rect(10.0, 10.0, 2.0, 40.0);
        page.text(10.0, 60.0, 8.0, "CNMG120408-TN2000");
        render(&[page], A4)
    }

    #[test]
    fn the_output_is_a_pdf() {
        let pdf = sample();
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf.ends_with(b"%%EOF\n"));
    }

    #[test]
    fn the_xref_offsets_point_at_real_objects() {
        // A wrong offset here produces a file that every reader rejects, and
        // the only symptom on a shop floor is "the print button does nothing".
        let pdf = sample();
        let text = String::from_utf8_lossy(&pdf);

        let startxref = text
            .rsplit("startxref")
            .next()
            .and_then(|s| s.trim().lines().next())
            .and_then(|s| s.trim().parse::<usize>().ok())
            .expect("startxref should be a number");

        assert!(pdf[startxref..].starts_with(b"xref"), "startxref is wrong");

        // Every offset in the table must land on an object header.
        let xref = &text[startxref..];
        for (i, line) in xref.lines().skip(2).enumerate() {
            let Some(offset) = line.split_whitespace().next() else {
                break;
            };
            let Ok(offset) = offset.parse::<usize>() else {
                break;
            };
            if line.contains(" f ") {
                continue;
            }
            let expected = format!("{} 0 obj", i + 1);
            assert!(
                pdf[offset..].starts_with(expected.as_bytes()),
                "offset for object {} is wrong",
                i + 1
            );
        }
    }

    #[test]
    fn the_page_count_matches_the_kids_array() {
        let pdf = render(&[Page::new(), Page::new(), Page::new()], A4);
        let text = String::from_utf8_lossy(&pdf);
        assert!(text.contains("/Count 3"));
        assert!(text.contains("5 0 R 7 0 R 9 0 R"));
    }

    #[test]
    fn a_document_with_no_pages_still_produces_one_blank_page() {
        // A reader given /Count 0 shows an error, not an empty sheet.
        let pdf = render(&[], A4);
        assert!(String::from_utf8_lossy(&pdf).contains("/Count 1"));
    }

    #[test]
    fn content_stream_lengths_are_honest() {
        let pdf = sample();
        let text = String::from_utf8_lossy(&pdf);
        let declared: usize = text
            .split("/Length ")
            .nth(1)
            .and_then(|s| s.split_whitespace().next())
            .and_then(|s| s.parse().ok())
            .expect("a /Length");

        // Located by offset rather than by splitting: "endstream\n" itself
        // contains "stream\n", so a naive split cuts in the wrong place and
        // silently reports a three-byte discrepancy that is not there.
        let start = text.find("stream\n").expect("a stream") + "stream\n".len();
        let end = start + text[start..].find("endstream").expect("an endstream");
        let stream = &text[start..end];

        assert_eq!(declared, stream.len(), "declared length does not match");
    }

    #[test]
    fn parentheses_and_backslashes_are_escaped() {
        // An unescaped ')' in a description terminates the string early and
        // corrupts everything after it on the page.
        assert_eq!(escape("Ø6 (rough) \\ end"), "\\3306 \\(rough\\) \\\\ end");
    }

    #[test]
    fn control_characters_never_reach_the_page() {
        assert_eq!(escape("a\u{0007}b\nc"), "a b c");
    }

    #[test]
    fn long_descriptions_are_truncated_not_overflowed() {
        let long = "Solid carbide 4-flute end mill, TiAlN coated, 6mm diameter, long series";
        let cut = truncate_to_width(long, 7.0, 120.0);
        assert!(cut.ends_with('…'));
        assert!(text_width(&cut, 7.0) <= 120.0);
        assert!(cut.len() < long.len());
    }

    #[test]
    fn short_descriptions_are_left_alone() {
        assert_eq!(truncate_to_width("CNMG", 7.0, 120.0), "CNMG");
    }
}
