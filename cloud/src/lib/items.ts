// Catalog reads (CLAUDE.md §11, §12.4).
//
// §12.4: the scan path and the search path must land on the same item card.
// They do, because both come back through `ItemRow` and both join the same
// stock read model.

import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";
import type { AlertState } from "./ledger.ts";

export interface ItemRow {
  id: string;
  item_code: string;
  description: string;
  uom: string;
  category_id: string | null;
  category_name: string | null;
  iso_code: string | null;
  grade: string | null;
  manufacturer: string | null;
  mfr_part_no: string | null;
  bin_location: string | null;
  unit_cost: string | null;
  reorder_level: string;
  reorder_qty: string | null;
  allow_negative: boolean;
  active: boolean;
  on_hand: string;
  alert_state: AlertState;
  last_txn_at: Date | null;
}

/**
 * The shared projection.
 *
 * A function, not a constant: a tagged template is a *call*, so evaluating it
 * at module scope opens a connection at import time — which defeats the
 * lazy client in `db.ts` and fails `next build`, where no DATABASE_URL exists
 * and none is needed. Local builds hid it behind a populated .env.local; CI
 * did not.
 */
const select = () => sql`
  select i.id, i.item_code, i.description, i.uom,
         i.category_id, c.name as category_name,
         i.iso_code, i.grade, i.manufacturer, i.mfr_part_no,
         i.bin_location, i.unit_cost::text as unit_cost,
         i.reorder_level::text as reorder_level,
         i.reorder_qty::text as reorder_qty,
         i.allow_negative, i.active,
         coalesce(s.on_hand, 0)::text as on_hand,
         coalesce(s.alert_state, 'OK') as alert_state,
         s.last_txn_at
    from items i
    left join item_categories c on c.id = i.category_id
    left join item_stock s on s.item_id = i.id
`;

export async function getItem(id: string): Promise<ItemRow> {
  const rows = await sql<ItemRow[]>`${select()} where i.id = ${id} limit 1`;
  const item = rows[0];
  if (!item) throw ApiError.notFound("no such item");
  return item;
}

/**
 * Resolve a scanned code to an item.
 *
 * Three things can be under the camera and all of them are legitimate:
 *
 *   our own item code        printed on the bin label
 *   an alternate barcode     the vendor's own printed EAN, so a box that
 *                            arrives labelled resolves without re-labelling
 *   a tool serial            the running QR number on an individual tool
 *
 * Order matters only for speed; the three namespaces are disjoint by unique
 * index, so a code cannot mean two items.
 */
export async function lookupByCode(code: string): Promise<ItemRow> {
  const trimmed = code.trim();
  if (!trimmed) throw ApiError.badRequest("empty barcode");

  const rows = await sql<ItemRow[]>`
    ${select()}
    where i.item_code = ${trimmed}
       or i.id = (select item_id from item_barcodes where code = ${trimmed})
       or i.id = (select item_id from tool_serials where serial_no = ${trimmed})
    limit 1
  `;

  const item = rows[0];
  if (!item) throw ApiError.notFound(`Nothing in the catalog matches ${trimmed}.`);
  return item;
}

/**
 * Typeahead across item_code, description, iso_code and grade (§11).
 *
 * Trigram matching because operators search by fragment — "cnmg 1204", "tn20" —
 * not by prefix. The GIN indexes in 0001 are what keep this inside the 100 ms
 * §11 asks for.
 */
export async function searchItems(query: string, limit = 25): Promise<ItemRow[]> {
  const q = query.trim();
  if (!q) return [];

  return sql<ItemRow[]>`
    ${select()}
    where i.active
      and (i.item_code ilike ${"%" + q + "%"}
        or i.description ilike ${"%" + q + "%"}
        or i.iso_code ilike ${"%" + q + "%"}
        or i.grade ilike ${"%" + q + "%"})
    order by
      -- An exact code match is what a scanner-shaped query wants first.
      (i.item_code ilike ${q}) desc,
      (i.item_code ilike ${q + "%"}) desc,
      i.item_code
    limit ${Math.min(Math.max(limit, 1), 100)}
  `;
}

/** The browse-all list: paged, stable order, active items only. */
export async function browseItems(offset = 0, limit = 25): Promise<ItemRow[]> {
  return sql<ItemRow[]>`
    ${select()}
    where i.active
    order by i.item_code
    limit ${Math.min(Math.max(limit, 1), 100)}
    offset ${Math.max(offset, 0)}
  `;
}

/**
 * The stock view, and also the admin console's catalog list.
 *
 * It returns the *whole* item, not just the stock-shaped columns. The console
 * loads this list and then opens the edit form straight from the row it has —
 * so a field missing here is a field the form opens blank and saves blank.
 * `active` is the same story: absent, every row renders as retired.
 */
export async function stockList(filters: {
  states?: string[] | null;
  q?: string | null;
  bin?: string | null;
  category?: string | null;
  limit?: number;
  /** Rows to skip. Absent means the first page. */
  offset?: number;
}): Promise<ItemRow[]> {
  const { states = null, q = null, bin = null, category = null, limit = 500, offset = 0 } =
    filters;

  return sql<ItemRow[]>`
    ${select()}
    where i.active
      and (${states}::text[] is null
           or coalesce(s.alert_state, 'OK') = any(${states}::text[]))
      and (${bin}::text is null or i.bin_location = ${bin})
      and (${category}::uuid is null or i.category_id = ${category}::uuid)
      and (${q}::text is null
           or i.item_code ilike '%' || ${q} || '%'
           or i.description ilike '%' || ${q} || '%')
    order by (coalesce(s.alert_state,'OK') = 'EMPTY') desc,
             (coalesce(s.alert_state,'OK') = 'LOW') desc,
             i.item_code
    limit ${Math.min(Math.max(limit, 1), 500)}
    offset ${Math.max(offset, 0)}
  `;
}
