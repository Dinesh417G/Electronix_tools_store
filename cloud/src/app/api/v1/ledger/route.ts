// GET /api/v1/ledger?item=&operator=&machine=&from=&to=&limit=&offset=
//
// The history view. §7 makes this and "current stock" the same object rather
// than two things that quietly disagree after six months.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  const p = new URL(request.url).searchParams;

  const item = p.get("item") || null;
  const operator = p.get("operator") || null;
  const machine = p.get("machine") || null;
  const from = p.get("from") || null;
  const to = p.get("to") || null;
  const limit = Math.min(Math.max(Number.parseInt(p.get("limit") ?? "50", 10) || 50, 1), 500);
  const offset = Math.max(Number.parseInt(p.get("offset") ?? "0", 10) || 0, 0);

  const rows = await sql`
    select l.id::text as id, l.item_id, i.item_code, i.description,
           l.delta_qty::text as delta_qty, l.txn_type,
           l.operator_id, o.full_name as operator_name, o.emp_code,
           l.session_id, s.manual_identity,
           m.code as machine_code, r.code as reason_code,
           l.note, l.unit_cost::text as unit_cost, l.created_at,
           l.reverses_id::text as reverses_id
      from stock_ledger l
      join items i on i.id = l.item_id
      join operators o on o.id = l.operator_id
      left join sessions s on s.id = l.session_id
      left join machines m on m.id = l.machine_id
      left join reason_codes r on r.id = l.reason_id
     where (${item}::uuid is null or l.item_id = ${item}::uuid)
       and (${operator}::uuid is null or l.operator_id = ${operator}::uuid)
       and (${machine}::uuid is null or l.machine_id = ${machine}::uuid)
       and (${from}::timestamptz is null or l.created_at >= ${from}::timestamptz)
       and (${to}::timestamptz is null or l.created_at < ${to}::timestamptz)
     order by l.id desc
     limit ${limit} offset ${offset}
  `;

  return NextResponse.json(rows);
});
