// GET /api/v1/items/search?q=… — typeahead for the "Search instead" path.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { searchItems } from "@/lib/items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const params = new URL(request.url).searchParams;
  const q = params.get("q") ?? "";
  const limit = Number.parseInt(params.get("limit") ?? "25", 10);

  return NextResponse.json(await searchItems(q, Number.isNaN(limit) ? 25 : limit));
});
