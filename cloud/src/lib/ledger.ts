// Appending to the stock ledger (CLAUDE.md §7).
//
//   Stock is never stored as a number you update. Stock is the sum of a ledger.
//
// Nothing here updates a quantity. Every movement is one INSERT; `item_stock`
// is maintained by the AFTER INSERT trigger and only ever read back. The
// negative-stock guard lives in that trigger too, so a refused ISSUE raises
// EL001 and the whole transaction rolls back — the ledger is what happened, not
// what was attempted.

import type { Sql, TransactionSql } from "postgres";
import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";

export type TxnType = "ISSUE" | "RECEIPT" | "ADJUST" | "OPENING" | "SCRAP";
export type AlertState = "OK" | "LOW" | "EMPTY";

export interface NewMovement {
  itemId: string;
  /** Negative for out, positive for in. Never zero — the check constraint refuses it. */
  deltaQty: string;
  txnType: TxnType;
  operatorId: string;
  sessionId?: string | null;
  machineId?: string | null;
  reasonId?: string | null;
  note?: string | null;
  unitCost?: string | null;
  deviceTs?: Date | null;
  clientTxnUuid?: string | null;
  reversesId?: number | null;
}

export interface MovementReceipt {
  ledger_id: number;
  item_id: string;
  delta_qty: string;
  on_hand: string;
  alert_state: AlertState;
  /** True only when this movement moved the item into a worse band. */
  crossed_threshold: boolean;
  created_at: Date;
}

type Db = Sql | TransactionSql;

