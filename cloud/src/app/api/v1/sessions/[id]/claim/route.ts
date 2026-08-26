// POST /api/v1/sessions/{id}/claim — a tablet took the card (§10).
//
// A claimed session is bound to one tablet. A second tablet gets 409 and is
// told which one holds it; the same tablet re-claiming after a reconnect
// succeeds, because that is not a conflict, it is a retry.

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { applyEvent, getSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ tablet_id: z.string().trim().min(1).max(64) });

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await authenticate(request);
    const { id } = await ctx.params;

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("tablet_id is required");

    // A device may only claim for itself. Taking the id from the body alone
    // would let any enrolled tablet park a session on another one's name.
    const tabletId =
      auth.kind === "TABLET" ? auth.tabletId : parsed.data.tablet_id;

    await applyEvent(id, { event: "CLAIM", tabletId });
    const row = await getSession(id);

    return NextResponse.json({
      session_id: row.id,
      operator_id: row.operator_id,
      emp_code: row.emp_code,
      full_name: row.full_name,
      state: row.state,
      manual_identity: row.manual_identity,
      tablet_id: row.tablet_id,
    });
  },
);
