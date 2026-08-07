//! A Code 128 reader, for reading our own printed labels back.
//!
//! Behind the `scan-verify` feature and **not** part of the product: it exists
//! so tests can close the loop that §13's M7 gate describes — print a label,
//! then scan it — without a printer and a camera.
//!
//! Written to work the way a scanner does rather than the way the encoder does:
//! it starts from a row of pixels, recovers module widths by normalising each
//! six-element group to eleven modules, looks the group up, runs the subset
//! state machine, and verifies the modulo-103 checksum before returning
//! anything.
//!
//! **On independence, honestly.** The decode *logic* here shares nothing with
//! `code128.rs` — it is the inverse algorithm, written separately. The pattern
//! table is necessarily the same data, so a typo common to both would round-trip
//! undetected; that risk is covered instead by `patterns_are_well_formed` in
//! `code128.rs`, which checks the structural invariants every Code 128 pattern
//! must satisfy (eleven modules, three bars and three spaces, an even number of
//! bar modules, elements of one to four modules, all patterns distinct) — and by
//! `a_known_symbol_decodes` below, which pins one fully hand-computed symbol.

const PATTERNS: [&str; 107] = [
    "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212",
    "221213", "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221",
    "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221",
    "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321",
    "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131",
    "113123", "113321", "133121", "313121", "211331", "231131", "213113", "213311", "213131",
    "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111",
    "111224", "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
    "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", "111242",
    "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
    "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311",
    "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_A: usize = 103;
const START_B: usize = 104;
const START_C: usize = 105;
const CODE_A: usize = 101;
const CODE_B: usize = 100;
const CODE_C: usize = 99;
const STOP: usize = 106;

#[derive(Debug, PartialEq, Eq)]
pub enum ScanError {
    NoInk,
    TooShort,
    UnknownPattern(String),
    NoStop,
    BadChecksum { expected: usize, found: usize },
    BadStart(usize),
    Unsupported(usize),
}

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScanError::NoInk => write!(f, "the scan line found no bars"),
            ScanError::TooShort => write!(f, "too few elements to be a Code 128 symbol"),
            ScanError::UnknownPattern(p) => write!(f, "unrecognised pattern {p:?}"),
            ScanError::NoStop => write!(f, "no stop pattern"),
            ScanError::BadChecksum { expected, found } => {
                write!(f, "checksum {found} does not match {expected}")
            }
            ScanError::BadStart(v) => write!(f, "value {v} is not a start character"),
            ScanError::Unsupported(v) => write!(f, "unsupported character value {v}"),
        }
    }
}

/// Decode a row of pixels — true where there is ink — into its payload.
pub fn decode_code128(pixels: &[bool]) -> Result<String, ScanError> {
    let runs = to_runs(pixels)?;
    let values = to_values(&runs)?;
    verify_checksum(&values)?;
    to_text(&values)
}

/// Collapse the pixel row into alternating run lengths, starting at the first
/// bar and ending at the last. The quiet zones fall away here.
fn to_runs(pixels: &[bool]) -> Result<Vec<usize>, ScanError> {
    let first = pixels.iter().position(|p| *p).ok_or(ScanError::NoInk)?;
    let last = pixels.iter().rposition(|p| *p).ok_or(ScanError::NoInk)?;

    let mut runs = Vec::new();
    let mut current = pixels[first];
    let mut length = 0usize;

    for &pixel in &pixels[first..=last] {
        if pixel == current {
            length += 1;
        } else {
            runs.push(length);
            current = pixel;
            length = 1;
        }
    }
    runs.push(length);

    Ok(runs)
}

/// Turn runs into Code 128 values, six elements at a time.
///
/// Each character is eleven modules wide regardless of its pattern, so
/// normalising every group against its own total is what makes this tolerant of
/// the module width drifting across the symbol — which is exactly what happens
/// when a printer's pixel grid does not divide evenly into module widths.
fn to_values(runs: &[usize]) -> Result<Vec<usize>, ScanError> {
    if runs.len() < 6 + 7 {
        return Err(ScanError::TooShort);
    }

    let mut values = Vec::new();
    let mut index = 0usize;

    while runs.len() - index > 7 {
        let group = &runs[index..index + 6];
        let widths = normalise(group, 11);
        let key: String = widths.iter().map(|w| char::from(b'0' + *w as u8)).collect();

        let value = PATTERNS
            .iter()
            .position(|p| *p == key)
            .ok_or_else(|| ScanError::UnknownPattern(key.clone()))?;

        values.push(value);
        index += 6;
    }

    // What remains must be the seven-element, thirteen-module stop pattern.
    let stop = normalise(&runs[index..index + 7], 13);
    let stop_key: String = stop.iter().map(|w| char::from(b'0' + *w as u8)).collect();
    if stop_key != PATTERNS[STOP] {
        return Err(ScanError::NoStop);
    }

    Ok(values)
}

