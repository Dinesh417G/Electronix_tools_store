// GET /api/v1/admin/devices — is the door talking to us, and what has it said?
//
// Three things in one response because they are read together when something is
// wrong at the door, and separately they each answer half a question:
//
//   devices        every terminal that has ever handshaked, and when last
//   unknown_users  §9.4's notices — somebody the operator master does not know
//   recent_punches what actually arrived, newest first
//
// `last_seen_at` is the number that matters. A device that has not been heard
// from since this morning is either off, off the network, or pointed at the
// wrong ADMS address — and none of those announce themselves, because the door
// keeps working on its own (§2). Silence here is the only symptom.
//
// Both timestamps are reported. `device_ts` is what the terminal claimed and is
// diagnostic only; §9.3 says business logic uses `received_at`, and a device
// whose clock has drifted is exactly what this screen is for spotting.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await requireRole(request, "ADMIN");

  // Sequential, and it has to be. This was `Promise.all` over the three, and
  // that is what hung this screen — the only route in the app that ran
  // concurrent queries was the only route that hung.
  //
  // `db.ts` holds `max: 1`, so three queries started together are pipelined
  // onto one socket, and that socket goes through Supabase's pooler in
  // transaction mode. The two disagree: postgres.js is driving one connection
  // as though it owns it, Supavisor is handing out a connection per
  // transaction. What comes back is a protocol desync — the backend parked
  // `active` on `ClientRead`, holding an open transaction, waiting for the
  // rest of an exchange that will never arrive, and the next request on that
  // instance queueing behind it forever.
  //
  // Nothing local can see this: `write-path.mjs` drives eight concurrent reads
  // and passes, because a direct Postgres has no pooler in front of it. It is
  // the same blind spot as the 2026-08-28 outage — a fault that exists only
  // where the code is deployed.
  //
  // Three indexed queries against small tables cost about a round trip each.
  // That is the entire price of this fix.
  const devices = await sql`
      select d.id, d.serial_no, d.name, d.location, d.firmware,
             d.timezone_offset_min, d.last_seen_at,
             (select count(*)::int from punches p where p.device_id = d.id) as punch_count,
             (select max(p.received_at) from punches p where p.device_id = d.id)
               as last_punch_at
        from devices d
       order by d.last_seen_at desc nulls last
  `;

  const unknownUsers = await sql`
      select p.id, p.zk_user_id, d.serial_no as device_serial,
             p.received_at, p.device_ts, p.verify_mode
        from punches p
        join devices d on d.id = p.device_id
        left join operators o on o.zk_user_id = p.zk_user_id
       where o.id is null
       order by p.received_at desc
       limit 50
  `;

  const recentPunches = await sql`
      select p.id, p.zk_user_id, d.serial_no as device_serial,
             p.received_at, p.device_ts, p.verify_mode, p.claimed,
             o.emp_code, o.full_name
        from punches p
        join devices d on d.id = p.device_id
        left join operators o on o.zk_user_id = p.zk_user_id
       order by p.received_at desc
       limit 25
  `;

  return NextResponse.json({
    devices,
    unknown_users: unknownUsers,
    recent_punches: recentPunches,
  });
});
