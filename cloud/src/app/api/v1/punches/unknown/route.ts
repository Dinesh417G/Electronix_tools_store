// GET /api/v1/punches/unknown — punches whose zk_user_id maps to no operator.
//
// §9.4: such a punch is still recorded and raises an admin notice. Dropping it
// because the operator master is incomplete is how you end up unable to explain
// a gap six months later — somebody opened that door, and the history should
// say so even when it cannot say who.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  const since = new URL(request.url).searchParams.get("since");

  return NextResponse.json(
    await sql`
      select p.id, p.zk_user_id, d.serial_no as device_serial,
             p.received_at, p.device_ts, p.verify_mode
        from punches p
        join devices d on d.id = p.device_id
        left join operators o on o.zk_user_id = p.zk_user_id
       where o.id is null
         and (${since}::timestamptz is null or p.received_at > ${since}::timestamptz)
       order by p.received_at desc
       limit 50
    `,
  );
});
