// Operator login for the admin console (CLAUDE.md §11): emp code + PIN → a
// 12 hour token.
//
// This is not how stock moves. An operator at the terminal is identified by the
// door, or by the manual fallback that opens a session; this endpoint exists so
// a storekeeper can reach the catalog and the reports.

import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { DUMMY_PIN_HASH, issueToken, verifyPin, type Role } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_HOURS = 12;

const Body = z.object({
  emp_code: z.string().trim().min(1).max(32),
  pin: z.string().min(1).max(32),
});

export const POST = handler(async (request: Request) => {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw ApiError.badRequest("malformed login", parsed.error.issues);
  }
  const { emp_code, pin } = parsed.data;

  const rows = await sql<
    {
      id: string;
      emp_code: string;
      full_name: string;
      role: Role;
      pin_hash: string | null;
      active: boolean;
    }[]
  >`
    select id, emp_code, full_name, role, pin_hash, active
      from operators
     where emp_code = ${emp_code}
     limit 1
  `;

  const operator = rows[0];

  // One message for every failure mode — unknown code, no PIN set, wrong PIN,
  // deactivated. Telling an attacker which employee codes exist is free
  // reconnaissance, and the operator's next move is the same either way.
  const refuse = () => ApiError.unauthorized("Employee code or PIN is not right.");

  if (!operator || !operator.pin_hash || !operator.active) {
    // Still spend the time an argon2 verify would have taken, so a missing
    // operator is not distinguishable by how fast the answer comes back.
    await verifyPin(pin, DUMMY_PIN_HASH);
    throw refuse();
  }

  if (!(await verifyPin(pin, operator.pin_hash))) {
    throw refuse();
  }

  const token = await issueToken({ kind: "OPERATOR", operatorId: operator.id }, TOKEN_HOURS);

  // Flat, not nested under `operator`. The admin console reads `role` from the
  // top level to decide whether this login may open the console at all, and a
  // nested shape makes that read `undefined` — which reports a legitimate
  // administrator as "not permitted" rather than as a bug.
  return NextResponse.json({
    token,
    expires_in_secs: TOKEN_HOURS * 3600,
    operator_id: operator.id,
    emp_code: operator.emp_code,
    full_name: operator.full_name,
    role: operator.role,
  });
});
