// POST /api/v1/sessions/manual — §10's fallback when no punch arrives.

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate } from "@/lib/auth";
import { assertNotLocked, clientIp, recordAttempt } from "@/lib/auth-throttle";
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

  // Throttled on the same counts as the console login, and it matters more
  // here: this endpoint opens a session, and a session is what stock is booked
  // against. A tablet token is needed to reach it, which narrows who can try —
  // it does not bound how often.
  const ip = clientIp(request);
  const { emp_code, pin } = parsed.data;
  await assertNotLocked(emp_code, ip);

  let row;
  try {
    row = await openManualSession(emp_code, pin, tabletId);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      await recordAttempt("MANUAL_SESSION", emp_code, ip, false);
    }
    throw e;
  }
  await recordAttempt("MANUAL_SESSION", emp_code, ip, true);

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
