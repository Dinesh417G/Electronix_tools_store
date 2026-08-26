// GET /api/v1/stock?low=&empty=&category=&bin=&q=&limit=
//
// Serves two callers with one shape: the live view's stock panel and the admin
// console's catalog list. The console opens its edit form from the row it
// already holds, so this returns the complete item rather than a stock-shaped
// subset — a column missing here is a column the form saves back as blank.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { stockList } from "@/lib/items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  const p = new URL(request.url).searchParams;

  const limit = Number.parseInt(p.get("limit") ?? "500", 10);

  return NextResponse.json(
    await stockList({
      states: p.get("empty") ? ["EMPTY"] : p.get("low") ? ["LOW", "EMPTY"] : null,
      q: p.get("q")?.trim() || null,
      bin: p.get("bin")?.trim() || null,
      category: p.get("category")?.trim() || null,
      limit: Number.isNaN(limit) ? 500 : limit,
    }),
  );
});
