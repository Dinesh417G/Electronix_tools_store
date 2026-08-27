// POST /api/v1/auth/webauthn/login/verify
//
// One endpoint, two outcomes, because a passkey is used from two places:
//
//   from the terminal (a device token present)  → opens a session, the way a
//                                                 punch or a PIN does
//   from the admin console (no device token)    → returns a 12 hour operator
//                                                 token
//
// §10's identity strength is the point of care here. The session is recorded
// with `identity_source = 'WEBAUTHN'`, which is *not* the same as a door punch
// and *not* the same as a typed PIN:
//
//   PUNCH     the terminal matched a finger against enrolled templates and
//             decided whose it was
//   WEBAUTHN  a device the operator registered was unlocked by someone that
//             device trusts, and signed our challenge
//   PIN       somebody typed an employee code and four digits
//
// `manual_identity` stays true for a passkey session, because it still means
// "this did not come from the door" — which is what the reports and the
// terminal's badge rely on.

import { NextResponse } from "next/server";
import { authenticate, issueToken, type Role } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { verifyAuthentication } from "@/lib/webauthn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOKEN_HOURS = 12;

export const POST = handler(async (request: Request) => {
  const body = await request.json().catch(() => null);
  if (!body?.response) throw ApiError.badRequest("no authentication response");

  const { operatorId } = await verifyAuthentication(request, body.response);

  const rows = await sql<
    { id: string; emp_code: string; full_name: string; role: Role; active: boolean }[]
  >`
    select id, emp_code, full_name, role, active from operators where id = ${operatorId}
  `;
  const operator = rows[0];
  if (!operator || !operator.active) {
    // Deactivating an operator has to take their passkey with it, or a leaver
    // keeps a key to the crib.
    throw ApiError.forbidden("That operator is no longer active.");
  }

  // A device token in the request means the terminal is asking, so this is the
  // start of a transaction rather than an admin login.
  let tabletId: string | null = null;
  try {
    const auth = await authenticate(request);
    if (auth.kind === "TABLET") tabletId = auth.tabletId;
  } catch {
    // No device token: an admin console login. Not an error.
  }

  if (tabletId) {
    const created = await sql<{ id: string }[]>`
      insert into sessions (operator_id, punch_id, state, manual_identity,
                            identity_source, tablet_id, claimed_at)
      values (${operator.id}, null, 'ACTIVE', true, 'WEBAUTHN', ${tabletId}, now())
      returning id
    `;

    return NextResponse.json({
      session_id: created[0].id,
      operator_id: operator.id,
      emp_code: operator.emp_code,
      full_name: operator.full_name,
      state: "ACTIVE",
      manual_identity: true,
      identity_source: "WEBAUTHN",
      tablet_id: tabletId,
    });
  }

  const token = await issueToken({ kind: "OPERATOR", operatorId: operator.id }, TOKEN_HOURS);

  // Flat, matching the PIN login — the console reads `role` from the top level.
  return NextResponse.json({
    token,
    expires_in_secs: TOKEN_HOURS * 3600,
    operator_id: operator.id,
    emp_code: operator.emp_code,
    full_name: operator.full_name,
    role: operator.role,
  });
});
