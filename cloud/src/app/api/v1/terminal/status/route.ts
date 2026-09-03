// GET /api/v1/terminal/status — what the idle screen needs, in one request.
//
// Three facts that had no tablet-callable source between them. `/admin/devices`
// answers the first but requires a STOREKEEPER, and the terminal holds a device
// token that is deliberately not an operator (§11) — so the screen could not
// find out whether the crib it is standing in has a door reader at all.
//
// **The reader is optional.** §3 lists a ZKTeco terminal under "physical setup
// this software assumes", and that assumption is wrong for a crib that wants
// the tablet and nothing else: some customers install a reader, some do not.
// Rather than a setting somebody has to know to change, this reports whether a
// device has *ever* checked in, and the terminal words itself accordingly —
// a crib with no reader is never told to put a finger on one.
//
// Ever, not recently, and the distinction matters: a reader that is installed
// but offline for an hour must not turn the store into a crib that never had
// one, because the fix for those two states is completely different. `online`
// carries the recency separately.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A device quiet for longer than this is installed but not talking. */
const ONLINE_WINDOW_MIN = 15;

/**
 * The day boundary comes from the tablet, because the tablet is the thing
 * physically in the store and its clock is the store's clock. The server runs
 * in UTC on Vercel, so a server-side `date_trunc('day', now())` would roll
 * "today" at 05:30 in an Indian plant — mid-shift, and every number on the
 * screen would drop to zero while somebody was looking at it.
 *
 * Clamped to the last 48 hours: this only scopes a count, but an unbounded
 * client-supplied window is an unbounded scan.
 */
function dayStart(raw: string | null): Date {
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000);
  if (!raw) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  const oldest = Date.now() - 48 * 60 * 60 * 1000;
  if (parsed.getTime() < oldest || parsed.getTime() > Date.now()) return fallback;
  return parsed;
}

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const since = dayStart(new URL(request.url).searchParams.get("since"));

  const [reader] = await sql<{ installed: boolean; last_seen_at: Date | null }[]>`
    select count(*) > 0 as installed, max(last_seen_at) as last_seen_at
      from devices
  `;

  // §9.3: business logic reads `created_at`, never the device clock. A day's
  // count is business logic.
  // Counts, not summed quantities.
  //
  // The first version totalled `delta_qty` each way and showed "13 out, 14 in",
  // which adds twenty-litre drums of coolant to carbide inserts: §6 gives every
  // item a `uom`, and NOS + LTR + KG is a number with no unit and no meaning.
  // How many times somebody came to the crib and which direction they went is
  // a real quantity, and it is the one this strip is for.
  const [today] = await sql<
    { movements: number; out_count: number; in_count: number; last_at: Date | null }[]
  >`
    select count(*)::int as movements,
           count(*) filter (where delta_qty < 0)::int as out_count,
           count(*) filter (where delta_qty > 0)::int as in_count,
           max(created_at) as last_at
      from stock_ledger
     where created_at >= ${since}
  `;

  // Scoped to the same window as the counts above, which it was not: the card
  // is headed TODAY and listed the last eight movements whatever day they fell
  // on, so a quiet morning showed "7 movements" over eight rows, the last of
  // them from the previous evening. A panel that disagrees with its own header
  // teaches the reader to distrust every number on the screen.
  const recent = await sql`
    select l.id, l.delta_qty::text as delta_qty, l.txn_type,
           i.item_code, i.uom, o.full_name as operator_name, l.created_at
      from stock_ledger l
      join items i on i.id = l.item_id
      join operators o on o.id = l.operator_id
     where l.created_at >= ${since}
     order by l.created_at desc, l.id desc
     limit 20
  `;

  const lastSeen = reader.last_seen_at;

  return NextResponse.json({
    reader: {
      installed: reader.installed,
      online:
        lastSeen !== null &&
        Date.now() - new Date(lastSeen).getTime() < ONLINE_WINDOW_MIN * 60 * 1000,
      last_seen_at: lastSeen,
    },
    today,
    recent,
  });
});
