// PUT    /api/v1/admin/items/{id}   update
// PATCH  /api/v1/admin/items/{id}   stock levels only
// DELETE /api/v1/admin/items/{id}   retire
//
// DELETE retires rather than deletes. `stock_ledger.item_id` references this
// row with ON DELETE RESTRICT, so a real delete would either fail or, if the
// constraint were relaxed, orphan the history §7 exists to preserve. An item
// that is no longer stocked is `active = false`: it leaves the pickers, keeps
// its past, and can come back.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { ItemBody } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = ItemBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("invalid item", parsed.error.issues);
    const b = parsed.data;

    try {
      // Changing reorder_level fires `items_reevaluate_alert_on_reorder_change`,
      // so a policy change surfaces immediately rather than waiting for the
      // item's next movement — which for a slow mover could be months.
      const rows = await sql`
        update items set
          item_code = ${b.item_code}, description = ${b.description},
          category_id = ${b.category_id ?? null}, uom = ${b.uom},
          iso_code = ${b.iso_code ?? null}, grade = ${b.grade ?? null},
          manufacturer = ${b.manufacturer ?? null}, mfr_part_no = ${b.mfr_part_no ?? null},
          diameter_mm = ${b.diameter_mm ?? null}, flutes = ${b.flutes ?? null},
          reorder_level = ${b.reorder_level}, reorder_qty = ${b.reorder_qty ?? null},
          max_level = ${b.max_level ?? null},
          bin_location = ${b.bin_location ?? null}, unit_cost = ${b.unit_cost ?? null},
          allow_negative = ${b.allow_negative}
        where id = ${id}
        returning id, item_code, description, active
      `;
      if (!rows[0]) throw ApiError.notFound("no such item");
      return NextResponse.json(rows[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw ApiError.conflict("ITEM_CODE_TAKEN", `${b.item_code} already exists.`);
      }
      throw e;
    }
  },
);

/**
 * The stock band, on its own.
 *
 * PUT replaces an entire item and needs every field, which is the right shape
 * for the catalog form and the wrong one for the alert screen: the moment you
 * find out a bin is set to the wrong level is when it shouts at you, and being
 * sent to a fourteen-field form to change one number is how it stays wrong.
 *
 * `max_level` is the order-up-to level (0009) and may be cleared by sending
 * null. The database refuses an inverted band; this maps that to a sentence.
 */
const Levels = z.object({
  reorder_level: z.string().regex(/^\d+(\.\d{1,3})?$/).optional(),
  max_level: z.string().regex(/^\d+(\.\d{1,3})?$/).nullish(),
  reorder_qty: z.string().regex(/^\d+(\.\d{1,3})?$/).nullish(),
});

export const PATCH = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = Levels.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("invalid levels", parsed.error.issues);
    const b = parsed.data;

    if (Object.keys(b).length === 0) throw ApiError.badRequest("nothing to change");

    try {
      // Only what was sent: an omitted field keeps its value, and an explicit
      // null clears it. Without that distinction there is no way to say "this
      // bin has no ceiling" as opposed to "leave the ceiling alone".
      const rows = await sql`
        update items set
          reorder_level = ${b.reorder_level ?? sql`reorder_level`},
          max_level     = ${b.max_level === undefined ? sql`max_level` : b.max_level},
          reorder_qty   = ${b.reorder_qty === undefined ? sql`reorder_qty` : b.reorder_qty}
        where id = ${id}
        returning id, item_code, reorder_level::text as reorder_level,
                  max_level::text as max_level, reorder_qty::text as reorder_qty
      `;
      if (!rows[0]) throw ApiError.notFound("no such item");
      return NextResponse.json(rows[0]);
    } catch (e) {
      // items_level_band_not_inverted (0009)
      if ((e as { code?: string }).code === "23514") {
        throw ApiError.badRequest("The maximum cannot be below the reorder level.");
      }
      throw e;
    }
  },
);

export const DELETE = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const rows = await sql<{ item_code: string }[]>`
      update items set active = false where id = ${id} returning item_code
    `;
    if (!rows[0]) throw ApiError.notFound("no such item");

    return new Response(null, { status: 204 });
  },
);
