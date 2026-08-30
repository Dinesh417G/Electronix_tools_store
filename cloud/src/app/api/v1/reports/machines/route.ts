// GET /api/v1/reports/machines?from=&to=[&machine_id=]
//
// Without `machine_id`: consumption per machine, with the number of distinct
// tools each one ate. With it: which tools, for that machine alone.
//
// `group_by=machine` on the consumption report already gives the totals. The
// question that follows — *which* tools is CNC-L1 getting through — is the one
// that leads somewhere, and it had no endpoint. `machine_id=none` asks for the
// movements booked with no machine at all, which §12.6 allows and a report must
// therefore account for rather than quietly drop.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { machineTools, machineUsage } from "@/lib/insights";
import { parseInstant } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Default window: the last 30 days, `to` exclusive as everywhere else. */
function window(p: URLSearchParams): { from: Date; to: Date } {
  const to = parseInstant(p.get("to"), "to");
  const from = parseInstant(p.get("from"), "from");
  const end = to ? new Date(to) : new Date();
  const start = from
    ? new Date(from)
    : new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  return { from: start, to: end };
}

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const p = new URL(request.url).searchParams;
  const { from, to } = window(p);
  const machine = p.get("machine_id");

  if (machine !== null) {
    return NextResponse.json(
      await machineTools(machine === "none" ? null : machine, from, to),
    );
  }

  return NextResponse.json(await machineUsage(from, to));
});
