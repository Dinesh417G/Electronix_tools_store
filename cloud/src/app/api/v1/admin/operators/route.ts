// GET  /api/v1/admin/operators   the people list
// POST /api/v1/admin/operators   add a person
//
// ADMIN only. This endpoint mints the credential somebody signs a ledger row
// with, so it is the one place in the console where the role check is the whole
// point rather than a formality.
//
// `pin_hash` never leaves the database. The list returns `has_pin` instead,
// which is what an admin actually needs to know — "can this person use the
// manual fallback path" — without handing out anything to attack offline.
//
// §11's bootstrap note still stands and is not fixed by this route: creating an
// operator needs an ADMIN token, which needs an ADMIN operator with a PIN, so
// the *first* admin still comes from `store-cli operator add` against the
// database. What this removes is the need to go back to the CLI for the second
// one and every one after.

import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPin, requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const ROLES = ["OPERATOR", "STOREKEEPER", "ADMIN"] as const;

export const OperatorBody = z.object({
  emp_code: z.string().trim().min(1).max(32),
  full_name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  /** The PIN/user id programmed into the door terminal (§6). */
  zk_user_id: z.string().trim().max(32).nullish(),
  department: z.string().trim().max(120).nullish(),
  /** Optional: the manual fallback path (§8) is unavailable without one. */
  pin: z.string().regex(/^\d{4,8}$/, "a PIN is 4 to 8 digits").nullish(),
});

export const GET = handler(async (request: Request) => {
  await requireRole(request, "ADMIN");
  const includeInactive = new URL(request.url).searchParams.get("include_inactive") === "true";

  return NextResponse.json(
    await sql`
      select o.id, o.emp_code, o.full_name, o.role, o.zk_user_id, o.department,
             o.active, o.created_at,
             (o.pin_hash is not null) as has_pin,
             (select count(*)::int from webauthn_credentials w where w.operator_id = o.id)
               as passkey_count,
             (select max(l.created_at) from stock_ledger l where l.operator_id = o.id)
               as last_txn_at
        from operators o
       where (${includeInactive} or o.active)
       order by o.active desc, o.emp_code
    `,
  );
});

export const POST = handler(async (request: Request) => {
  await requireRole(request, "ADMIN");

  const parsed = OperatorBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw ApiError.badRequest("invalid operator", parsed.error.issues);
  const b = parsed.data;

  // An empty zk_user_id must land as NULL, not as "". The column is unique, so
  // a second person with a blank one would collide with the first and read as
  // "employee code already taken", which is a lie an admin cannot act on.
  const zk = b.zk_user_id?.trim() || null;

  try {
    const rows = await sql`
      insert into operators (emp_code, full_name, role, zk_user_id, department, pin_hash)
      values (${b.emp_code}, ${b.full_name}, ${b.role}, ${zk},
              ${b.department?.trim() || null},
              ${b.pin ? await hashPin(b.pin) : null})
      returning id, emp_code, full_name, role, zk_user_id, department, active,
                (pin_hash is not null) as has_pin
    `;
    return NextResponse.json(rows[0], { status: 201 });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      const detail = (e as { detail?: string }).detail ?? "";
      throw detail.includes("zk_user_id")
        ? ApiError.conflict(
            "ZK_USER_ID_TAKEN",
            `Terminal user id ${zk} already belongs to somebody else.`,
          )
        : ApiError.conflict("EMP_CODE_TAKEN", `${b.emp_code} already exists.`);
    }
    throw e;
  }
});
