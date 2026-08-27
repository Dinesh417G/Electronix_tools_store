// GET /api/v1/reason-codes?applies_to=ISSUE|RECEIPT
//
// Filtered by direction so the terminal never offers "Broken in cut" on a
// PUT IN screen.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  const appliesTo = new URL(request.url).searchParams.get("applies_to");

  return NextResponse.json(
    appliesTo
      ? await sql`
          select id, code, label, applies_to, sort_order from reason_codes
           where active and applies_to = ${appliesTo} order by sort_order, label
        `
      : await sql`
          select id, code, label, applies_to, sort_order from reason_codes
           where active order by applies_to, sort_order, label
        `,
  );
});
