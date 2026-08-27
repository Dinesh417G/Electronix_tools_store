// GET  /api/v1/admin/items   the catalog list behind the admin console
// POST /api/v1/admin/items   create
//
// Quantities and money cross the wire as strings, deliberately. `numeric(12,3)`
// through a JavaScript float is how a ledger that is supposed to add up stops
// adding up, and an item's reorder level feeds straight into the alert
// evaluation.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decimal = (scale: number) =>
  z.string().regex(new RegExp(`^-?\\d+(\\.\\d{1,${scale}})?$`), "not a valid number");

export const ItemBody = z.object({
  item_code: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(500),
  category_id: z.string().uuid().nullish(),
  uom: z.enum(["NOS", "SET", "BOX", "LTR", "KG"]),
  iso_code: z.string().trim().max(64).nullish(),
  grade: z.string().trim().max(64).nullish(),
  manufacturer: z.string().trim().max(120).nullish(),
  mfr_part_no: z.string().trim().max(120).nullish(),
  diameter_mm: decimal(3).nullish(),
  flutes: z.number().int().positive().nullish(),
  reorder_level: decimal(3),
  max_level: z.string().regex(/^\d+(\.\d{1,3})?$/).nullish(),
  reorder_qty: decimal(3).nullish(),
  bin_location: z.string().trim().max(64).nullish(),
  unit_cost: decimal(2).nullish(),
  allow_negative: z.boolean().default(false),
});

export const GET = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");
  const p = new URL(request.url).searchParams;
  const q = p.get("q")?.trim() || null;
  const includeRetired = p.get("include_retired") === "true";

  return NextResponse.json(
    await sql`
      select i.id, i.item_code, i.description, i.category_id, c.name as category_name,
             i.uom, i.iso_code, i.grade, i.manufacturer, i.mfr_part_no,
             i.diameter_mm::text as diameter_mm, i.flutes,
             i.reorder_level::text as reorder_level,
             i.reorder_qty::text as reorder_qty,
             i.bin_location, i.unit_cost::text as unit_cost,
             i.allow_negative, i.active,
             coalesce(s.on_hand, 0)::text as on_hand,
             coalesce(s.alert_state, 'OK') as alert_state,
             (select count(*)::int from tool_serials t where t.item_id = i.id) as serial_count
        from items i
        left join item_categories c on c.id = i.category_id
        left join item_stock s on s.item_id = i.id
       where (${includeRetired} or i.active)
         and (${q}::text is null
              or i.item_code ilike '%' || ${q} || '%'
              or i.description ilike '%' || ${q} || '%'
              or i.iso_code ilike '%' || ${q} || '%')
       order by i.item_code
       limit 500
    `,
  );
});

export const POST = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");

  const parsed = ItemBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw ApiError.badRequest("invalid item", parsed.error.issues);
  const b = parsed.data;

  try {
    const rows = await sql`
      insert into items (
        item_code, description, category_id, uom, iso_code, grade,
        manufacturer, mfr_part_no, diameter_mm, flutes,
        max_level, reorder_level, reorder_qty, bin_location, unit_cost, allow_negative
      ) values (
        ${b.item_code}, ${b.description}, ${b.category_id ?? null}, ${b.uom},
        ${b.iso_code ?? null}, ${b.grade ?? null}, ${b.manufacturer ?? null},
        ${b.mfr_part_no ?? null}, ${b.diameter_mm ?? null}, ${b.flutes ?? null},
        ${b.max_level ?? null}, ${b.reorder_level}, ${b.reorder_qty ?? null},
        ${b.bin_location ?? null},
        ${b.unit_cost ?? null}, ${b.allow_negative}
      )
      returning id, item_code, description, active
    `;
    // The `items_create_stock_row` trigger gives it a stock row at zero, so a
    // brand new item appears on the stock views instead of vanishing from them.
    return NextResponse.json(rows[0], { status: 201 });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      throw ApiError.conflict("ITEM_CODE_TAKEN", `${b.item_code} already exists.`);
    }
    throw e;
  }
});
