// The shared shape of a confirmed transaction, and the two pieces of ordering
// that make the offline outbox safe (CLAUDE.md §7, §10, §12).

import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";
import { getItem } from "./items.ts";
import { findByClientUuid, type MovementReceipt } from "./ledger.ts";
import { closeSession } from "./sessions.ts";

export interface TxnResponse {
  ledger_id: number;
  /**
   * Every row this request wrote. One entry for an ordinary transaction, one
   * per machine for a split issue — the success screen says how many rows a
   * single confirm produced, so an operator is never surprised by what turns up
   * in the ledger.
   */
  ledger_ids: number[];
  item_id: string;
  item_code: string;
  description: string;
  delta_qty: string;
  on_hand: string;
  alert_state: string;
  crossed_threshold: boolean;
}

/**
 * Answer a retried request from the ledger.
 *
 * This runs **before** session authorisation, and the order matters. §12's
 * outbox retries a request whose response was lost — the server committed it,
 * the acknowledgement never arrived. By then the session has closed on submit
 * (§10), so authorising first would answer 410 Gone for a transaction that is
 * sitting in the ledger. The tablet would report it to the operator as refused,
 * and the operator would re-enter it by hand: a real duplicate, created by the
 * very mechanism meant to prevent one.
 *
 * An idempotency key means "this exact request was already processed". The only
 * correct answer is the receipt we already produced.
 */
export async function replayed(
  clientTxnUuid: string | null | undefined,
  itemId: string,
): Promise<TxnResponse | null> {
  if (!clientTxnUuid) return null;

  const receipt = await findByClientUuid(sql, clientTxnUuid);
  if (!receipt) return null;

  // A client reusing one key for a different item is a bug on the tablet, and
  // answering with the wrong item's receipt would turn it into a stock
  // discrepancy.
  if (receipt.item_id !== itemId) {
    throw ApiError.conflict(
      "TXN_ID_REUSED",
      "That transaction id was already used for a different item.",
    );
  }

  const item = await getItem(receipt.item_id);
  console.info("[txn] replayed transaction answered from the ledger", {
    client_txn_uuid: clientTxnUuid,
    ledger_id: receipt.ledger_id,
  });

  return {
    ledger_id: receipt.ledger_id,
    ledger_ids: [receipt.ledger_id],
    item_id: receipt.item_id,
    item_code: item.item_code,
    description: item.description,
    delta_qty: receipt.delta_qty,
    on_hand: receipt.on_hand,
    alert_state: receipt.alert_state,
    // Not a fresh crossing: the banner already fired when this row was first
    // accepted.
    crossed_threshold: false,
  };
}

/** Close the session and answer for a single row. */
export async function finish(
  sessionId: string,
  itemId: string,
  receipt: MovementReceipt,
): Promise<TxnResponse> {
  return finishMany(sessionId, itemId, [receipt]);
}

/**
 * Close the session and answer for a batch.
 *
 * The balance reported is the one after the *last* row, because that is what
 * the bin holds now; the delta is the total that left it. Reporting one split's
 * figure would be true of nothing the operator did.
 */
export async function finishMany(
  sessionId: string,
  itemId: string,
  receipts: MovementReceipt[],
): Promise<TxnResponse> {
  const last = receipts[receipts.length - 1];
  if (!last) {
    throw ApiError.conflict("EMPTY_BATCH", "that transaction wrote no rows");
  }

  const item = await getItem(itemId);
  const total = receipts.reduce((sum, r) => sum + Number(r.delta_qty), 0);
  const crossed = receipts.some((r) => r.crossed_threshold);

  // §10: submit closes the session. Doing it here rather than making the
  // terminal call close means a device that dies mid-confirm still leaves a
  // tidy session behind.
  try {
    await closeSession(sessionId, "SUBMITTED");
  } catch (e) {
    // Never fail a recorded transaction because the tidy-up failed. The row is
    // in the ledger; the session will fall out of ACTIVE on its own.
    console.warn("[txn] could not close session after submit", { sessionId, error: e });
  }

  return {
    ledger_id: receipts[0].ledger_id,
    ledger_ids: receipts.map((r) => r.ledger_id),
    item_id: itemId,
    item_code: item.item_code,
    description: item.description,
    delta_qty: formatDelta(total),
    on_hand: last.on_hand,
    alert_state: last.alert_state,
    crossed_threshold: crossed,
  };
}

/** numeric(12,3) on the way out, so the UI never renders 5.999999999. */
function formatDelta(value: number): string {
  return value.toFixed(3);
}
