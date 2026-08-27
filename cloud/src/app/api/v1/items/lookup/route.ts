// GET /api/v1/items/lookup?barcode=… — resolve a scan to an item.
//
// §11 asks for this under 100 ms: it sits between the operator putting a label
// under the camera and the screen changing, and anything slower reads as a
// scanner that did not work.

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { lookupByCode } from "@/lib/items";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await authenticate(request);

  const barcode = new URL(request.url).searchParams.get("barcode");
  if (!barcode) throw ApiError.badRequest("barcode is required");

  return NextResponse.json(await lookupByCode(barcode));
});
