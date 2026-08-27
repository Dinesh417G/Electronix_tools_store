// PUT    /api/v1/admin/reason-codes/{id}   edit, or bring a retired one back
// DELETE /api/v1/admin/reason-codes/{id}   retire
//
// Retire rather than delete, and for once the reason is not only the foreign
// key: a reason code is the label on a slice of history. Deleting BREAKAGE
// because the shop stopped using it would erase the word from every issue that
// ever cited it. Retiring drops it from the terminal's chips and leaves the
// past legible.
//
// Editing `label` is safe — it is display text. Editing `code` is not, if
// anything outside the database refers to it by name; the ledger points at the
// id, so this cannot corrupt history, but it can surprise an integration.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { ReasonBody } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PutBody = ReasonBody.extend({ active: z.boolean().optional() });

export const PUT = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = PutBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("invalid reason code", parsed.error.issues);
    const b = parsed.data;

    try {
      const rows = await sql`
        update reason_codes
           set code = ${b.code}, label = ${b.label},
               applies_to = ${b.applies_to}, sort_order = ${b.sort_order},
               active = ${b.active ?? true}
         where id = ${id}
        returning id, code, label, applies_to, sort_order, active
      `;
      if (!rows[0]) throw ApiError.notFound("no such reason code");
      return NextResponse.json(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw ApiError.conflict("REASON_CODE_TAKEN", `${b.code} already exists.`);
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
      update reason_codes set active = false where id = ${id}
      returning id, code, label, applies_to, active
    `;
    if (!rows[0]) throw ApiError.notFound("no such reason code");
    return NextResponse.json(rows[0]);
  },
);
