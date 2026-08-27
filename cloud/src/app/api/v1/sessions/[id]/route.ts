// GET /api/v1/sessions/{id}
//
// Reports the *effective* state, not the stored one: a row still marked
// UNCLAIMED past its 90 s window is EXPIRED whether or not anything has got
// round to writing that down.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { effectiveState } from "@/lib/session";
import { getSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await authenticate(request);
    const { id } = await ctx.params;
    const row = await getSession(id);
    const state = effectiveState(row);

    return NextResponse.json({
      session_id: row.id,
      operator_id: row.operator_id,
      emp_code: row.emp_code,
      full_name: row.full_name,
      department: row.department,
      state: state.state,
      manual_identity: row.manual_identity,
      tablet_id: row.tablet_id,
      opened_at: row.opened_at,
      last_activity_at: row.last_activity_at,
    });
  },
);
