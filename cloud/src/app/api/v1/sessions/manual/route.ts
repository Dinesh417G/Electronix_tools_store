// POST /api/v1/sessions/manual — §10's fallback when no punch arrives.

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { openManualSession } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  emp_code: z.string().trim().min(1).max(32),
  pin: z.string().min(1).max(32),
  tablet_id: z.string().trim().min(1).max(64),
});

export const POST = handler(async (request: Request) => {
  const auth = await authenticate(request);

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw ApiError.badRequest("emp_code, pin and tablet_id are required");

  const tabletId = auth.kind === "TABLET" ? auth.tabletId : parsed.data.tablet_id;
  const row = await openManualSession(parsed.data.emp_code, parsed.data.pin, tabletId);

  return NextResponse.json({
    session_id: row.id,
    operator_id: row.operator_id,
    emp_code: row.emp_code,
    full_name: row.full_name,
    state: row.state,
    manual_identity: row.manual_identity,
    tablet_id: row.tablet_id,
  });
});
