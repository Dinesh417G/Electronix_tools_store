// POST /api/v1/admin/items/{id}/barcodes — attach a vendor's own barcode.
//
// §6: this is the difference between scanning a box as it arrives and
// re-labelling every box. `item_barcodes.code` is unique across the table, so a
// code can never resolve to two items — which would be worse than not scanning
// at all.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  code: z.string().trim().min(1).max(64),
  kind: z.enum(["OWN", "MFR_EAN", "VENDOR"]).default("VENDOR"),
});

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("code is required", parsed.error.issues);

    try {
      const rows = await sql`
        insert into item_barcodes (item_id, code, kind)
        values (${id}, ${parsed.data.code}, ${parsed.data.kind})
        returning id, item_id, code, kind
      `;
      return NextResponse.json(rows[0], { status: 201 });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "23505") {
        const owner = await sql<{ item_code: string }[]>`
          select i.item_code from item_barcodes b
            join items i on i.id = b.item_id
           where b.code = ${parsed.data.code}
        `;
        throw ApiError.conflict(
          "BARCODE_TAKEN",
          owner[0]
            ? `That barcode already points at ${owner[0].item_code}.`
            : "That barcode is already in use.",
        );
      }
      if (code === "23503") throw ApiError.notFound("no such item");
      throw e;
    }
  },
);