export async function findByClientUuid(
  db: Db,
  clientTxnUuid: string,
): Promise<MovementReceipt | null> {
  // bigserial arrives as a string — postgres.js will not silently narrow a
  // bigint — so the id is converted once, here, rather than leaking a string
  // through an interface that promises a number.
  const rows = await db<
    {
      ledger_id: string;
      item_id: string;
      delta_qty: string;
      on_hand: string;
      alert_state: AlertState;
      created_at: Date;
    }[]
  >`
    select l.id as ledger_id, l.item_id, l.delta_qty::text as delta_qty,
           s.on_hand::text as on_hand, s.alert_state, l.created_at
      from stock_ledger l
      join item_stock s on s.item_id = l.item_id
     where l.client_txn_uuid = ${clientTxnUuid}
     limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return { ...row, ledger_id: Number(row.ledger_id), crossed_threshold: false };
}

/**
 * The insert itself, on a caller-supplied connection so one transaction can
 * span several appends. Not exported: `record` and `recordMany` are the only
 * ways stock moves.
 */
async function append(db: Db, m: NewMovement): Promise<MovementReceipt> {
  const prior = await db<{ alert_state: AlertState }[]>`
    select alert_state from item_stock where item_id = ${m.itemId}
  `;
  const priorAlert = prior[0]?.alert_state ?? null;

  const inserted = await db<{ id: string; delta_qty: string; created_at: Date }[]>`
    insert into stock_ledger (
      item_id, delta_qty, txn_type, operator_id, session_id,
      machine_id, reason_id, note, unit_cost, device_ts,
      client_txn_uuid, reverses_id
    ) values (
      ${m.itemId}, ${m.deltaQty}, ${m.txnType}, ${m.operatorId}, ${m.sessionId ?? null},
      ${m.machineId ?? null}, ${m.reasonId ?? null}, ${m.note ?? null},
      ${m.unitCost ?? null}, ${m.deviceTs ?? null},
      ${m.clientTxnUuid ?? null}, ${m.reversesId ?? null}
    )
    returning id, delta_qty::text as delta_qty, created_at
  `;

  const stock = await db<{ on_hand: string; alert_state: AlertState }[]>`
    select on_hand::text as on_hand, alert_state
      from item_stock where item_id = ${m.itemId}
  `;
  const balance = stock[0];
  if (!balance) {
    throw new ApiError(500, "NO_STOCK_ROW", "ledger insert left no stock row");
  }

  // A crossing is a move into a *worse* band, which is what the banner and the
  // alert row are for. Returning to OK is a resolution, not a crossing.
  const crossed =
    priorAlert !== null && priorAlert !== balance.alert_state && balance.alert_state !== "OK";

  return {
    ledger_id: Number(inserted[0].id),
    item_id: m.itemId,
    // Read back rather than echoed: the stored value carries the column's
    // scale, and it is the one reconcile will compare against.
    delta_qty: inserted[0].delta_qty,
    on_hand: balance.on_hand,
    alert_state: balance.alert_state,
    crossed_threshold: crossed,
    created_at: inserted[0].created_at,
  };
}

/** Append one movement and return the resulting balance. */
export async function record(m: NewMovement): Promise<MovementReceipt> {
  // An offline outbox replay must be a no-op, not a second issue. Checking
  // first keeps the common path cheap; the unique index is what actually
  // guarantees it under a race.
  if (m.clientTxnUuid) {
    const existing = await findByClientUuid(sql, m.clientTxnUuid);
    if (existing) return existing;
  }

  return sql.begin((tx) => append(tx, m)) as Promise<MovementReceipt>;
}

/**
 * Append several movements as one atomic step.
 *
 * §11's multi-machine issue: one operator taking one item for several machines
 * is one decision, recorded as one row per machine so consumption stays
 * attributable. The §7 guard therefore applies to the *set* — if the last split
 * would overdraw the bin, every row rolls back, not just that one. Splitting it
 * into separate requests could not work anyway: §10 closes the session on the
 * first submit.
 */
export async function recordMany(movements: NewMovement[]): Promise<MovementReceipt[]> {
  return sql.begin(async (tx) => {
    const receipts: MovementReceipt[] = [];
    for (const m of movements) {
      // Replay of a partially-acknowledged batch: answer the rows already in
      // the ledger from the ledger, and append only what is missing.
      if (m.clientTxnUuid) {
        const existing = await findByClientUuid(tx, m.clientTxnUuid);
        if (existing) {
          receipts.push(existing);
          continue;
        }
      }
      receipts.push(await append(tx, m));
    }
    return receipts;
  }) as Promise<MovementReceipt[]>;
}

/**
 * §7: a mistake is corrected by inserting the mirror image, never by editing
 * or deleting. `stock_ledger_one_reversal_per_row` means a correction applied
 * twice cannot silently double-count.
 */
export async function reverse(
  ledgerId: number,
  operatorId: string,
  note: string | null,
): Promise<MovementReceipt> {
  const rows = await sql<
    {
      item_id: string;
      delta_qty: string;
      txn_type: TxnType;
      unit_cost: string | null;
      machine_id: string | null;
      reason_id: string | null;
      reverses_id: string | null;
    }[]
  >`
    select item_id, delta_qty::text as delta_qty, txn_type, unit_cost::text as unit_cost,
           machine_id, reason_id, reverses_id
      from stock_ledger where id = ${ledgerId}
  `;
  const original = rows[0];
  if (!original) throw ApiError.notFound("no such ledger row");

  // Reversing a reversal would build a chain, and a chain double-counts: the
  // pair already nets to nothing, so a third row moves stock that was never
  // taken. `crates/store-db/src/ledger.rs` refuses this; so does this.
  if (original.reverses_id !== null) {
    throw ApiError.conflict(
      "NOT_REVERSIBLE",
      "That row is itself a reversal. Reverse the original instead.",
    );
  }

  const already = await sql<{ id: number }[]>`
    select id from stock_ledger where reverses_id = ${ledgerId}
  `;
  if (already.length > 0) {
    throw ApiError.conflict("ALREADY_REVERSED", "That row has already been reversed.");
  }

  return record({
    itemId: original.item_id,
    deltaQty: negate(original.delta_qty),
    txnType: original.txn_type,
    operatorId,
    // The correction is filed where the original was filed. Dropping these
    // used to leave the machine charged for stock that came back and file the
    // credit under "no machine recorded", which could make that bucket
    // negative — a quantity nothing consumed. §11 promises consumption stays
    // attributable per machine, and reports.ts claims reversals net themselves
    // out with no special case; neither was true per machine until the
    // reversal carried the same keys.
    //
    // `operator_id` is deliberately NOT copied: it is whoever performed the
    // correction. "Who moved this stock" has a real answer for a person and
    // no answer for a machine — a machine does not perform a reversal.
    machineId: original.machine_id,
    reasonId: original.reason_id,
    note: note ?? `reversal of ledger row ${ledgerId}`,
    unitCost: original.unit_cost,
    reversesId: ledgerId,
  });
}

function negate(decimal: string): string {
  return decimal.startsWith("-") ? decimal.slice(1) : `-${decimal}`;
}
