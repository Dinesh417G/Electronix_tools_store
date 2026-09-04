// GET /api/v1/ledger?item=&operator=&machine=&reason=&from=&to=&limit=&offset=&sort=&dir=
//
// The history view. §7 makes this and "current stock" the same object rather
// than two things that quietly disagree after six months.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";
import { LEDGER_SORTS, resolveSort, splitTotal, TOTAL_HEADER } from "@/lib/paging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  const p = new URL(request.url).searchParams;

  const item = p.get("item") || null;
  const operator = p.get("operator") || null;
  const machine = p.get("machine") || null;
  // By code rather than by id: a storekeeper asking "show me the breakages" is
  // asking about BREAKAGE, and the code is the stable thing — §6 seeds it, and
  // the label is free to be renamed.
  const reason = p.get("reason") || null;
  const from = p.get("from") || null;
  const to = p.get("to") || null;
  const limit = Math.min(Math.max(Number.parseInt(p.get("limit") ?? "50", 10) || 50, 1), 500);
  const offset = Math.max(Number.parseInt(p.get("offset") ?? "0", 10) || 0, 0);

  // Whitelisted, so nothing the caller sends reaches the query. `time` is the
  // default and descending is its default direction: somebody opening the
  // ledger wants what just happened, not the first movement the crib ever
  // recorded.
  //
  // `l.id` rather than `l.created_at` for time, because two rows written in the
  // same transaction share a timestamp and `id` is the tiebreak that makes the
  // order total — without one, two pages of the same query can overlap or skip
  // a row. Every other column gets `l.id` appended for the same reason.
  const { key, descending } = resolveSort(
    p.get("sort"),
    p.get("dir"),
    LEDGER_SORTS,
    "time",
    true,
  );
  const order = {
    time: sql`l.id`,
    item: sql`i.item_code`,
    qty: sql`l.delta_qty`,
    operator: sql`o.full_name`,
    type: sql`l.txn_type`,
  }[key];

  const rows = await sql<(Record<string, unknown> & { total_count: number })[]>`
    select l.id::text as id, l.item_id, i.item_code, i.description,
           l.delta_qty::text as delta_qty, l.txn_type,
           l.operator_id, o.full_name as operator_name, o.emp_code,
           l.session_id, s.manual_identity,
           m.code as machine_code, r.code as reason_code,
           l.note, l.unit_cost::text as unit_cost, l.created_at,
           l.reverses_id::text as reverses_id,
           count(*) over()::int as total_count
      from stock_ledger l
      join items i on i.id = l.item_id
      join operators o on o.id = l.operator_id
      left join sessions s on s.id = l.session_id
      left join machines m on m.id = l.machine_id
      left join reason_codes r on r.id = l.reason_id
     where (${item}::uuid is null or l.item_id = ${item}::uuid)
       and (${operator}::uuid is null or l.operator_id = ${operator}::uuid)
       and (${machine}::uuid is null or l.machine_id = ${machine}::uuid)
       and (${reason}::text is null or r.code = ${reason}::text)
       and (${from}::timestamptz is null or l.created_at >= ${from}::timestamptz)
       and (${to}::timestamptz is null or l.created_at < ${to}::timestamptz)
     order by ${order} ${descending ? sql`desc` : sql`asc`} nulls last, l.id desc
     limit ${limit} offset ${offset}
  `;

  // The array body is unchanged; the count of matching rows travels in a
  // header, so a reader that predates this is unaffected and the console can
  // stop saying "the 60 most recent" when it can say "60 of 4,231".
  const page = splitTotal(rows);
  return NextResponse.json(page.rows, { headers: { [TOTAL_HEADER]: String(page.total) } });
});
