// POST /api/v1/txn/issue — TAKE OUT.
//
// Two shapes, one endpoint (§11):
//
//   { session_id, item_id, qty, machine_id?, reason_id?, note? }
//   { session_id, item_id, reason_id?, note?, splits: [{ machine_id, qty }] }
//
// The split form writes one ledger row per machine inside one transaction, so
// the §7 negative-stock guard applies to the total: an operator who asks for
// more than the bin holds gets nothing written, rather than the first two
// machines served and the third refused.

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { findByClientUuid, record, recordMany, type NewMovement } from "@/lib/ledger";
import { sql } from "@/lib/db";
import { QtyString } from "@/lib/quantity";
import { authoriseSession } from "@/lib/sessions";
import { finish, finishMany, replayed } from "@/lib/txn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Split = z.object({
  machine_id: z.string().uuid(),
  qty: QtyString,
  client_txn_uuid: z.string().uuid().optional(),
});

const Body = z.object({
  session_id: z.string().uuid(),
  item_id: z.string().uuid(),
  qty: QtyString.optional(),
  machine_id: z.string().uuid().nullish(),
  reason_id: z.string().uuid().nullish(),
  note: z.string().max(500).nullish(),
  client_txn_uuid: z.string().uuid().optional(),
  splits: z.array(Split).max(20).optional(),
});

export const POST = handler(async (request: Request) => {
  const auth = await authenticate(request);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw ApiError.badRequest("malformed issue", parsed.error.issues);
  }
  const body = parsed.data;

  if (body.splits && body.splits.length > 0) {
    return NextResponse.json(await issueSplit(auth, body));
  }

  if (!body.qty) throw ApiError.badRequest("qty is required without splits");

  const replay = await replayed(body.client_txn_uuid, body.item_id);
  if (replay) return NextResponse.json(replay);

  const operatorId = await authoriseSession(auth, body.session_id);

  const receipt = await record({
    itemId: body.item_id,
    deltaQty: `-${body.qty}`,
    txnType: "ISSUE",
    operatorId,
    sessionId: body.session_id,
    machineId: body.machine_id ?? null,
    reasonId: body.reason_id ?? null,
    note: body.note ?? null,
    clientTxnUuid: body.client_txn_uuid ?? null,
  });

  return NextResponse.json(await finish(body.session_id, body.item_id, receipt));
});

async function issueSplit(
  auth: Awaited<ReturnType<typeof authenticate>>,
  body: z.infer<typeof Body>,
) {
  const splits = body.splits!;

  for (const split of splits) {
    if (Number(split.qty) <= 0) {
      throw ApiError.badRequest("every split must be greater than zero");
    }
  }

  // A batch whose acknowledgement was lost is answered from the ledger, for the
  // same reason a single transaction is: by now the session has closed on
  // submit, so authorising first would refuse rows that are already recorded.
  const replayedRows = [];
  for (const split of splits) {
    if (!split.client_txn_uuid) break;
    const found = await findByClientUuid(sql, split.client_txn_uuid);
    if (!found) break;
    if (found.item_id !== body.item_id) {
      throw ApiError.conflict(
        "TXN_ID_REUSED",
        "That transaction id was already used for a different item.",
      );
    }
    replayedRows.push(found);
  }

  if (replayedRows.length === splits.length) {
    console.info("[txn] replayed split issue answered from the ledger", {
      rows: replayedRows.length,
    });
    return finishMany(body.session_id, body.item_id, replayedRows);
  }

  const operatorId = await authoriseSession(auth, body.session_id);

  const movements: NewMovement[] = splits.map((split) => ({
    itemId: body.item_id,
    deltaQty: `-${split.qty}`,
    txnType: "ISSUE",
    operatorId,
    sessionId: body.session_id,
    machineId: split.machine_id,
    reasonId: body.reason_id ?? null,
    note: body.note ?? null,
    clientTxnUuid: split.client_txn_uuid ?? null,
  }));

  const receipts = await recordMany(movements);
  console.info("[txn] split issue recorded, one row per machine", {
    rows: receipts.length,
    item_id: body.item_id,
  });

  return finishMany(body.session_id, body.item_id, receipts);
}