/// Scale a group of pixel runs to module counts totalling `total_modules`.
fn normalise(group: &[usize], total_modules: usize) -> Vec<usize> {
    let total: usize = group.iter().sum();
    let module = total as f64 / total_modules as f64;

    // Round each element, then repair the total if rounding lost or gained a
    // module — a real decoder has to, and so does this one, or a symbol printed
    // at 203 dpi fails on arithmetic rather than on optics.
    let mut widths: Vec<usize> = group
        .iter()
        .map(|run| ((*run as f64 / module).round() as usize).clamp(1, 4))
        .collect();

    let mut sum: usize = widths.iter().sum();
    while sum != total_modules {
        // Adjust whichever element the rounding treated worst.
        let (index, _) = group
            .iter()
            .enumerate()
            .map(|(i, run)| {
                let ideal = *run as f64 / module;
                let error = ideal - widths[i] as f64;
                (i, if sum < total_modules { error } else { -error })
            })
            .filter(|(i, _)| {
                if sum < total_modules {
                    widths[*i] < 4
                } else {
                    widths[*i] > 1
                }
            })
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
            .unwrap_or((0, 0.0));

        if sum < total_modules {
            widths[index] += 1;
            sum += 1;
        } else {
            widths[index] -= 1;
            sum -= 1;
        }
    }

    widths
}

/// The modulo-103 checksum: the start value plus each subsequent value weighted
/// by its position, compared against the second-to-last character.
fn verify_checksum(values: &[usize]) -> Result<(), ScanError> {
    if values.len() < 2 {
        return Err(ScanError::TooShort);
    }
    let found = values[values.len() - 1];
    let expected = values[..values.len() - 1]
        .iter()
        .enumerate()
        .fold(0usize, |acc, (i, v)| acc + v * i.max(1))
        % 103;

    if expected == found {
        Ok(())
    } else {
        Err(ScanError::BadChecksum { expected, found })
    }
}

/// Run the subset state machine over the decoded values.
fn to_text(values: &[usize]) -> Result<String, ScanError> {
    let mut subset = match values.first() {
        Some(&START_B) => 'B',
        Some(&START_C) => 'C',
        Some(&START_A) => 'A',
        Some(&other) => return Err(ScanError::BadStart(other)),
        None => return Err(ScanError::TooShort),
    };

    let mut out = String::new();

    // Skip the start character and stop before the checksum.
    for &value in &values[1..values.len() - 1] {
        match (subset, value) {
            (_, CODE_B) if subset != 'B' => subset = 'B',
            (_, CODE_C) if subset != 'C' => subset = 'C',
            (_, CODE_A) if subset != 'A' => subset = 'A',

            ('B', v) if v < 95 => out.push(char::from(v as u8 + 32)),
            ('A', v) if v < 64 => out.push(char::from(v as u8 + 32)),
            ('C', v) if v < 100 => {
                out.push(char::from(b'0' + (v / 10) as u8));
                out.push(char::from(b'0' + (v % 10) as u8));
            }
            (_, v) => return Err(ScanError::Unsupported(v)),
        }
    }

    Ok(out)
}

// ── Reading a label back off the page ───────────────────────────────────

/// Pull filled rectangles out of a PDF content stream.
///
/// The renderer writes `x y w h re f` for every bar, so parsing them back is a
/// direct read of what a printer would put on paper — not a re-derivation from
/// the symbol we started with.
pub fn filled_rects(pdf: &[u8]) -> Vec<(f32, f32, f32, f32)> {
    let text = String::from_utf8_lossy(pdf);
    let mut out = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if !line.ends_with(" re f") {
            continue;
        }
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 7 {
            continue;
        }
        let nums: Option<Vec<f32>> = fields[2..6].iter().map(|f| f.parse().ok()).collect();
        if let Some(n) = nums {
            out.push((n[0], n[1], n[2], n[3]));
        }
    }

    out
}

