// GET /api/v1/admin/printer — the label printer settings screen
// PUT /api/v1/admin/printer
//
// `mode` is the honest part of this screen. A browser cannot open a raw socket
// to a printer, and a serverless function in the cloud has no route to a
// private LAN address — so an IP here does nothing until something inside the
// plant is polling for jobs. The UI says so rather than offering a field that
// silently has no effect.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { getPrinterSettings, updatePrinterSettings } from "@/lib/serials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");
  return NextResponse.json(await getPrinterSettings());
});

const Body = z.object({
  mode: z.enum(["BROWSER_PDF", "LAN_AGENT"]).optional(),
  name: z.string().trim().max(120).nullish(),
  host: z.string().trim().max(255).nullish(),
  port: z.number().int().min(1).max(65535).optional(),
  dpi: z.union([z.literal(203), z.literal(300), z.literal(600)]).optional(),
  label_width_mm: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  label_height_mm: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

export const PUT = handler(async (request: Request) => {
  await requireRole(request, "ADMIN");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw ApiError.badRequest("invalid printer settings", parsed.error.issues);

  return NextResponse.json(await updatePrinterSettings(parsed.data));
});
