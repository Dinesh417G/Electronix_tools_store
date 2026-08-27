// Label rendering.
//
// Two outputs, because there are two ways a label can physically happen and
// they share nothing:
//
//   printSheetHtml   an exactly-sized HTML page the browser prints. Works on
//                    any device with any printer, needs a human to tap print.
//   zpl              raw ZPL for a label printer on the plant LAN, sent by an
//                    agent inside the plant. Unattended, but only reachable
//                    from inside.
//
// The Rust `store-label` crate wrote PDFs with its own minimal writer. This
// port prints from HTML instead: CSS `@page` sizes a label in millimetres as
// precisely as the PDF did, and it removes a PDF writer's worth of code that
// existed only because Rust had no browser to hand. What is *not* lost is M7's
// gate — the barcode is still generated from `item_code`, and scanning the
// printed result must still resolve through `/items/lookup`.

import bwipjs from "bwip-js/node";

export interface LabelData {
  /** The QR payload: a tool serial, or the item code for a bin label. */
  code: string;
  itemCode: string;
  description: string;
  binLocation: string | null;
  /** Code128 alongside the QR, so an old wedge scanner still reads it. */
  withCode128: boolean;
}

export interface LabelSize {
  widthMm: number;
  heightMm: number;
}

/**
 * Options shared by every barcode we render, and two of them are load-bearing.
 *
 * `backgroundcolor` — bwip-js draws on a *transparent* ground by default. Any
 * rasteriser that flattens that onto black produces a solid dark square, and
 * no reader decodes it. Verified: without this, jsQR fails at every scale from
 * 84px to 336px; with it, the same payload decodes first try.
 *
 * `padding` — the quiet zone. The QR spec wants four modules of clear margin,
 * and a code printed hard against a cut edge is the classic label that "looks
 * fine" and will not scan under a phone in a workshop.
 */
const BARCODE_BASE = {
  // The human-readable line is drawn by us, in a font we control, rather than
  // by the barcode renderer — a label read by someone in gloves under shop
  // lighting needs a bigger number than the default.
  includetext: false,
  backgroundcolor: "FFFFFF",
  padding: 2,
} as const;

async function svg(bcid: "qrcode" | "code128", text: string, scale: number): Promise<string> {
  return bwipjs.toSVG({
    bcid,
    text,
    scale,
    ...BARCODE_BASE,
    ...(bcid === "code128" ? { height: 8 } : {}),
  });
}

/**
 * The same QR the label carries, as a PNG.
 *
 * Exists so the round-trip test decodes exactly what gets printed rather than
 * something rendered with different options — a test that encodes its own way
 * proves the encoder works, not that the product does.
 */
export async function qrPng(text: string, scale: number): Promise<Buffer> {
  return bwipjs.toBuffer({ bcid: "qrcode", text, scale, ...BARCODE_BASE });
}

/**
 * One label as standalone SVG markup.
 *
 * Quiet zones matter more than they look: a QR printed hard against a cut edge
 * fails to decode on half the phones that try it, and the failure looks like a
 * bad camera rather than a bad label.
 */
