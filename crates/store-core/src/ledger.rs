//! The stock ledger — CLAUDE.md §7.
//!
//! **Stock is never stored as a number you update. Stock is the sum of a ledger.**
//!
//! Everything in this module exists to keep that sentence true:
//!
//! * a movement is an *append*, never an edit;
//! * a mistake is corrected by a reversing row, never by deletion;
//! * `on_hand` is a fold of deltas, so "log history" and "current stock" are
//!   the same object rather than two things that quietly disagree.

use chrono::{DateTime, Utc};
use rust_decimal::prelude::ToPrimitive;
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{CoreError, Result, QTY_SCALE};

/// Largest magnitude representable in `numeric(12,3)`: 12 significant digits,
/// 3 of them after the point.
pub fn qty_max() -> Decimal {
    Decimal::new(999_999_999_999, QTY_SCALE)
}

/// Reject a quantity the `numeric(12,3)` columns cannot hold losslessly.
///
/// Doing this in the domain rather than letting Postgres raise means the tablet
/// gets a sentence an operator can act on instead of a driver error.
pub fn validate_qty_domain(qty: Decimal) -> Result<Decimal> {
    let normalized = qty.normalize();
    if normalized.scale() > QTY_SCALE {
        return Err(CoreError::QuantityTooPrecise(qty));
    }
    if normalized.abs() > qty_max() {
        return Err(CoreError::QuantityOutOfRange(qty));
    }
    Ok(qty)
}

/// A strictly positive movement magnitude.
///
/// Direction lives in [`TxnType`], not in the number the operator typed. An
/// operator taking stock out enters `5`, not `-5`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "Decimal", into = "Decimal")]
pub struct Qty(Decimal);

impl Qty {
    /// Build a quantity, rejecting zero, negatives and anything the column
    /// cannot hold.
    pub fn new(value: Decimal) -> Result<Self> {
        if value <= Decimal::ZERO {
            return Err(CoreError::NonPositiveQuantity(value));
        }
        validate_qty_domain(value)?;
        Ok(Qty(value))
    }

    pub const fn get(self) -> Decimal {
        self.0
    }
}

impl TryFrom<Decimal> for Qty {
    type Error = CoreError;
    fn try_from(value: Decimal) -> Result<Self> {
        Qty::new(value)
    }
}

impl From<Qty> for Decimal {
    fn from(q: Qty) -> Decimal {
        q.0
    }
}

impl std::fmt::Display for Qty {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Why stock moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TxnType {
    /// Operator took tooling out to a machine.
    Issue,
    /// Storekeeper booked stock in (§2: no PO/GRN — this is the inward path).
    Receipt,
    /// Physical count differs from the system; signed either way.
    Adjust,
    /// The balance the store started with when it was first loaded.
    Opening,
    /// Written off — damaged in the bin, expired coolant.
    Scrap,
}

/// Which signs a transaction type is allowed to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignRule {
    /// Stock leaves: delta must be negative.
    Negative,
    /// Stock arrives: delta must be positive.
    Positive,
    /// Either direction is meaningful.
    Either,
}

impl TxnType {
    pub const fn as_str(self) -> &'static str {
        match self {
            TxnType::Issue => "ISSUE",
            TxnType::Receipt => "RECEIPT",
            TxnType::Adjust => "ADJUST",
            TxnType::Opening => "OPENING",
            TxnType::Scrap => "SCRAP",
        }
    }

    /// The sign this type is allowed to carry.
    pub const fn sign_rule(self) -> SignRule {
        match self {
            TxnType::Issue | TxnType::Scrap => SignRule::Negative,
            TxnType::Receipt | TxnType::Opening => SignRule::Positive,
            TxnType::Adjust => SignRule::Either,
        }
    }

    /// True when this type draws stock down and therefore faces the §7
    /// negative-stock guard.
    pub const fn is_outward(self) -> bool {
        matches!(self.sign_rule(), SignRule::Negative)
    }

    pub const ALL: [TxnType; 5] = [
        TxnType::Issue,
        TxnType::Receipt,
        TxnType::Adjust,
        TxnType::Opening,
        TxnType::Scrap,
    ];
}

