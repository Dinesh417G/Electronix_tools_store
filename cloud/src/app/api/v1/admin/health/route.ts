// GET /api/v1/admin/health — database, door terminal, ledger reconciliation.
//
// The reconciliation line is the one that matters. §7 says any drift between
// `item_stock` and the sum of the ledger is a bug, so this recomputes the sum
// and compares rather than trusting the cached read model it is checking.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");

  const started = Date.now();

  const [drift] = await sql<{ drifted: number }[]>`
    select count(*)::int as drifted from (
      select s.item_id
        from item_stock s
        left join (
          select item_id, sum(delta_qty) as total
            from stock_ledger group by item_id
        ) l on l.item_id = s.item_id
       where s.on_hand <> coalesce(l.total, 0)
    ) d
  `;

  const [counts] = await sql<
    { items: number; ledger_rows: number; open_alerts: number; sessions_today: number }[]
  >`
    select
      (select count(*)::int from items where active)                    as items,
      (select count(*)::int from stock_ledger)                          as ledger_rows,
      (select count(*)::int from stock_alerts where resolved_at is null) as open_alerts,
      (select count(*)::int from sessions where opened_at > now() - interval '1 day')
                                                                        as sessions_today
  `;

  const devices = await sql<
    { serial_no: string; name: string | null; last_seen_at: Date | null }[]
  >`select serial_no, name, last_seen_at from devices order by last_seen_at desc nulls last`;

  return NextResponse.json({
    database: "ok",
    // §7: this is not a warning, it is a bug report. Anything but zero means
    // the trigger and the ledger disagree, and the ledger is right.
    reconciliation: drift.drifted === 0 ? "no drift" : `${drift.drifted} item(s) drifted`,
    drifted_items: drift.drifted,
    ...counts,
    devices: devices.map((d) => ({
      serial_no: d.serial_no,
      name: d.name,
      last_seen_at: d.last_seen_at,
      // A door terminal that has not called in for five minutes is either off
      // or cannot reach us. Either way the claim screen will stay empty and
      // somebody should know why.
      reachable: d.last_seen_at
        ? Date.now() - new Date(d.last_seen_at).getTime() < 300_000
        : false,
    })),
    checked_in_ms: Date.now() - started,
  });
});