/// Raster a horizontal scan line across a set of bars at printer resolution.
///
/// Returns one bool per pixel, true where ink lands. This is the 1-D signal a
/// laser scanner's photodiode sees, so rastering at a realistic DPI is what
/// makes a test sensitive to bars too narrow to survive printing.
pub fn scan_line(rects: &[(f32, f32, f32, f32)], y: f32, dpi: f32) -> Vec<bool> {
    let crossing: Vec<&(f32, f32, f32, f32)> = rects
        .iter()
        .filter(|(_, ry, _, rh)| y >= *ry && y <= ry + rh)
        .collect();

    if crossing.is_empty() {
        return Vec::new();
    }

    let min_x = crossing.iter().map(|r| r.0).fold(f32::MAX, f32::min);
    let max_x = crossing.iter().map(|r| r.0 + r.2).fold(f32::MIN, f32::max);

    // A quiet zone either side, as a real label has.
    let quiet = 4.0 * crate::MM;
    let start = min_x - quiet;
    let end = max_x + quiet;
    let pixels = ((end - start) / 72.0 * dpi).ceil() as usize;

    (0..pixels)
        .map(|i| {
            // Sample at pixel centres: a scanner integrates over a pixel rather
            // than sampling its leading edge.
            let x = start + (i as f32 + 0.5) / dpi * 72.0;
            crossing
                .iter()
                .any(|(rx, _, rw, _)| x >= *rx && x < rx + rw)
        })
        .collect()
}

/// Print-and-scan a single-label PDF: raster the middle of its bars and decode.
pub fn scan_single_label(pdf: &[u8], dpi: f32) -> Result<String, ScanError> {
    let rects = filled_rects(pdf);
    if rects.is_empty() {
        return Err(ScanError::NoInk);
    }

    let top = rects.iter().map(|r| r.1 + r.3).fold(f32::MIN, f32::max);
    let bottom = rects.iter().map(|r| r.1).fold(f32::MAX, f32::min);
    let y = (top + bottom) / 2.0;

    decode_code128(&scan_line(&rects, y, dpi))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Render module widths into a pixel row, the way the PDF path eventually
    /// does — used only to test the decoder in isolation.
    fn pixels_from_modules(modules: &[u8], scale: usize) -> Vec<bool> {
        let mut out = vec![false; 10 * scale];
        let mut ink = true;
        for width in modules {
            out.extend(std::iter::repeat_n(ink, usize::from(*width) * scale));
            ink = !ink;
        }
        out.extend(std::iter::repeat_n(false, 10 * scale));
        out
    }

    /// One fully hand-computed symbol, to pin the table and the checksum.
    ///
    /// "A" in subset B is:
    ///   StartB  = 104 → "211214"
    ///   'A'     = 65 - 32 = 33 → "111323"
    ///   check   = (104 + 1 x 33) mod 103 = 34 → "131123"
    ///   stop    = "2331112"
    #[test]
    fn a_known_symbol_decodes() {
        assert_eq!(PATTERNS[104], "211214", "StartB pattern");
        assert_eq!(PATTERNS[33], "111323", "'A' pattern");
        assert_eq!(PATTERNS[34], "131123", "checksum 34 pattern");
        assert_eq!(PATTERNS[STOP], "2331112", "stop pattern");

        let modules: Vec<u8> = "211214111323131123 2331112"
            .bytes()
            .filter(|b| b.is_ascii_digit())
            .map(|b| b - b'0')
            .collect();

        let pixels = pixels_from_modules(&modules, 4);
        assert_eq!(decode_code128(&pixels).unwrap(), "A");
    }

    #[test]
    fn the_table_has_the_shape_the_specification_requires() {
        assert_eq!(PATTERNS.len(), 107);
        assert_eq!(PATTERNS[START_A], "211412");
        assert_eq!(PATTERNS[START_B], "211214");
        assert_eq!(PATTERNS[START_C], "211232");
    }

    #[test]
    fn no_ink_is_reported_rather_than_panicking() {
        assert_eq!(decode_code128(&[false; 100]), Err(ScanError::NoInk));
    }

    #[test]
    fn a_short_run_of_bars_is_not_a_symbol() {
        let pixels = pixels_from_modules(&[2, 1, 1, 2, 1, 4], 4);
        assert_eq!(decode_code128(&pixels), Err(ScanError::TooShort));
    }

    #[test]
    fn normalising_recovers_module_widths_from_ragged_pixels() {
        // 11 modules at 3.7 px each, rounded to whole pixels as a printer must.
        let group = [7, 4, 4, 8, 4, 14];
        assert_eq!(normalise(&group, 11).iter().sum::<usize>(), 11);
    }
}
