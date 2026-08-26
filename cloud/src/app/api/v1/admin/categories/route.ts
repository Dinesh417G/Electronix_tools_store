// GET /api/v1/admin/categories — the picker on the item form.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");
  return NextResponse.json(
    await sql`select id, name, sort_order from item_categories order by sort_order, name`,
  );
});