impl std::fmt::Display for TxnType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for TxnType {
    type Err = CoreError;

    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_uppercase().as_str() {
            "ISSUE" => Ok(TxnType::Issue),
            "RECEIPT" => Ok(TxnType::Receipt),
            "ADJUST" => Ok(TxnType::Adjust),
            "OPENING" => Ok(TxnType::Opening),
            "SCRAP" => Ok(TxnType::Scrap),
            _ => Err(CoreError::UnknownTxnType(s.to_owned())),
        }
    }
}

/// A validated intent to append one row to `stock_ledger`.
///
/// Construction is the only place sign and magnitude are decided, so no caller
/// can accidentally book an ISSUE that increases stock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Movement {
    pub item_id: Uuid,
    pub txn_type: TxnType,
    /// Negative = out, positive = in. Never zero (§6).
    pub delta_qty: Decimal,
    /// Set only on a correction row, pointing at the row being undone.
    pub reverses_id: Option<i64>,
}

impl Movement {
    /// Stock leaving the store.
    pub fn issue(item_id: Uuid, qty: Qty) -> Self {
        Movement::outward(item_id, TxnType::Issue, qty)
    }

    /// Stock booked in by the storekeeper.
    pub fn receipt(item_id: Uuid, qty: Qty) -> Self {
        Movement::inward(item_id, TxnType::Receipt, qty)
    }

    /// The balance the store started with.
    pub fn opening(item_id: Uuid, qty: Qty) -> Self {
        Movement::inward(item_id, TxnType::Opening, qty)
    }

    /// Written off.
    pub fn scrap(item_id: Uuid, qty: Qty) -> Self {
        Movement::outward(item_id, TxnType::Scrap, qty)
    }

    /// A signed correction from a physical count.
    ///
    /// `signed_delta` carries its own direction because an adjustment is the
    /// one case where the operator genuinely means "up" or "down".
    pub fn adjust(item_id: Uuid, signed_delta: Decimal) -> Result<Self> {
        if signed_delta.is_zero() {
            return Err(CoreError::ZeroDelta);
        }
        validate_qty_domain(signed_delta)?;
        Ok(Movement {
            item_id,
            txn_type: TxnType::Adjust,
            delta_qty: signed_delta,
            reverses_id: None,
        })
    }

    fn inward(item_id: Uuid, txn_type: TxnType, qty: Qty) -> Self {
        Movement {
            item_id,
            txn_type,
            delta_qty: qty.get(),
            reverses_id: None,
        }
    }

    fn outward(item_id: Uuid, txn_type: TxnType, qty: Qty) -> Self {
        Movement {
            item_id,
            txn_type,
            delta_qty: -qty.get(),
            reverses_id: None,
        }
    }

    /// The correction row that undoes `entry`.
    ///
    /// §7: a mistake is corrected by *inserting* the mirror image, never by
    /// editing or deleting the original. The reversal keeps the original's
    /// transaction type so that a reversed ISSUE still reads as issue activity
    /// in the audit trail, with `reverses_id` marking it as an undo.
    pub fn reversal_of(entry: &LedgerEntry) -> Result<Self> {
        if entry.delta_qty.is_zero() {
            return Err(CoreError::ZeroDelta);
        }
        Ok(Movement {
            item_id: entry.item_id,
            txn_type: entry.txn_type,
            delta_qty: -entry.delta_qty,
            reverses_id: Some(entry.id),
        })
    }

    /// True when this movement obeys its type's sign rule and is non-zero.
    ///
    /// Constructors guarantee this; the check exists so that rows read back
    /// from the database can be audited against the same rule.
    pub fn is_well_formed(&self) -> bool {
        if self.delta_qty.is_zero() {
            return false;
        }
        // A reversal legitimately runs against its type's sign rule: undoing an
        // ISSUE puts stock back.
        if self.reverses_id.is_some() {
            return true;
        }
        match self.txn_type.sign_rule() {
            SignRule::Negative => self.delta_qty < Decimal::ZERO,
            SignRule::Positive => self.delta_qty > Decimal::ZERO,
            SignRule::Either => true,
        }
    }
}

