// GET /api/v1/items/insights?view=<view>&limit= — the catalog, asked a question.
//
// Six views over the same rows, each answering something a storekeeper asks out
// loud: what did we just add, what is plentiful, what is running out, what has
// not moved in a quarter, what gets taken constantly, what went out last.
//
// All of them are reads of the ledger (`src/lib/insights.ts`), not columns
// somebody maintains. The terminal uses the same endpoint as the console, so
// "frequently taken" means the same thing on the shop floor as it does in the
// office — a filter that ranked differently on the two screens would be worse
// than no filter.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { isInsightView, itemInsights, VIEWS } from "@/lib/insights";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const p = new URL(request.url).searchParams;
  const view = p.get("view") ?? "frequent";
  if (!isInsightView(view)) {
    throw ApiError.badRequest(
      `unknown view "${view}" — expected one of ${VIEWS.join(", ")}`,
    );
  }

  const limit = Number.parseInt(p.get("limit") ?? "50", 10);
  return NextResponse.json(
    await itemInsights(view, Number.isNaN(limit) ? 50 : limit),
  );
});