export async function labelSvg(data: LabelData, size: LabelSize): Promise<string> {
  const qr = await svg("qrcode", data.code, 3);
  const code128 = data.withCode128 ? await svg("code128", data.itemCode, 2) : null;

  const { widthMm: w, heightMm: h } = size;
  const qrSide = Math.min(h - 4, w * 0.4);

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm"
     viewBox="0 0 ${w} ${h}" class="label">
  <rect width="${w}" height="${h}" fill="#fff"/>
  <g transform="translate(2, ${(h - qrSide) / 2}) scale(${qrSide / 100})">
    ${stripSvgWrapper(qr, 100)}
  </g>
  <text x="${qrSide + 5}" y="${h * 0.3}" font-family="Helvetica, Arial, sans-serif"
        font-size="${Math.min(h * 0.18, 4)}" font-weight="700">${escapeXml(data.code)}</text>
  <text x="${qrSide + 5}" y="${h * 0.48}" font-family="Helvetica, Arial, sans-serif"
        font-size="${Math.min(h * 0.12, 2.6)}">${escapeXml(data.itemCode)}</text>
  <text x="${qrSide + 5}" y="${h * 0.63}" font-family="Helvetica, Arial, sans-serif"
        font-size="${Math.min(h * 0.1, 2.2)}" fill="#333">${escapeXml(truncate(data.description, 34))}</text>
  ${
    data.binLocation
      ? `<text x="${qrSide + 5}" y="${h * 0.78}" font-family="Helvetica, Arial, sans-serif"
        font-size="${Math.min(h * 0.1, 2.2)}" fill="#333">bin ${escapeXml(data.binLocation)}</text>`
      : ""
  }
  ${
    code128
      ? `<g transform="translate(${qrSide + 5}, ${h * 0.82}) scale(${(w - qrSide - 8) / 200}, 0.06)">
    ${stripSvgWrapper(code128, 200)}
  </g>`
      : ""
  }
</svg>`.trim();
}

/**
 * A printable sheet.
 *
 * `@page { size: Wmm Hmm; margin: 0 }` makes each label its own page, which is
 * what a roll-fed label printer expects. On an A4 office printer the same page
 * comes out one label per sheet — correct, wasteful, and obvious enough that
 * nobody prints 200 that way by accident.
 */
export async function printSheetHtml(
  labels: LabelData[],
  size: LabelSize,
  copies = 1,
): Promise<string> {
  const rendered: string[] = [];
  for (const label of labels) {
    const one = await labelSvg(label, size);
    for (let i = 0; i < copies; i += 1) rendered.push(`<div class="page">${one}</div>`);
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Labels — ${labels.length} × ${copies}</title>
<style>
  @page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #f1f5f9; }
  .page { width: ${size.widthMm}mm; height: ${size.heightMm}mm; page-break-after: always;
          background: #fff; margin: 0 auto 4mm; box-shadow: 0 1px 4px rgba(0,0,0,.2); }
  @media print { .page { box-shadow: none; margin: 0; } .hint { display: none; } }
  .hint { font: 14px/1.5 system-ui, sans-serif; text-align: center; padding: 12px; color: #334155; }
</style>
</head>
<body>
<p class="hint">${labels.length} label${labels.length === 1 ? "" : "s"} × ${copies} —
  print at 100% scale, no "fit to page". Then scan one before printing the rest.</p>
${rendered.join("\n")}
<script>window.addEventListener("load", () => window.print());</script>
</body>
</html>`;
}

/**
 * ZPL for a LAN label printer.
 *
 * `^BQ` is the QR, `^BC` the Code128. Kept deliberately plain: every ZPL
 * dialect quirk is one more thing that behaves differently on the printer the
 * shop actually bought.
 */
export function zpl(data: LabelData, size: LabelSize, dpi: number, copies = 1): string {
  const dots = (mm: number) => Math.round((mm / 25.4) * dpi);

  return [
    "^XA",
    `^PW${dots(size.widthMm)}`,
    `^LL${dots(size.heightMm)}`,
    "^LH0,0",
    `^FO${dots(2)},${dots(2)}^BQN,2,5^FDLA,${data.code}^FS`,
    `^FO${dots(22)},${dots(3)}^A0N,${dots(4)},${dots(4)}^FD${data.code}^FS`,
    `^FO${dots(22)},${dots(8)}^A0N,${dots(3)},${dots(3)}^FD${data.itemCode}^FS`,
    `^FO${dots(22)},${dots(12)}^A0N,${dots(2.4)},${dots(2.4)}^FD${truncate(data.description, 28)}^FS`,
    data.binLocation
      ? `^FO${dots(22)},${dots(16)}^A0N,${dots(2.4)},${dots(2.4)}^FDbin ${data.binLocation}^FS`
      : "",
    data.withCode128
      ? `^FO${dots(2)},${dots(size.heightMm - 6)}^BCN,${dots(4)},N,N,N^FD${data.itemCode}^FS`
      : "",
    `^PQ${copies}`,
    "^XZ",
  ]
    .filter(Boolean)
    .join("\n");
}

/** bwip-js returns a complete <svg> document; we need only its contents. */
function stripSvgWrapper(markup: string, _viewBox: number): string {
  return markup.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
