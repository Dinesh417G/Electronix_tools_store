// POST /api/v1/sessions/{id}/touch (§10).
//
// Everything between claiming a card and confirming happens on the terminal —
// scanning, keying a quantity, picking machines — so without this the server
// sees silence from somebody standing right in front of it, and the 180 s idle
// timeout becomes a deadline on the whole transaction.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { effectiveState } from "@/lib/session";
import { getSession, touchSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await authenticate(request);
    const { id } = await ctx.params;

    await touchSession(id);
    const row = await getSession(id);

    return NextResponse.json({
      session_id: row.id,
      state: effectiveState(row).state,
      last_activity_at: row.last_activity_at,
    });
  },
);
