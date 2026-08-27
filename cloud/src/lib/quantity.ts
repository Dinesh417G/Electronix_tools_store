// The quantity and money domains, and the zod schemas that hold callers to
// them. The Rust port of this is `store_core::ledger::validate_qty_domain`.
//
// Why it exists on this side too, when the columns already refuse a bad value:
// they refuse it as `22003 numeric field overflow`, from inside the driver,
// after the request has been authorised and a transaction opened. api-error.ts
// translates the §7 trigger codes for exactly this reason — "a refused ISSUE
// must reach the operator as 'count the bin', not as a 500" — and a quantity
// the column cannot hold deserves the same treatment. Rejecting it here gives
// the tablet a sentence it can show, before anything is written.
//
// The bounds are the columns', not opinions:
//
//   quantities  numeric(12,3)  → |q| < 10^9, three decimals   → 999999999.999
//   money       numeric(12,2)  → |v| < 10^10, two decimals    → 9999999999.99
//
// Postgres states the first itself: "A field with precision 12, scale 3 must
// round to an absolute value less than 10^9."

import { z } from "zod";

/** Largest quantity `numeric(12,3)` holds losslessly. */
export const QTY_MAX = 999_999_999.999;

/** Largest money value `numeric(12,2)` holds losslessly. */
export const COST_MAX = 9_999_999_999.99;

/**
 * A quantity as the API receives it: a decimal *string*, so no value is routed
 * through a float on its way to a `numeric` column.
 *
 * Positive by construction — direction comes from the txn type, never from the
 * sign the caller sent (§7). Three decimals, because coolant and bar stock are
 * not whole numbers and a fourth would be silently rounded by the column.
 */
export const QtyString = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, "quantity must be a positive number with at most 3 decimals")
  .refine((q) => Number(q) > 0, "quantity must be greater than zero")
  .refine(
    (q) => Number(q) <= QTY_MAX,
    `quantity must be ${QTY_MAX} or less — that is the largest the stock columns hold`,
  );

/** A money amount as the API receives it. Same reasoning, two decimals. */
export const CostString = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, "cost must be a positive number with at most 2 decimals")
  .refine(
    (v) => Number(v) <= COST_MAX,
    `cost must be ${COST_MAX} or less — that is the largest the money columns hold`,
  );
