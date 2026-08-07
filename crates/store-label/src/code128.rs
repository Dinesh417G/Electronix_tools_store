//! Code 128 encoding (CLAUDE.md §6, §13 M7).
//!
//! The item code *is* the barcode payload, so this is the piece that decides
//! whether a printed bin label can be scanned back. Getting it subtly wrong
//! produces labels that scan on the developer's phone and fail on the shop
//! floor, which is the worst possible failure mode — so the invariants every
//! Code 128 symbol must satisfy are asserted in tests rather than assumed.
//!
//! Subsets B and C only. Subset A exists for control characters, which never
//! appear in a tool crib's item codes; leaving it out removes a switching path
//! that would otherwise be written and never exercised.

/// Bar and space widths for each Code 128 value, as module counts.
///
/// Every entry alternates bar, space, bar, space, bar, space — six elements
/// summing to 11 modules — except the stop pattern, which has seven and sums
/// to 13. `patterns_are_well_formed` checks that on every entry.
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

const START_B: usize = 104;
const START_C: usize = 105;
const CODE_B: usize = 100;
const CODE_C: usize = 99;
const STOP: usize = 106;

/// A symbol, as the alternating run lengths a printer draws.
///
/// `modules[0]` is a bar, `modules[1]` a space, and so on. Keeping it as run
/// lengths rather than a pixel bitmap is what lets the PDF writer scale the
/// symbol to whatever module width the label needs without rounding drift
/// accumulating across ninety bars.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Symbol {
    /// Alternating bar/space widths in modules, starting with a bar.
    pub modules: Vec<u8>,
    /// The payload, for the human-readable line under the bars.
    pub text: String,
}

impl Symbol {
    /// Total width in modules, excluding quiet zones.
    pub fn width_modules(&self) -> u32 {
        self.modules.iter().map(|m| u32::from(*m)).sum()
    }

