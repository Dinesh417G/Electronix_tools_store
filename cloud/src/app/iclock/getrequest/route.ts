// GET /iclock/getrequest?SN=… — the device polling for queued commands (§9).
//
// "OK" means nothing queued. A command looks like:
//
//   C:<cmdid>:DATA UPDATE USERINFO PIN=<id>\tName=<name>\tPri=0
//
// v1 queues nothing: the terminal owns the door and its own user list (§2), and
// pushing user records at it would make this software responsible for who can
// open the door — which is exactly the coupling §2 refused. The endpoint exists
// because the device polls it regardless, and an unanswered poll is an error on
// its display.

import { deviceQuery, textResponse } from "@/lib/adms";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const serial = deviceQuery(request.url).sn;
  if (!serial) return textResponse("ERROR: missing SN", 400);

  // The poll doubles as a heartbeat, which is how the admin health view knows
  // the door terminal is alive between punches.
  await sql`
    update devices set last_seen_at = now() where serial_no = ${serial}
  `.catch((e: unknown) => console.error("[adms] heartbeat failed", { serial, error: e }));

  return textResponse("OK");
}
