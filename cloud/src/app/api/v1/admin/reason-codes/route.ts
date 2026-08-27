// GET  /api/v1/admin/reason-codes   including retired ones
// POST /api/v1/admin/reason-codes   add one
//
// The reason list is seeded by migration 0004 rather than left empty, for a
// reason that also governs editing it: an empty list on day one means every
// issue for the first month carries no reason, and consumption-by-reason is
// unrecoverable after the fact.
//
// `applies_to` is the whole design. ISSUE reasons and RECEIPT reasons are
// different vocabularies — BREAKAGE is not a way stock arrives — and the
// terminal shows one set or the other depending on which direction the operator
// chose (§12.6).

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const ReasonBody = z.object({
  code: z.string().trim().min(1).max(32).regex(/^[A-Z0-9_]+$/, "use CAPS_AND_UNDERSCORES"),
  label: z.string().trim().min(1).max(120),
  applies_to: z.enum(["ISSUE", "RECEIPT"]),
  /** Ten apart by convention, so one can be slipped between two later. */
  sort_order: z.number().int().min(0).max(10_000).default(100),
});

export const GET = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");

  return NextResponse.json(
    await sql`
      select r.id, r.code, r.label, r.applies_to, r.sort_order, r.active,
             (select count(*)::int from stock_ledger l where l.reason_id = r.id)
               as txn_count
        from reason_codes r
       order by r.applies_to, r.active desc, r.sort_order, r.code
    `,
  );
});

export const POST = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");

  const parsed = ReasonBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw ApiError.badRequest("invalid reason code", parsed.error.issues);
  const b = parsed.data;

  try {
    const rows = await sql`
      insert into reason_codes (code, label, applies_to, sort_order)
      values (${b.code}, ${b.label}, ${b.applies_to}, ${b.sort_order})
      returning id, code, label, applies_to, sort_order, active
    `;
    return NextResponse.json(rows[0], { status: 201 });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw ApiError.conflict("REASON_CODE_TAKEN", `${b.code} already exists.`);
    }
    throw e;
  }
});
