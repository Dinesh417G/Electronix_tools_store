// GET /api/v1/items/{id}

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { getItem } from "@/lib/items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await authenticate(request);
    const { id } = await ctx.params;
    return NextResponse.json(await getItem(id));
  },
);
