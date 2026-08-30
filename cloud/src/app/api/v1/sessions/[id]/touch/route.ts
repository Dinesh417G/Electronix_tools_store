// POST /api/v1/sessions/{id}/touch (§10).
//
// Everything between claiming a card and confirming happens on the terminal —
// scanning, keying a quantity, picking machines — so without this the server
// sees silence from somebody standing right in front of it, and the 180 s idle
// timeout becomes a deadline on the whole transaction.
//
// It goes through `authoriseSession` like every other write against a session,
// and for two reasons. A session that has aged out must answer 410 here as it
// does at confirm — §10 asks that a write against an aged-out session be
// refused "exactly as if a reaper had closed it", and a keepalive is a write.
// And a keepalive is bound to the tablet holding the session: without that
// check any tablet could extend a session claimed at another one, which is the
// binding §10 relies on to keep one operator's transaction theirs.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { effectiveState } from "@/lib/session";
import { authoriseSession, getSession, touchSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await authenticate(request);
    const { id } = await ctx.params;

    await authoriseSession(auth, id);
    await touchSession(id);
    const row = await getSession(id);

    return NextResponse.json({
      session_id: row.id,
      state: effectiveState(row).state,
      last_activity_at: row.last_activity_at,
    });
  },
);
