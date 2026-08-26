// POST /api/v1/serials/{id}/print — print, or reprint, one sticker.
//
// A replacement sticker is the same number printed again. print_count goes up;
// no new row, no new number. Reprinting a label is not relabelling a tool.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { ApiError, handler } from "@/lib/errors";
import { getSerial, queuePrintJob, recordPrint } from "@/lib/serials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ copies: z.number().int().min(1).max(50).default(1) });

export const POST = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireRole(request, "STOREKEEPER", "ADMIN");
    const { id } = await ctx.params;

    const parsed = Body.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) throw ApiError.badRequest("copies must be 1–50");
    const copies = parsed.data.copies;

    const serial = await getSerial(id);
    const job = await queuePrintJob({
      serialId: serial.id,
      itemId: serial.item_id,
      copies,
      kind: "SERIAL_QR",
      requestedBy: auth.operatorId,
    });

    const updated = await recordPrint(id, copies);

    return NextResponse.json({
      job_id: job.id,
      status: job.status,
      mode: job.mode,
      // BROWSER_PDF has nothing to poll for — the caller opens this and prints.
      sheet_url: job.mode === "BROWSER_PDF"
        ? `/api/v1/labels/sheet?serial_ids=${serial.id}&copies=${copies}`
        : null,
      serial: updated,
    });
  },
);
