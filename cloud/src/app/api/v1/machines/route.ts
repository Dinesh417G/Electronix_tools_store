// GET /api/v1/machines — the picker on §12.6's optional step.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  return NextResponse.json(
    await sql`select id, code, name from machines where active order by code`,
  );
});
