// GET /api/v1/labels/sheet?serial_ids=…&item_ids=…&copies=N
//
// Returns a printable page, sized in millimetres from printer_settings. The
// browser prints it; §11's 500-label cap is kept because a mis-typed copy count
// is otherwise a whole roll of stock.

import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { printSheetHtml, type LabelData, type SheetPaper } from "@/lib/labels";
import { getPrinterSettings } from "@/lib/serials";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LABELS = 500;

export const GET = handler(async (request: Request) => {
  await requireRole(request, "STOREKEEPER", "ADMIN");

  const params = new URL(request.url).searchParams;
  const serialIds = idList(params.get("serial_ids"));
  const itemIds = idList(params.get("item_ids"));
  const copies = z.coerce.number().int().min(1).max(50).catch(1).parse(params.get("copies"));

  if (serialIds.length === 0 && itemIds.length === 0) {
    throw ApiError.badRequest("give serial_ids or item_ids");
  }

  const labels: LabelData[] = [];

  if (serialIds.length > 0) {
    const rows = await sql<
      { serial_no: string; item_code: string; description: string; bin_location: string | null }[]
    >`
      select s.serial_no, i.item_code, i.description, i.bin_location
        from tool_serials s
        join items i on i.id = s.item_id
       where s.id = any(${serialIds}::uuid[])
       order by s.serial_no
    `;
    for (const r of rows) {
      labels.push({
        code: r.serial_no,
        itemCode: r.item_code,
        description: r.description,
        binLocation: r.bin_location,
        withCode128: true,
      });
    }
  }

  if (itemIds.length > 0) {
    // A bin label carries the item code, not a serial: it identifies the
    // location's contents, and it is what §12.4's scan path resolves.
    const rows = await sql<
      { item_code: string; description: string; bin_location: string | null }[]
    >`
      select item_code, description, bin_location
        from items where id = any(${itemIds}::uuid[]) order by item_code
    `;
    for (const r of rows) {
      labels.push({
        code: r.item_code,
        itemCode: r.item_code,
        description: r.description,
        binLocation: r.bin_location,
        withCode128: true,
      });
    }
  }

  if (labels.length === 0) throw ApiError.notFound("nothing to print");
  if (labels.length * copies > MAX_LABELS) {
    throw ApiError.badRequest(`that is ${labels.length * copies} labels; the cap is ${MAX_LABELS}`);
  }

  const printer = await getPrinterSettings();
  const html = await printSheetHtml(
    labels,
    {
      widthMm: Number(printer.label_width_mm),
      heightMm: Number(printer.label_height_mm),
    },
    copies,
    printer.sheet_paper as SheetPaper,
  );

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});

function idList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}
