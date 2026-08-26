// POST /iclock/devicecmd?SN=… — the device reporting a command result (§9).
//
// Body is form-encoded: ID=<cmdid>&Return=0&CMD=DATA
//
// Nothing is queued yet (see getrequest), so this only logs. It is implemented
// rather than left 404 because a device that cannot report a result retries,
// and a retry loop on a shop floor terminal is somebody's afternoon.

import { deviceQuery, textResponse } from "@/lib/adms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const serial = deviceQuery(request.url).sn;
  if (!serial) return textResponse("ERROR: missing SN", 400);

  const body = await request.text();
  const fields = Object.fromEntries(new URLSearchParams(body));

  console.info("[adms] command result", {
    serial,
    id: fields.ID ?? null,
    ret: fields.Return ?? null,
    cmd: fields.CMD ?? null,
  });

  return textResponse("OK");
}
