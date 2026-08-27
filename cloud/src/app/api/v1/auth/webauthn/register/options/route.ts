// POST /api/v1/auth/webauthn/register/options
//
// Registering a passkey is done by the operator, on their own device, while
// already signed in with their PIN. That ordering is the whole security story:
// a passkey is only as trustworthy as the moment it was enrolled, and enrolling
// one requires proving who you are by the means that already exist.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { registrationOptions } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler(async (request: Request) => {
  const auth = await requireRole(request, "OPERATOR", "STOREKEEPER", "ADMIN");

  const rows = await sql<{ id: string; emp_code: string; full_name: string }[]>`
    select id, emp_code, full_name from operators where id = ${auth.operatorId}
  `;
  if (!rows[0]) throw ApiError.notFound("no such operator");

  return NextResponse.json(await registrationOptions(request, rows[0]));
});