/// A row as it exists in `stock_ledger`. Immutable by construction — there are
/// no `&mut self` methods here, and there is no code path that updates one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LedgerEntry {
    pub id: i64,
    pub item_id: Uuid,
    pub delta_qty: Decimal,
    pub txn_type: TxnType,
    pub operator_id: Uuid,
    pub session_id: Option<Uuid>,
    pub machine_id: Option<Uuid>,
    pub reason_id: Option<Uuid>,
    pub note: Option<String>,
    pub unit_cost: Option<Decimal>,
    /// What the terminal claimed. Diagnostic only (§9.3).
    pub device_ts: Option<DateTime<Utc>>,
    /// What the server observed. **This is the business timestamp.**
    pub created_at: DateTime<Utc>,
    pub reverses_id: Option<i64>,
}

/// Fold one movement into a running on-hand, enforcing the §7 guard.
///
/// This is the single definition of what a movement does to stock. The database
/// trigger maintaining `item_stock.on_hand` implements the same rule, and
/// `store-cli reconcile` exists to prove the two never drift.
pub fn apply(on_hand: Decimal, movement: &Movement, allow_negative: bool) -> Result<Decimal> {
    if movement.delta_qty.is_zero() {
        return Err(CoreError::ZeroDelta);
    }
    let next = on_hand + movement.delta_qty;

    if next < Decimal::ZERO && !allow_negative && movement.delta_qty < Decimal::ZERO {
        return Err(CoreError::InsufficientStock {
            item_id: movement.item_id,
            on_hand,
            requested: -movement.delta_qty,
        });
    }
    validate_qty_domain(next)?;
    Ok(next)
}

/// Fold a whole sequence, stopping at the first movement the guard refuses.
///
/// Returns the final on-hand. Used by tests and by `store-cli reconcile` to
/// recompute a balance from raw history.
pub fn fold(opening: Decimal, movements: &[Movement], allow_negative: bool) -> Result<Decimal> {
    movements
        .iter()
        .try_fold(opening, |acc, m| apply(acc, m, allow_negative))
}

/// The sum of a set of deltas, with no guard applied.
///
/// This is the reconciliation ground truth: whatever the cached read model
/// says, `SUM(delta_qty)` is what actually happened.
pub fn sum_deltas(deltas: &[Decimal]) -> Decimal {
    deltas.iter().copied().sum()
}

