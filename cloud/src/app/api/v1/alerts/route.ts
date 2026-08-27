// GET /api/v1/alerts — open shortages, worst first.
// POST is handled per-alert at /api/v1/alerts/{id}/ack.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  return NextResponse.json(
    await sql`
      select a.id, a.item_id, i.item_code, i.description, a.level,
             a.raised_at, a.acknowledged_at,
             s.on_hand::text as on_hand, i.reorder_level::text as reorder_level, i.max_level::text as max_level,
             i.bin_location
        from stock_alerts a
        join items i on i.id = a.item_id
        left join item_stock s on s.item_id = a.item_id
       where a.resolved_at is null
       order by (a.level = 'EMPTY') desc, a.raised_at desc
    `,
  );
});
