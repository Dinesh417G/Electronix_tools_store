// POST /api/v1/alerts/{id}/ack — the storekeeper has seen this shortage.
//
// Acknowledging is not resolving. The alert stays open until stock actually
// crosses back, because a shortage somebody has merely read about is still a
// shortage.

import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const rows = await sql<{ id: string }[]>`
      update stock_alerts
         set acknowledged_at = now(), acknowledged_by = ${auth.operatorId}
       where id = ${id} and resolved_at is null
       returning id
    `;
    if (!rows[0]) throw ApiError.notFound("no open alert with that id");

    return NextResponse.json({ id: rows[0].id, acknowledged_by: auth.empCode });
  },
);
