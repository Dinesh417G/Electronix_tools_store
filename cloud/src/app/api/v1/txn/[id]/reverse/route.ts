// POST /api/v1/txn/{id}/reverse — admin only.
//
// §7: this inserts the reversing row. It never edits or deletes the original,
// and the append-only trigger would refuse if it tried. At most one reversal
// per row, so a correction applied twice cannot silently double-count.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { reverse } from "@/lib/ledger";
import { getItem } from "@/lib/items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ note: z.string().max(500).nullish() });

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireRole(request, "ADMIN");

    const { id } = await ctx.params;
    const ledgerId = Number.parseInt(id, 10);
    if (Number.isNaN(ledgerId)) throw ApiError.badRequest("ledger id must be a number");

    const body = Body.safeParse(await request.json().catch(() => ({})));
    const note = body.success ? (body.data.note ?? null) : null;

    const receipt = await reverse(ledgerId, auth.operatorId, note);
    const item = await getItem(receipt.item_id);

    return NextResponse.json({
      ledger_id: receipt.ledger_id,
      ledger_ids: [receipt.ledger_id],
      item_id: receipt.item_id,
      item_code: item.item_code,
      description: item.description,
      delta_qty: receipt.delta_qty,
      on_hand: receipt.on_hand,
      alert_state: receipt.alert_state,
      crossed_threshold: receipt.crossed_threshold,
      reverses_id: ledgerId,
    });
  },
);
