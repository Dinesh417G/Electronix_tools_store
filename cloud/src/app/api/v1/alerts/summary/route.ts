// GET /api/v1/alerts/summary — counts for the terminal's idle banner (§12.1).

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const rows = await sql<{ low: number; empty: number }[]>`
    select
      count(*) filter (where level = 'LOW')::int   as low,
      count(*) filter (where level = 'EMPTY')::int as empty
    from stock_alerts where resolved_at is null
  `;
  return NextResponse.json(rows[0] ?? { low: 0, empty: 0 });
});
