//! The M1 acceptance gate (CLAUDE.md §13).
//!
//! > Property test: 10 000 random ledger ops — `item_stock.on_hand` equals
//! > `SUM(delta_qty)` after every single one. Negative-stock guard holds.
//!
//! This is the pure half of that gate: it proves the fold in `store-core` is
//! the sum of its deltas. The other half — that the Postgres trigger
//! maintaining the cached `item_stock.on_hand` implements the same rule — lives
//! in `store-db/tests/ledger_trigger.rs`, and `store-cli reconcile` keeps
//! proving it in production.

use proptest::prelude::*;
use rust_decimal::Decimal;
use store_core::error::CoreError;
use store_core::ledger::{apply, sum_deltas, Movement, Qty, TxnType};
use uuid::Uuid;

fn item() -> Uuid {
    Uuid::from_u128(0xC0FFEE)
}

/// A generated operation: a transaction type and a magnitude in thousandths.
///
/// Magnitudes stay well under the `numeric(12,3)` ceiling so that a long run of
/// receipts cannot hit the range guard and mask a drift bug.
#[derive(Debug, Clone, Copy)]
struct Op {
    txn_type: TxnType,
    /// Magnitude in thousandths, always > 0.
    milli: i64,
}

impl Op {
    fn to_movement(self) -> Movement {
        let magnitude = Decimal::new(self.milli, 3);
        match self.txn_type {
            TxnType::Issue => Movement::issue(item(), Qty::new(magnitude).unwrap()),
            TxnType::Receipt => Movement::receipt(item(), Qty::new(magnitude).unwrap()),
            TxnType::Opening => Movement::opening(item(), Qty::new(magnitude).unwrap()),
            TxnType::Scrap => Movement::scrap(item(), Qty::new(magnitude).unwrap()),
            // Adjustments are the one signed case; alternate direction on parity
            // so the sequence exercises both.
            TxnType::Adjust => {
                let signed = if self.milli % 2 == 0 {
                    magnitude
                } else {
                    -magnitude
                };
                Movement::adjust(item(), signed).unwrap()
            }
        }
    }
}

fn any_op() -> impl Strategy<Value = Op> {
    (0usize..5, 1i64..500_000).prop_map(|(t, milli)| Op {
        txn_type: TxnType::ALL[t],
        milli,
    })
}

/// Replay `ops` against `apply`, asserting the running balance equals the sum
/// of the deltas actually accepted, after **every** operation.
///
/// Returns the number of operations the negative-stock guard refused.
fn replay(ops: &[Op], allow_negative: bool) -> usize {
    let mut on_hand = Decimal::ZERO;
    let mut accepted: Vec<Decimal> = Vec::with_capacity(ops.len());
    let mut refused = 0usize;

    for (i, op) in ops.iter().enumerate() {
        let movement = op.to_movement();
        assert!(
            movement.is_well_formed(),
            "op {i} produced a malformed movement: {movement:?}"
        );

        match apply(on_hand, &movement, allow_negative) {
            Ok(next) => {
                accepted.push(movement.delta_qty);
                on_hand = next;

                // The invariant, checked after every single operation.
                assert_eq!(
                    on_hand,
                    sum_deltas(&accepted),
                    "drift at op {i}: cached balance diverged from SUM(delta_qty)"
                );

                if !allow_negative {
                    assert!(
                        on_hand >= Decimal::ZERO,
                        "guard let on_hand go negative at op {i}"
                    );
                }
            }
            Err(CoreError::InsufficientStock {
                on_hand: reported,
                requested,
                ..
            }) => {
                refused += 1;
                assert!(!allow_negative, "guard fired on an allow_negative item");
                assert_eq!(reported, on_hand, "error reported a stale balance");
                assert!(
                    on_hand - requested < Decimal::ZERO,
                    "guard refused an op that would have stayed non-negative"
                );
                // A refused op must leave the ledger untouched.
                assert_eq!(on_hand, sum_deltas(&accepted));
            }
            Err(other) => panic!("op {i} failed unexpectedly: {other}"),
        }
    }

    // And once more at the end, against the full accepted history.
    assert_eq!(on_hand, sum_deltas(&accepted));
    refused
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    /// Broad search over short sequences — this is the one that finds edge cases.
    #[test]
    fn on_hand_equals_sum_of_deltas_after_every_op(
        ops in prop::collection::vec(any_op(), 1..200)
    ) {
        replay(&ops, false);
    }

    /// The same, on an item that is allowed to go negative. The balance must
    /// still equal the sum — the guard changes what is *accepted*, never what
    /// an accepted movement *does*.
    #[test]
    fn the_invariant_holds_when_negative_stock_is_allowed(
        ops in prop::collection::vec(any_op(), 1..200)
    ) {
        replay(&ops, true);
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 4, ..ProptestConfig::default() })]

    /// The gate as written: 10 000 random ledger ops in one sequence.
    #[test]
    fn ten_thousand_random_ledger_ops_never_drift(
        ops in prop::collection::vec(any_op(), 10_000..=10_000)
    ) {
        replay(&ops, false);
    }
}

#[test]
fn the_guard_actually_fires_in_a_random_run() {
    // A property test that never exercises the guard would pass vacuously.
    // Issue-heavy input from an empty store must hit it.
    let ops: Vec<Op> = (0..1000)
        .map(|i| Op {
            txn_type: if i % 4 == 0 {
                TxnType::Receipt
            } else {
                TxnType::Issue
            },
            milli: 1_000 + (i as i64 % 97) * 13,
        })
        .collect();

    let refused = replay(&ops, false);
    assert!(refused > 0, "the negative-stock guard was never exercised");

    // The same sequence on an allow_negative item refuses nothing.
    assert_eq!(replay(&ops, true), 0);
}

#[test]
fn a_reversal_returns_the_balance_to_where_it_started() {
    let mut on_hand = Decimal::ZERO;
    on_hand = apply(
        on_hand,
        &Movement::opening(item(), Qty::new(Decimal::new(100, 0)).unwrap()),
        false,
    )
    .unwrap();

    let issue = Movement::issue(item(), Qty::new(Decimal::new(40, 0)).unwrap());
    on_hand = apply(on_hand, &issue, false).unwrap();
    assert_eq!(on_hand, Decimal::new(60, 0));

    // §7: correct by appending the mirror image, never by editing.
    let entry = store_core::ledger::LedgerEntry {
        id: 1,
        item_id: item(),
        delta_qty: issue.delta_qty,
        txn_type: issue.txn_type,
        operator_id: Uuid::nil(),
        session_id: None,
        machine_id: None,
        reason_id: None,
        note: None,
        unit_cost: None,
        device_ts: None,
        created_at: chrono::Utc::now(),
        reverses_id: None,
    };
    let reversal = Movement::reversal_of(&entry).unwrap();
    on_hand = apply(on_hand, &reversal, false).unwrap();

    assert_eq!(on_hand, Decimal::new(100, 0));
    assert_eq!(reversal.reverses_id, Some(1));
}
