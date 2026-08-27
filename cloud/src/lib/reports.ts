// Consumption reporting (CLAUDE.md §11, M8).
//
// Ported from `crates/store-db/src/reports.rs`, and the two properties that
// make the numbers defensible come with it:
//
//   * Every query reads `created_at` — what the server observed — and never
//     `device_ts` (§9.3). A terminal whose clock has drifted off +05:30 must
//     not be able to move a transaction into the wrong month.
//   * "Consumption" means stock that left: `ISSUE` and `SCRAP`. Reversals net
//     themselves out with no special case, because a reversal is a real row
//     with the opposite sign. That is §7 paying for itself.
//
// One query per grouping rather than one query with an interpolated `group by`.
// The Rust version did this to keep its queries compile-time checked; here the
// reason is blunter — a report grouping is not a place to be assembling SQL
// from a query string, and each variant gets to name its "unassigned" bucket in
// words that make sense for it.

import { sql } from "./db";
import { ApiError } from "./errors";
import { GROUP_BY, normaliseGroupBy, type ConsumptionRow, type GroupBy } from "./report-format";

export { GROUP_BY, toCsv } from "./report-format";
export type { ConsumptionRow, GroupBy } from "./report-format";

/** The grouping asked for, or a 400 naming the ones that exist. */
export function parseGroupBy(value: string | null): GroupBy {
  const groupBy = normaliseGroupBy(value);
  if (groupBy) return groupBy;
  throw ApiError.badRequest(
    `unknown group_by ${JSON.stringify(value)} — expected one of ${GROUP_BY.join(", ")}`,
  );
}

/** A `from`/`to` bound, rejected here rather than silently ignored. */
export function parseInstant(value: string | null, field: string): string | null {
  if (value === null || value.trim() === "") return null;
  if (Number.isNaN(Date.parse(value))) {
    throw ApiError.badRequest(`${field} is not a timestamp: ${value}`);
  }
  return value;
}

export interface ConsumptionFilter {
  from?: string | null;
  to?: string | null;
}

export async function consumption(
  groupBy: GroupBy,
  filter: ConsumptionFilter = {},
): Promise<ConsumptionRow[]> {
  const from = filter.from ?? null;
  const to = filter.to ?? null;

  switch (groupBy) {
    case "item":
      return sql<ConsumptionRow[]>`
        select i.id::text                                as bucket_key,
               (i.item_code || ' — ' || i.description)   as bucket_label,
               sum(-l.delta_qty)::text                   as qty,
               coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)::text
                                                         as value,
               count(*)::int                             as txn_count
          from stock_ledger l
          join items i on i.id = l.item_id
         where l.txn_type in ('ISSUE', 'SCRAP')
           and (${from}::timestamptz is null or l.created_at >= ${from}::timestamptz)
           and (${to}::timestamptz is null or l.created_at < ${to}::timestamptz)
         group by i.id, i.item_code, i.description
        having sum(-l.delta_qty) <> 0
         order by sum(-l.delta_qty) desc
      `;

    case "machine":
      // Machine is optional on an issue (§12.6 has a SKIP button), so the
      // unassigned bucket is not an edge case — it is a number the storekeeper
      // should see, because a large one means the optional step is being
      // skipped and consumption-by-machine is quietly becoming fiction.
      return sql<ConsumptionRow[]>`
        select coalesce(m.id::text, 'unassigned')        as bucket_key,
               coalesce(m.code, '(no machine recorded)') as bucket_label,
               sum(-l.delta_qty)::text                   as qty,
               coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)::text
                                                         as value,
               count(*)::int                             as txn_count
          from stock_ledger l
          left join machines m on m.id = l.machine_id
         where l.txn_type in ('ISSUE', 'SCRAP')
           and (${from}::timestamptz is null or l.created_at >= ${from}::timestamptz)
           and (${to}::timestamptz is null or l.created_at < ${to}::timestamptz)
         group by m.id, m.code
        having sum(-l.delta_qty) <> 0
         order by sum(-l.delta_qty) desc
      `;

    case "operator":
      return sql<ConsumptionRow[]>`
        select o.id::text                                as bucket_key,
               (o.emp_code || ' — ' || o.full_name)      as bucket_label,
               sum(-l.delta_qty)::text                   as qty,
               coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)::text
                                                         as value,
               count(*)::int                             as txn_count
          from stock_ledger l
          join operators o on o.id = l.operator_id
         where l.txn_type in ('ISSUE', 'SCRAP')
           and (${from}::timestamptz is null or l.created_at >= ${from}::timestamptz)
           and (${to}::timestamptz is null or l.created_at < ${to}::timestamptz)
         group by o.id, o.emp_code, o.full_name
        having sum(-l.delta_qty) <> 0
         order by sum(-l.delta_qty) desc
      `;

    case "category":
      return sql<ConsumptionRow[]>`
        select coalesce(c.id::text, 'uncategorised')     as bucket_key,
               coalesce(c.name, '(uncategorised)')       as bucket_label,
               sum(-l.delta_qty)::text                   as qty,
               coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)::text
                                                         as value,
               count(*)::int                             as txn_count
          from stock_ledger l
          join items i on i.id = l.item_id
          left join item_categories c on c.id = i.category_id
         where l.txn_type in ('ISSUE', 'SCRAP')
           and (${from}::timestamptz is null or l.created_at >= ${from}::timestamptz)
           and (${to}::timestamptz is null or l.created_at < ${to}::timestamptz)
         group by c.id, c.name
        having sum(-l.delta_qty) <> 0
         order by sum(-l.delta_qty) desc
      `;

    case "month":
      return sql<ConsumptionRow[]>`
        select to_char(date_trunc('month', l.created_at), 'YYYY-MM')  as bucket_key,
               to_char(date_trunc('month', l.created_at), 'Mon YYYY') as bucket_label,
               sum(-l.delta_qty)::text                   as qty,
               coalesce(sum(-l.delta_qty * coalesce(l.unit_cost, 0)), 0)::numeric(14,2)::text
                                                         as value,
               count(*)::int                             as txn_count
          from stock_ledger l
         where l.txn_type in ('ISSUE', 'SCRAP')
           and (${from}::timestamptz is null or l.created_at >= ${from}::timestamptz)
           and (${to}::timestamptz is null or l.created_at < ${to}::timestamptz)
         group by date_trunc('month', l.created_at)
        having sum(-l.delta_qty) <> 0
         order by date_trunc('month', l.created_at) desc
      `;
  }
}
