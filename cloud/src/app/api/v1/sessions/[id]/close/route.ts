// POST /api/v1/sessions/{id}/close — explicit Done, or the operator backed out.

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { closeSession } from "@/lib/sessions";
import type { CloseReason } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  reason: z.enum(["SUBMITTED", "DONE", "IDLE_TIMEOUT"]).optional(),
});

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await authenticate(request);
    const { id } = await ctx.params;

    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    const reason: CloseReason = parsed.success ? (parsed.data.reason ?? "DONE") : "DONE";

    const state = await closeSession(id, reason);
    return NextResponse.json({ session_id: id, state: state.state });
  },
);
