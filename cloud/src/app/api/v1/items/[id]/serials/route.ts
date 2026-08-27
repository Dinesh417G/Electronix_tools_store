// GET  /api/v1/items/{id}/serials   the serial list shown on an item
// POST /api/v1/items/{id}/serials   mint N new running numbers

import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticate, requireRole } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { mintSerials, serialsForItem } from "@/lib/serials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await authenticate(request);
    const { id } = await ctx.params;
    return NextResponse.json(await serialsForItem(id));
  },
);

const Mint = z.object({ count: z.number().int().min(1).max(500).default(1) });

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = Mint.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw ApiError.badRequest("count must be 1–500");

    return NextResponse.json(await mintSerials(id, parsed.data.count), { status: 201 });
  },
);
