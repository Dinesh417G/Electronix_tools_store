// POST /api/v1/txn/receipt — PUT IN.
//
// §2: the storekeeper enters IN on the terminal. There is no PO, no GRN and no
// ERP import, so this endpoint is the entire inward path.

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { record } from "@/lib/ledger";
import { authoriseSession } from "@/lib/sessions";
import { finish, replayed } from "@/lib/txn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  session_id: z.string().uuid(),
  item_id: z.string().uuid(),
  qty: z.string().regex(/^\d+(\.\d{1,3})?$/, "quantity must be a positive number"),
  unit_cost: z.string().regex(/^\d+(\.\d{1,2})?$/).nullish(),
  reason_id: z.string().uuid().nullish(),
  note: z.string().max(500).nullish(),
  client_txn_uuid: z.string().uuid().optional(),
});

export const POST = handler(async (request: Request) => {
  const auth = await authenticate(request);
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw ApiError.badRequest("malformed receipt", parsed.error.issues);
  }
  const body = parsed.data;

  if (Number(body.qty) <= 0) throw ApiError.badRequest("qty must be greater than zero");

  const replay = await replayed(body.client_txn_uuid, body.item_id);
  if (replay) return NextResponse.json(replay);

  const operatorId = await authoriseSession(auth, body.session_id);

  const receipt = await record({
    itemId: body.item_id,
    deltaQty: body.qty,
    txnType: "RECEIPT",
    operatorId,
    sessionId: body.session_id,
    reasonId: body.reason_id ?? null,
    note: body.note ?? null,
    // Snapshot at transaction time: valuing last year's consumption at today's
    // price would quietly rewrite last year's reports.
    unitCost: body.unit_cost ?? null,
    clientTxnUuid: body.client_txn_uuid ?? null,
  });

  return NextResponse.json(await finish(body.session_id, body.item_id, receipt));
});
