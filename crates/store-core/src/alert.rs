//! Reorder evaluation — the rule behind `item_stock.alert_state` and the
//! `stock_alerts` table.

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};

/// Where an item stands against its reorder level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AlertLevel {
    /// Above the reorder level. Nothing to say.
    Ok,
    /// At or below the reorder level, but there is still stock in the bin.
    Low,
    /// Nothing left (or the bin has gone negative on an `allow_negative` item).
    Empty,
}

impl AlertLevel {
    pub const fn as_str(self) -> &'static str {
        match self {
            AlertLevel::Ok => "OK",
            AlertLevel::Low => "LOW",
            AlertLevel::Empty => "EMPTY",
        }
    }

    /// True when this level belongs on the dashboard and the tablet banner.
    pub const fn needs_attention(self) -> bool {
        matches!(self, AlertLevel::Low | AlertLevel::Empty)
    }
}

impl std::fmt::Display for AlertLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for AlertLevel {
    type Err = crate::error::CoreError;

    fn from_str(s: &str) -> crate::error::Result<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "OK" => Ok(AlertLevel::Ok),
            "LOW" => Ok(AlertLevel::Low),
            "EMPTY" => Ok(AlertLevel::Empty),
            other => Err(crate::error::CoreError::UnknownSessionState(
                other.to_owned(),
            )),
        }
    }
}

/// Evaluate an item's stock position.
///
/// Two deliberate choices:
///
/// * `EMPTY` wins over `LOW`, and is decided by on-hand alone. An item at zero
///   is empty whether or not anybody configured a reorder level.
/// * A `reorder_level` of zero disables the `LOW` band rather than making every
///   item permanently low. Zero is the column default (§6), so most of the
///   catalog starts with no reorder policy at all, and a store full of spurious
///   LOW alerts is a store where nobody reads alerts.
pub fn evaluate(on_hand: Decimal, reorder_level: Decimal) -> AlertLevel {
    if on_hand <= Decimal::ZERO {
        AlertLevel::Empty
    } else if reorder_level > Decimal::ZERO && on_hand <= reorder_level {
        AlertLevel::Low
    } else {
        AlertLevel::Ok
    }
}

/// What the alert engine should do about a change in level.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AlertAction {
    /// Nothing changed.
    Unchanged,
    /// Open a `stock_alerts` row at this level.
    Raise(AlertLevel),
    /// The situation got worse — resolve the open row and raise a new one.
    Escalate { from: AlertLevel, to: AlertLevel },
    /// Stock came back. Resolve the open row.
    Resolve,
}

/// Decide what happens when an item moves from `previous` to `current`.
///
/// Recovery from EMPTY straight to LOW counts as an escalation in the other
/// direction — it still needs the open EMPTY row resolved and a LOW row opened,
/// which is exactly what `Escalate` describes.
pub fn action(previous: AlertLevel, current: AlertLevel) -> AlertAction {
    use AlertLevel as L;
    match (previous, current) {
        (a, b) if a == b => AlertAction::Unchanged,
        (L::Ok, b) => AlertAction::Raise(b),
        (_, L::Ok) => AlertAction::Resolve,
        (a, b) => AlertAction::Escalate { from: a, to: b },
    }
}

/// One item's position, as rendered on the dashboard and the tablet banner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StockPosition {
    pub on_hand: Decimal,
    pub reorder_level: Decimal,
    pub reorder_qty: Option<Decimal>,
    pub level: AlertLevel,
}

impl StockPosition {
    pub fn evaluate(
        on_hand: Decimal,
        reorder_level: Decimal,
        reorder_qty: Option<Decimal>,
    ) -> Self {
        StockPosition {
            on_hand,
            reorder_level,
            reorder_qty,
            level: evaluate(on_hand, reorder_level),
        }
    }

    /// How much to buy to get back above the reorder level.
    ///
    /// Prefers the configured `reorder_qty`; otherwise asks for just enough to
    /// clear the line.
    pub fn suggested_order_qty(&self) -> Option<Decimal> {
        if !self.level.needs_attention() {
            return None;
        }
        self.reorder_qty.or_else(|| {
            let shortfall = self.reorder_level - self.on_hand;
            (shortfall > Decimal::ZERO).then_some(shortfall)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn crossing_the_reorder_level_raises_low_then_empty_at_zero() {
        // The M8 gate, as a unit test.
        assert_eq!(evaluate(dec!(20), dec!(10)), AlertLevel::Ok);
        assert_eq!(evaluate(dec!(11), dec!(10)), AlertLevel::Ok);
        assert_eq!(
            evaluate(dec!(10), dec!(10)),
            AlertLevel::Low,
            "at the level"
        );
        assert_eq!(evaluate(dec!(1), dec!(10)), AlertLevel::Low);
        assert_eq!(evaluate(dec!(0), dec!(10)), AlertLevel::Empty);
    }

    #[test]
    fn a_zero_reorder_level_disables_the_low_band() {
        assert_eq!(evaluate(dec!(1), dec!(0)), AlertLevel::Ok);
        assert_eq!(evaluate(dec!(0.001), dec!(0)), AlertLevel::Ok);
    }

    #[test]
    fn zero_is_empty_even_with_no_reorder_policy() {
        assert_eq!(evaluate(dec!(0), dec!(0)), AlertLevel::Empty);
    }

    #[test]
    fn negative_stock_reads_as_empty() {
        // Reachable only on an `allow_negative` item (§7).
        assert_eq!(evaluate(dec!(-3), dec!(10)), AlertLevel::Empty);
    }

    #[test]
    fn fractional_levels_work_for_coolant() {
        assert_eq!(evaluate(dec!(4.999), dec!(5)), AlertLevel::Low);
        assert_eq!(evaluate(dec!(5.001), dec!(5)), AlertLevel::Ok);
    }

    #[test]
    fn actions_describe_the_whole_lifecycle() {
        use AlertLevel::*;
        assert_eq!(action(Ok, Ok), AlertAction::Unchanged);
        assert_eq!(action(Ok, Low), AlertAction::Raise(Low));
        assert_eq!(action(Ok, Empty), AlertAction::Raise(Empty));
        assert_eq!(
            action(Low, Empty),
            AlertAction::Escalate {
                from: Low,
                to: Empty
            }
        );
        assert_eq!(
            action(Empty, Low),
            AlertAction::Escalate {
                from: Empty,
                to: Low
            }
        );
        assert_eq!(action(Low, Ok), AlertAction::Resolve);
        assert_eq!(action(Empty, Ok), AlertAction::Resolve);
        assert_eq!(action(Empty, Empty), AlertAction::Unchanged);
    }

    #[test]
    fn suggested_order_prefers_the_configured_quantity() {
        let p = StockPosition::evaluate(dec!(2), dec!(10), Some(dec!(50)));
        assert_eq!(p.suggested_order_qty(), Some(dec!(50)));
    }

    #[test]
    fn suggested_order_falls_back_to_clearing_the_line() {
        let p = StockPosition::evaluate(dec!(2), dec!(10), None);
        assert_eq!(p.suggested_order_qty(), Some(dec!(8)));
    }

    #[test]
    fn a_healthy_item_suggests_nothing() {
        let p = StockPosition::evaluate(dec!(40), dec!(10), Some(dec!(50)));
        assert_eq!(p.suggested_order_qty(), None);
    }
}