    /// The bars only, as `(start_module, width_modules)` pairs.
    ///
    /// This is what a renderer draws: spaces are simply not drawn.
    pub fn bars(&self) -> Vec<(u32, u32)> {
        let mut out = Vec::with_capacity(self.modules.len() / 2 + 1);
        let mut cursor = 0u32;
        for (i, width) in self.modules.iter().enumerate() {
            let width = u32::from(*width);
            if i % 2 == 0 {
                out.push((cursor, width));
            }
            cursor += width;
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Code128Error {
    #[error("nothing to encode")]
    Empty,
    #[error("{0:?} is not encodable in Code 128 subset B (printable 7-bit ASCII only)")]
    NotEncodable(char),
}

/// Encode `data` as Code 128.
///
/// Runs of six or more digits switch to subset C, which packs two digits per
/// symbol character. A code like `CNMG120408-TN2000` is roughly a fifth
/// narrower that way, and on a bin front a fifth is the difference between a
/// label that fits and one that wraps.
pub fn encode(data: &str) -> Result<Symbol, Code128Error> {
    if data.is_empty() {
        return Err(Code128Error::Empty);
    }
    for ch in data.chars() {
        if !(' '..='~').contains(&ch) {
            return Err(Code128Error::NotEncodable(ch));
        }
    }

    let bytes: Vec<u8> = data.bytes().collect();
    let mut values: Vec<usize> = Vec::with_capacity(bytes.len() + 4);

    // Choosing the start subset: a leading run of digits long enough to pay for
    // itself starts in C, everything else in B.
    let mut index = 0usize;
    let leading_digits = digit_run(&bytes, 0);
    let mut in_subset_c = should_use_c(leading_digits, true);
    values.push(if in_subset_c { START_C } else { START_B });

    while index < bytes.len() {
        if in_subset_c {
            let run = digit_run(&bytes, index);
            if run >= 2 {
                // Pairs only; an odd digit at the end drops back to B.
                let pairs = run / 2;
                for _ in 0..pairs {
                    let hi = bytes[index] - b'0';
                    let lo = bytes[index + 1] - b'0';
                    values.push(usize::from(hi) * 10 + usize::from(lo));
                    index += 2;
                }
            } else {
                values.push(CODE_B);
                in_subset_c = false;
            }
        } else {
            let run = digit_run(&bytes, index);
            if should_use_c(run, index == 0) {
                values.push(CODE_C);
                in_subset_c = true;
                continue;
            }
            values.push(usize::from(bytes[index]) - 32);
            index += 1;
        }
    }

    // Modulo-103 checksum, weighted by position. The start character is
    // weight 1; every data character after it is weighted by its 1-based index.
    let checksum = values
        .iter()
        .enumerate()
        .fold(0usize, |acc, (i, value)| acc + value * i.max(1))
        % 103;
    values.push(checksum);
    values.push(STOP);

    let mut modules = Vec::with_capacity(values.len() * 6 + 1);
    for value in &values {
        for digit in PATTERNS[*value].bytes() {
            modules.push(digit - b'0');
        }
    }

    Ok(Symbol {
        modules,
        text: data.to_owned(),
    })
}

/// Length of the run of ASCII digits starting at `from`.
fn digit_run(bytes: &[u8], from: usize) -> usize {
    bytes[from..]
        .iter()
        .take_while(|b| b.is_ascii_digit())
        .count()
}

/// Whether a digit run is worth switching to subset C for.
///
/// Switching costs one character and saves half of the run. Four digits at the
/// start (no switch character needed) or six mid-code is where it breaks even;
/// below that, switching makes the symbol wider, not narrower.
fn should_use_c(run: usize, at_start: bool) -> bool {
    let threshold = if at_start { 4 } else { 6 };
    // An even run at the threshold pays for itself; an odd run needs one more
    // digit, because the trailing odd digit costs a switch back to B.
    (run >= threshold && run % 2 == 0) || run > threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every Code 128 pattern has a fixed shape. A single transposed digit in
    /// the table would print a symbol that looks plausible and scans as the
    /// wrong character — or not at all — so this checks the table itself rather
    /// than trusting it.
    #[test]
    fn patterns_are_well_formed() {
        for (value, pattern) in PATTERNS.iter().enumerate() {
            let widths: Vec<u32> = pattern.bytes().map(|b| u32::from(b - b'0')).collect();

            if value == STOP {
                assert_eq!(widths.len(), 7, "stop pattern has 7 elements");
                assert_eq!(widths.iter().sum::<u32>(), 13, "stop pattern is 13 modules");
                continue;
            }

            assert_eq!(widths.len(), 6, "value {value} should have 6 elements");
            assert_eq!(
                widths.iter().sum::<u32>(),
                11,
                "value {value} should be 11 modules wide"
            );

            // Bars are the even-indexed elements, and in Code 128 they always
            // sum to an even number of modules. This is the property that
            // catches a transposition the width check would miss.
            let bar_modules: u32 = widths.iter().step_by(2).sum();
            assert_eq!(
                bar_modules % 2,
                0,
                "value {value} has odd bar modules ({bar_modules})"
            );

            assert!(
                widths.iter().all(|w| (1..=4).contains(w)),
                "value {value} has an element outside 1..=4 modules"
            );
        }
    }

    #[test]
    fn every_pattern_is_distinct() {
        // Two identical patterns would make one character undecodable.
        let mut seen = std::collections::HashSet::new();
        for pattern in PATTERNS {
            assert!(seen.insert(pattern), "duplicate pattern {pattern}");
        }
    }

    #[test]
    fn a_symbol_starts_with_a_bar_and_ends_with_one() {
        // The stop pattern's 7 elements mean the symbol ends on a bar, which is
        // what lets a scanner find the trailing edge.
        let symbol = encode("ABC").unwrap();
        assert_eq!(symbol.modules.len() % 2, 1, "should end on a bar");
    }

    #[test]
    fn subset_b_encodes_a_plain_code() {
        // StartB + 'A' + checksum + stop = 4 characters = 3*11 + 13 modules.
        let symbol = encode("A").unwrap();
        assert_eq!(symbol.width_modules(), 11 * 3 + 13);
    }

    #[test]
    fn the_checksum_is_computed_over_the_weighted_values() {
        // Hand-computed: StartB = 104, 'A' = 65 - 32 = 33, weight 1.
        // (104 + 33) % 103 = 34.
        let symbol = encode("A").unwrap();
        let expected_checksum_pattern = PATTERNS[34];
        let widths: Vec<u8> = expected_checksum_pattern
            .bytes()
            .map(|b| b - b'0')
            .collect();

        // The checksum is the third character: skip StartB and 'A'.
        assert_eq!(&symbol.modules[12..18], widths.as_slice());
    }

    #[test]
    fn long_digit_runs_switch_to_subset_c() {
        // Eight digits: subset B needs 8 characters, subset C needs 4.
        let b_only = encode("ABCDEFGH").unwrap().width_modules();
        let digits = encode("12345678").unwrap().width_modules();
        assert!(
            digits < b_only,
            "subset C should be narrower: {digits} vs {b_only}"
        );
    }

    #[test]
    fn short_digit_runs_stay_in_subset_b() {
        // Switching costs a character; below the break-even it makes the symbol
        // wider, which on a bin front is a real cost.
        let two_digits = encode("AB12CD").unwrap();
        let all_letters = encode("ABXYCD").unwrap();
        assert_eq!(
            two_digits.width_modules(),
            all_letters.width_modules(),
            "a two-digit run should not trigger a subset switch"
        );
    }

    #[test]
    fn real_tooling_codes_encode() {
        for code in [
            "CNMG120408-TN2000",
            "EM-06-4F-TIALN",
            "DR-8.5-HSS",
            "TAP-M10-HSS",
            "COOL-SYN-20L",
            "A-01-1",
            "8901234567890",
        ] {
            let symbol = encode(code).expect(code);
            assert!(symbol.width_modules() > 35, "{code} is suspiciously narrow");
            assert_eq!(symbol.text, code);
        }
    }

    #[test]
    fn unencodable_input_is_refused_rather_than_mangled() {
        assert_eq!(encode(""), Err(Code128Error::Empty));
        assert!(matches!(
            encode("TOOL\u{00e9}"),
            Err(Code128Error::NotEncodable(_))
        ));
        assert!(matches!(
            encode("TOOL\u{0007}"),
            Err(Code128Error::NotEncodable(_))
        ));
    }

    #[test]
    fn bars_cover_the_symbol_without_gaps_or_overlap() {
        let symbol = encode("CNMG120408-TN2000").unwrap();
        let bars = symbol.bars();

        // Bars are the even-indexed runs, so there should be one per pair
        // plus the final one from the stop pattern.
        assert_eq!(bars.len(), symbol.modules.len().div_ceil(2));

        for window in bars.windows(2) {
            let (start_a, width_a) = window[0];
            let (start_b, _) = window[1];
            assert!(
                start_a + width_a < start_b,
                "bars must be separated by a space"
            );
        }

        let (last_start, last_width) = *bars.last().unwrap();
        assert_eq!(
            last_start + last_width,
            symbol.width_modules(),
            "the symbol should end on the trailing bar"
        );
    }
}
