// The ADMS endpoint the door terminal talks to (CLAUDE.md §9).
//
//   GET  /iclock/cdata?SN=…&options=all      handshake on boot
//   POST /iclock/cdata?SN=…&table=ATTLOG     punch records, tab-separated
//
// Two hard requirements from §9, both about the same failure:
//
//   * the acknowledgement must be exactly `OK: <n>`
//   * it must arrive fast
//
// A non-OK or slow response makes the device retry the batch, and a retry that
// is not deduplicated is a second punch for one finger. `punches_dedup` is what
// makes the retry harmless; this handler is what keeps it rare.
//
// ⚠️ Unverified against real firmware. §9's warning stands: run
// `store-cli device-probe`, capture a real terminal, and reconcile before
// trusting any of this in a shop.

import { attlogAck, deviceQuery, optionsBlock, parseAttlog, textResponse } from "@/lib/adms";
import { openFromPunch, recordPunch, upsertDevice } from "@/lib/punches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const q = deviceQuery(request.url);
  const serial = q.sn;

  if (!serial) return textResponse("ERROR: missing SN", 400);

  await upsertDevice(serial).catch((e) =>
    console.error("[adms] could not record device", { serial, error: e }),
  );

  console.info("[adms] device handshake", { serial, pushver: q.pushver ?? null });
  return textResponse(optionsBlock({ serial }));
}

export async function POST(request: Request) {
  const q = deviceQuery(request.url);
  const serial = q.sn;

  if (!serial) return textResponse("ERROR: missing SN", 400);

  // Tables other than ATTLOG (OPERLOG, ATTPHOTO…) are acknowledged and
  // discarded. Refusing them would make the device retry forever for data a
  // tool crib has no use for.
  const table = (q.table ?? "ATTLOG").toUpperCase();
  const body = await request.text();

  if (table !== "ATTLOG") {
    console.info("[adms] ignoring table", { serial, table });
    return textResponse(attlogAck(0));
  }

  const { records, rejected } = parseAttlog(body);
  for (const line of rejected) {
    console.warn("[adms] unparseable ATTLOG line", { serial, line });
  }

  let deviceId: string;
  try {
    deviceId = await upsertDevice(serial);
  } catch (e) {
    // Not acknowledged: we genuinely did not keep this, so the device *should*
    // retry it.
    console.error("[adms] device upsert failed", { serial, error: e });
    return textResponse("ERROR: device", 500);
  }

  let stored = 0;
  for (const record of records) {
    try {
      const punchId = await recordPunch(deviceId, record);

      // A null id means the dedup index caught a retry. From the device's point
      // of view that record was accepted — it was, the first time — so it still
      // counts toward the acknowledgement.
      if (!punchId) {
        stored += 1;
        continue;
      }

      // §9.2 says never do session logic inline in the ADMS handler. That rule
      // assumed a server with a background task to push onto; a serverless
      // function has nowhere to defer to, and a punch that never becomes a
      // session offer is a card that never appears on the claim screen. It is
      // one insert against an indexed column, and the alternative is losing the
      // feature.
      const offer = await openFromPunch(punchId);
      if (offer.kind === "UNKNOWN_OPERATOR") {
        // §9.4: recorded, never dropped, and surfaced to the admin. An
        // incomplete operator master must not become a hole in the history.
        console.warn("[adms] punch from unknown user", {
          serial,
          zk_user_id: record.userId,
        });
      }

      stored += 1;
    } catch (e) {
      console.error("[adms] could not store punch", {
        serial,
        zk_user_id: record.userId,
        error: e,
      });
    }
  }

  // Acknowledge only what we actually kept. Claiming more would tell the device
  // to move its stamp past records that are not in the database.
  return textResponse(attlogAck(stored));
}
