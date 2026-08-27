// GET  /api/v1/admin/machines   the machine list, retired ones included
// POST /api/v1/admin/machines   add one
//
// §11 asked for machine CRUD and neither implementation had it: the Rust
// service serves `GET /api/v1/machines` for the picker and nothing else, so a
// new VMC arriving on the shop floor meant an INSERT typed against the
// database. That is a fine way to add a machine and a poor way to add fifty.
//
// The list here is the admin's, so it carries what the picker's does not: the
// retired machines, and how much each has consumed. A machine with no
// transactions is safe to rename; one with three years of history behind it is
// the axis a consumption report is grouped by (§11), and renaming it silently
// rewrites the labels on every past report.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const MachineBody = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().max(200).nullish(),
});

export const GET = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");

  return NextResponse.json(
    await sql`
      select m.id, m.code, m.name, m.active,
             (select count(*)::int from stock_ledger l where l.machine_id = m.id)
               as txn_count
        from machines m
       order by m.active desc, m.code
    `,
  );
});

export const POST = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");

  const parsed = MachineBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw ApiError.badRequest("invalid machine", parsed.error.issues);
  const b = parsed.data;

  try {
    const rows = await sql`
      insert into machines (code, name)
      values (${b.code}, ${b.name?.trim() || null})
      returning id, code, name, active
    `;
    return NextResponse.json(rows[0], { status: 201 });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw ApiError.conflict(
        "MACHINE_CODE_TAKEN",
        `${b.code} already exists. If it was retired, reactivate it rather than making a second one — the history is attached to the first.`,
      );
    }
    throw e;
  }
});
