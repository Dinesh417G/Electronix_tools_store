// POST /api/v1/admin/labels/print — a batch of bin labels (§11).
//
// §11 specified a PDF. This returns HTML sized in millimetres by CSS `@page`,
// for the reason recorded in `labels.ts`: the browser prints it just as
// precisely and it costs a PDF writer less code. The console opens the response
// as a blob in a new tab, where it prints itself.
//
// The 500 cap is §11's, kept: a mis-typed copy count is otherwise a whole roll
// of label stock.

import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { printSheetHtml, type LabelData, type SheetPaper } from "@/lib/labels";
import { getPrinterSettings, queuePrintJob } from "@/lib/serials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LABELS = 500;

const Body = z.object({
  item_ids: z.array(z.string().uuid()).min(1).max(MAX_LABELS),
  copies: z.number().int().min(1).max(50).default(1),
  /** Overrides the store's configured paper for this batch only. */
  paper: z.enum(["EXACT", "A4", "LETTER"]).optional(),
});

export const POST = handler(async (request: Request) => {
  const auth = await requireRole(request, "STOREKEEPER", "ADMIN");

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) throw ApiError.badRequest("item_ids is required", parsed.error.issues);
  const { item_ids, copies, paper } = parsed.data;

  if (item_ids.length * copies > MAX_LABELS) {
    throw ApiError.badRequest(
      `that is ${item_ids.length * copies} labels; the cap is ${MAX_LABELS}`,
    );
  }

  const rows = await sql<
    { id: string; item_code: string; description: string; bin_location: string | null }[]
  >`
    select id, item_code, description, bin_location
      from items where id = any(${item_ids}::uuid[]) order by item_code
  `;
  if (rows.length === 0) throw ApiError.notFound("none of those items exist");

  const labels: LabelData[] = rows.map((r) => ({
    // A bin label carries the item code: it identifies what lives in the
    // location, not which individual tool. Serial stickers are the other route.
    code: r.item_code,
    itemCode: r.item_code,
    description: r.description,
    binLocation: r.bin_location,
    withCode128: true,
  }));

  const printer = await getPrinterSettings();
  const html = await printSheetHtml(
    labels,
    {
      widthMm: Number(printer.label_width_mm),
      heightMm: Number(printer.label_height_mm),
    },
    copies,
    (paper ?? printer.sheet_paper) as SheetPaper,
  );

  // Recorded even in BROWSER_PDF mode, so "who printed what" survives the
  // browser tab that did it.
  for (const row of rows) {
    await queuePrintJob({
      itemId: row.id,
      copies,
      kind: "BIN_LABEL",
      requestedBy: auth.operatorId,
    }).catch(() => {});
  }

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});
