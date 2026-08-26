// POST /api/v1/auth/webauthn/login/options
//
// Unauthenticated by necessity — this is the start of signing in. It returns a
// challenge and nothing else: no credential list, so it cannot be used to
// enumerate who is enrolled.

import { NextResponse } from "next/server";
import { handler } from "@/lib/errors";
import { authenticationOptions } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler(async (request: Request) => {
  return NextResponse.json(await authenticationOptions(request));
});
