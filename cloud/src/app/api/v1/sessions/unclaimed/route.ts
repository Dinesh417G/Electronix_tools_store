// GET /api/v1/sessions/unclaimed — the name cards on the claim screen (§10).

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { unclaimedSessions } from "@/lib/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  return NextResponse.json(await unclaimedSessions());
});
