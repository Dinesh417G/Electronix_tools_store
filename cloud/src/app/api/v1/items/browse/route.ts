// GET /api/v1/items/browse?offset=&limit= — the Browse all list.
//
// Paged rather than one long list: the demo crib is 90 items and a real one is
// larger, and a terminal that renders all of them scrolls badly on a phone.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { browseItems } from "@/lib/items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const params = new URL(request.url).searchParams;
  const offset = Number.parseInt(params.get("offset") ?? "0", 10);
  const limit = Number.parseInt(params.get("limit") ?? "25", 10);

  return NextResponse.json(
    await browseItems(Number.isNaN(offset) ? 0 : offset, Number.isNaN(limit) ? 25 : limit),
  );
});
