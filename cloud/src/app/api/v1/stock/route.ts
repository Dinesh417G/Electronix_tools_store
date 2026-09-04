// GET /api/v1/stock?low=&empty=&category=&bin=&q=&limit=&offset=&sort=&dir=
//
// Serves two callers with one shape: the live view's stock panel and the admin
// console's catalog list. The console opens its edit form from the row it
// already holds, so this returns the complete item rather than a stock-shaped
// subset — a column missing here is a column the form saves back as blank.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { handler } from "@/lib/errors";
import { stockList } from "@/lib/items";
import { resolveSort, STOCK_SORTS, TOTAL_HEADER } from "@/lib/paging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);
  const p = new URL(request.url).searchParams;

  const limit = Number.parseInt(p.get("limit") ?? "500", 10);
  // Read, because it was being *sent*. The terminal's browse-all asked for
  // `offset` from the day it was written and this route dropped it on the
  // floor, so every "Load more" appended the same first page again — duplicate
  // rows, and a button that could never retire because a full page always came
  // back. A parameter a caller can pass and the server silently ignores is
  // worse than one it rejects: nothing anywhere reports the disagreement.
  const offset = Number.parseInt(p.get("offset") ?? "0", 10);
  const { key, descending } = resolveSort(p.get("sort"), p.get("dir"), STOCK_SORTS, "alerts");

  const page = await stockList({
      states: p.get("empty") ? ["EMPTY"] : p.get("low") ? ["LOW", "EMPTY"] : null,
      q: p.get("q")?.trim() || null,
      bin: p.get("bin")?.trim() || null,
      category: p.get("category")?.trim() || null,
      limit: Number.isNaN(limit) ? 500 : limit,
      offset: Number.isNaN(offset) ? 0 : offset,
      sort: key,
      descending,
  });

  // The body is the array it always was; the count rides in a header, so every
  // reader that predates this keeps working and `crates/` can serve the same
  // route unchanged (`src/lib/paging.ts`).
  return NextResponse.json(page.rows, { headers: { [TOTAL_HEADER]: String(page.total) } });
});
