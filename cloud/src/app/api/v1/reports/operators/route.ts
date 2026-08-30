// GET /api/v1/reports/operators?from=&to=
//
// Who signed in, how they proved who they were, and what they took.
//
// The identity split — punch, passkey, PIN — is the point rather than a detail.
// §8 says the three are not equal evidence: a punch is the reader deciding
// whose finger it was, a passkey is a registered device unlocked by somebody it
// trusts, a PIN is four digits somebody typed. A report that added them up into
// "sessions" would throw away exactly the distinction the identity design
// exists to keep.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { operatorStats } from "@/lib/insights";
import { parseInstant } from "@/lib/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  // Named people and their movements, so this is the storekeeper's business
  // rather than any tablet's.
  await requireRole(request, "STOREKEEPER", "ADMIN");

  const p = new URL(request.url).searchParams;
  const to = parseInstant(p.get("to"), "to");
  const from = parseInstant(p.get("from"), "from");
  const end = to ? new Date(to) : new Date();
  const start = from
    ? new Date(from)
    : new Date(end.getTime() - 30 * 24 * 3600 * 1000);

  return NextResponse.json(await operatorStats(start, end));
});
