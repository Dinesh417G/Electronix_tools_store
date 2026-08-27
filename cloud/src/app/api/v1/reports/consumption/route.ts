// GET /api/v1/reports/consumption?group_by=item|machine|operator|category|month
//                                &from=<iso>&to=<iso>
//
// M8's other half. Alerts tell you an item is running out; this tells you where
// it went. `to` is exclusive, so a month is `from=2026-08-01&to=2026-09-01` and
// two adjacent ranges cannot double-count the boundary.
//
// Any authenticated caller, matching the Rust service: this reads the ledger,
// and every ledger row already names the operator who made it.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { consumption, parseGroupBy, parseInstant } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const p = new URL(request.url).searchParams;
  const groupBy = parseGroupBy(p.get("group_by"));

  // A bare array, the same shape the Rust service returns. An envelope echoing
  // the query back would read better in a browser and would also mean a client
  // written against one implementation breaks against the other.
  return NextResponse.json(
    await consumption(groupBy, {
      from: parseInstant(p.get("from"), "from"),
      to: parseInstant(p.get("to"), "to"),
    }),
  );
});