/// Total value of a movement at the cost snapshot taken when it was booked.
///
/// `None` when the item had no cost recorded — valuing at today's price would
/// quietly rewrite last year's consumption reports.
pub fn extended_cost(delta_qty: Decimal, unit_cost: Option<Decimal>) -> Option<Decimal> {
    let unit_cost = unit_cost?;
    let value = (delta_qty.abs() * unit_cost).round_dp(2);
    value.to_f64().is_some().then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn item() -> Uuid {
        Uuid::from_u128(1)
    }

    fn qty(d: Decimal) -> Qty {
        Qty::new(d).expect("test quantity is valid")
    }

    #[test]
    fn quantity_rejects_zero_and_negatives() {
        assert!(matches!(
            Qty::new(Decimal::ZERO),
            Err(CoreError::NonPositiveQuantity(_))
        ));
        assert!(matches!(
            Qty::new(dec!(-1)),
            Err(CoreError::NonPositiveQuantity(_))
        ));
        assert!(Qty::new(dec!(0.001)).is_ok());
    }

    #[test]
    fn quantity_rejects_precision_the_column_cannot_hold() {
        assert!(matches!(
            Qty::new(dec!(1.0005)),
            Err(CoreError::QuantityTooPrecise(_))
        ));
        // Trailing zeros are not extra precision.
        assert!(Qty::new(dec!(1.5000)).is_ok());
    }

    #[test]
    fn quantity_rejects_values_past_the_column_range() {
        assert!(Qty::new(qty_max()).is_ok());
        assert!(matches!(
            Qty::new(qty_max() + dec!(0.001)),
            Err(CoreError::QuantityOutOfRange(_))
        ));
    }

    #[test]
    fn direction_comes_from_the_txn_type_not_the_operator() {
        assert_eq!(Movement::issue(item(), qty(dec!(5))).delta_qty, dec!(-5));
        assert_eq!(Movement::receipt(item(), qty(dec!(5))).delta_qty, dec!(5));
        assert_eq!(Movement::scrap(item(), qty(dec!(2))).delta_qty, dec!(-2));
        assert_eq!(Movement::opening(item(), qty(dec!(9))).delta_qty, dec!(9));
    }

    #[test]
    fn every_constructed_movement_is_well_formed() {
        assert!(Movement::issue(item(), qty(dec!(5))).is_well_formed());
        assert!(Movement::receipt(item(), qty(dec!(5))).is_well_formed());
        assert!(Movement::adjust(item(), dec!(-3)).unwrap().is_well_formed());
        assert!(Movement::adjust(item(), dec!(3)).unwrap().is_well_formed());
    }

    #[test]
    fn adjust_refuses_a_zero_delta() {
        assert!(matches!(
            Movement::adjust(item(), Decimal::ZERO),
            Err(CoreError::ZeroDelta)
        ));
    }

    #[test]
    fn issue_beyond_stock_is_refused() {
        let m = Movement::issue(item(), qty(dec!(5)));
        let err = apply(dec!(3), &m, false).unwrap_err();
        assert_eq!(
            err,
            CoreError::InsufficientStock {
                item_id: item(),
                on_hand: dec!(3),
                requested: dec!(5),
            }
        );
    }

    #[test]
    fn issue_beyond_stock_is_allowed_when_the_item_opts_in() {
        let m = Movement::issue(item(), qty(dec!(5)));
        assert_eq!(apply(dec!(3), &m, true).unwrap(), dec!(-2));
    }

    #[test]
    fn issuing_exactly_the_balance_lands_on_zero() {
        let m = Movement::issue(item(), qty(dec!(3)));
        assert_eq!(apply(dec!(3), &m, false).unwrap(), Decimal::ZERO);
    }

    #[test]
    fn receipts_are_never_blocked_by_a_negative_balance() {
        let m = Movement::receipt(item(), qty(dec!(5)));
        assert_eq!(apply(dec!(-2), &m, false).unwrap(), dec!(3));
    }

    #[test]
    fn a_reversal_is_the_mirror_image_and_points_at_the_original() {
        let entry = LedgerEntry {
            id: 42,
            item_id: item(),
            delta_qty: dec!(-5),
            txn_type: TxnType::Issue,
            operator_id: Uuid::from_u128(7),
            session_id: None,
            machine_id: None,
            reason_id: None,
            note: None,
            unit_cost: None,
            device_ts: None,
            created_at: Utc::now(),
            reverses_id: None,
        };
        let rev = Movement::reversal_of(&entry).unwrap();
        assert_eq!(rev.delta_qty, dec!(5));
        assert_eq!(rev.txn_type, TxnType::Issue);
        assert_eq!(rev.reverses_id, Some(42));
        assert!(rev.is_well_formed());
        // Reversing the reversal returns the original delta — the ledger folds
        // back to where it started.
        assert_eq!(entry.delta_qty + rev.delta_qty, Decimal::ZERO);
    }

    #[test]
    fn fold_stops_at_the_first_refused_movement() {
        let ms = [
            Movement::receipt(item(), qty(dec!(10))),
            Movement::issue(item(), qty(dec!(4))),
            Movement::issue(item(), qty(dec!(20))),
        ];
        assert!(matches!(
            fold(Decimal::ZERO, &ms, false),
            Err(CoreError::InsufficientStock { .. })
        ));
        assert_eq!(fold(Decimal::ZERO, &ms[..2], false).unwrap(), dec!(6));
    }

    #[test]
    fn extended_cost_uses_magnitude_not_sign() {
        assert_eq!(
            extended_cost(dec!(-5), Some(dec!(120.50))),
            Some(dec!(602.50))
        );
        assert_eq!(extended_cost(dec!(5), None), None);
    }

    #[test]
    fn txn_type_round_trips_through_its_token() {
        for t in TxnType::ALL {
            assert_eq!(t.as_str().parse::<TxnType>().unwrap(), t);
        }
        assert!("RETURN".parse::<TxnType>().is_err());
    }
}
