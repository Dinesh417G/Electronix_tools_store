// PUT    /api/v1/admin/machines/{id}   rename, or bring a retired one back
// DELETE /api/v1/admin/machines/{id}   retire
//
// Retire, never delete: `stock_ledger.machine_id` points here, and a machine
// that is scrapped this year is still the answer to "what ate the end mills
// last year". Retiring takes it out of the terminal's picker (§12.6) and leaves
// every report that names it intact.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { MachineBody } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PutBody = MachineBody.extend({ active: z.boolean().optional() });

export const PUT = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = PutBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("invalid machine", parsed.error.issues);
    const b = parsed.data;

    try {
      const rows = await sql`
        update machines
           set code = ${b.code},
               name = ${b.name?.trim() || null},
               active = ${b.active ?? true}
         where id = ${id}
        returning id, code, name, active
      `;
      if (!rows[0]) throw ApiError.notFound("no such machine");
      return NextResponse.json(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw ApiError.conflict("MACHINE_CODE_TAKEN", `${b.code} already exists.`);
      }
      throw e;
    }
  },
);

export const DELETE = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const rows = await sql`
      update machines set active = false where id = ${id}
      returning id, code, name, active
    `;
    if (!rows[0]) throw ApiError.notFound("no such machine");
    return NextResponse.json(rows[0]);
  },
);
