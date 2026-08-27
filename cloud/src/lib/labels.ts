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
  const qr = inlineSvg(await svg("qrcode", data.code, 3));
  const code128 = data.withCode128 ? inlineSvg(await svg("code128", data.itemCode, 2)) : null;

  const { widthMm: w, heightMm: h } = size;

  // Layout in millimetres, computed rather than guessed at percentages. The
  // first printed batch had every text line running off the right edge,
  // because the old version positioned text by fractions of the height and
  // truncated the description at a fixed 34 characters whatever the label
  // measured. A 50 × 25 label and a 100 × 50 label are not the same shape.
  const pad = 2;
  const qrSide = Math.min(h - pad * 2, w * 0.3);
  const textX = pad + qrSide + 2;
  const textW = w - textX - pad;

  // Code128 gets a real strip at the bottom when there is room for one that a
  // wedge scanner can actually read. Below ~6 mm of bar height, decode rates
  // fall off a cliff, so a cramped label carries the QR alone rather than a
  // barcode that only looks like one.
  const barH = Math.min(5, h * 0.22);
  const wantsBars = code128 !== null && h >= 18;
  const textBottom = wantsBars ? h - barH - pad : h - pad;

  // Helvetica advance widths, near enough to lay out a label: 0.58 em for the
  // bold line, 0.52 for the rest.
  const widthOf = (text: string, fontSize: number, bold = false) =>
    text.length * fontSize * (bold ? 0.58 : 0.52);
  const fit = (text: string, fontSize: number) =>
    truncate(text, Math.max(4, Math.floor(textW / (fontSize * 0.52))));

  // The item code is the one line that must survive intact: it is what somebody
  // reads out when the scanner will not play, and half a code is worse than
  // none because it looks like a whole one. So it shrinks to fit rather than
  // truncating, down to a floor below which it stops being readable across a
  // workshop — and only then does it lose characters.
  const codeCeiling = clamp(h * 0.17, 2.6, 4.2);
  let codeSize = codeCeiling;
  while (codeSize > 2.2 && widthOf(data.code, codeSize, true) > textW) {
    codeSize -= 0.1;
  }
  const itemSize = clamp(h * 0.11, 2.0, 2.8);
  const metaSize = clamp(h * 0.095, 1.8, 2.4);

  // Baselines stacked from the top of the text column, so nothing overlaps at
  // any label size and the block stays vertically centred against the QR.
  const lines: { text: string; size: number; weight: number; fill: string }[] = [
    {
      text: widthOf(data.code, codeSize, true) > textW ? fit(data.code, codeSize) : data.code,
      size: codeSize,
      weight: 700,
      fill: "#000",
    },
  ];
  if (data.itemCode !== data.code) {
    lines.push({ text: fit(data.itemCode, itemSize), size: itemSize, weight: 400, fill: "#000" });
  }
  lines.push({ text: fit(data.description, metaSize), size: metaSize, weight: 400, fill: "#333" });
  if (data.binLocation) {
    lines.push({
      text: fit(`bin ${data.binLocation}`, metaSize),
      size: metaSize,
      weight: 700,
      fill: "#000",
    });
  }

  const gap = 0.9;
  const blockH = lines.reduce((sum, l) => sum + l.size + gap, -gap);
  let baseline = Math.max(pad + lines[0].size, (textBottom + pad - blockH) / 2 + lines[0].size);

  const text = lines
    .map((line) => {
      const y = baseline;
      baseline += line.size + gap;
      return `<text x="${round(textX)}" y="${round(y)}" font-family="Helvetica, Arial, sans-serif"
        font-size="${round(line.size)}" font-weight="${line.weight}" fill="${line.fill}"
      >${escapeXml(line.text)}</text>`;
    })
    .join("\n  ");

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm"
     viewBox="0 0 ${w} ${h}" class="label">
  <rect width="${w}" height="${h}" fill="#fff"/>
  <g transform="translate(${pad}, ${round((h - qrSide) / 2)}) scale(${round(qrSide / qr.width, 5)})">
    ${qr.inner}
  </g>
  ${text}
  ${
    wantsBars
      ? `<g transform="translate(${round(textX)}, ${round(h - barH - pad * 0.5)}) scale(${round(
          textW / code128!.width,
          5,
        )}, ${round(barH / code128!.height, 5)})">
    ${code128!.inner}
  </g>`
      : ""
  }
</svg>`.trim();
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const round = (value: number, dp = 2) => Number(value.toFixed(dp));

/** Where the labels are going to land. */
export type SheetPaper = "EXACT" | "A4" | "LETTER";

const PAPER: Record<Exclude<SheetPaper, "EXACT">, { widthMm: number; heightMm: number }> = {
  A4: { widthMm: 210, heightMm: 297 },
  LETTER: { widthMm: 215.9, heightMm: 279.4 },
};

/** Printers cannot reach the edge; 8 mm is inside every one worth supporting. */
const SHEET_MARGIN_MM = 8;
const SHEET_GAP_MM = 2;

/**
 * A printable sheet.
 *
 * Two layouts, because there are two destinations and they want opposite
 * things:
 *
 *   EXACT      one label per page, page sized to the label. What a roll-fed
 *              label printer expects.
 *   A4/LETTER  a grid on office paper with cut guides.
 *
 * The grid exists because the first real print produced three Letter pages for
 * two labels, each a stamp marooned in a white field. `@page { size }` is
 * advisory: Chrome on Android ignores it entirely and prints whatever paper the
 * dialogue has selected, so an exactly-sized page is not a promise a browser
 * keeps. Deciding the layout here — rather than hoping the print dialogue
 * cooperates — is what makes the output predictable on a phone.
 */
export async function printSheetHtml(
  labels: LabelData[],
  size: LabelSize,
  copies = 1,
  paper: SheetPaper = "A4",
): Promise<string> {
  const rendered: string[] = [];
  for (const label of labels) {
    const one = await labelSvg(label, size);
    for (let i = 0; i < copies; i += 1) rendered.push(one);
  }

  const total = rendered.length;
  const plural = `${total} label${total === 1 ? "" : "s"}`;

  if (paper === "EXACT") {
    return page(
      `@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }
  .label-page { width: ${size.widthMm}mm; height: ${size.heightMm}mm; background: #fff;
                page-break-after: always; margin: 0 auto 4mm;
                box-shadow: 0 1px 4px rgba(0,0,0,.2); }
  @media print { .label-page { box-shadow: none; margin: 0; } }`,
      `${plural}, one per page at ${size.widthMm} × ${size.heightMm} mm.
       Print at 100% scale — never "fit to page", or the barcode changes size and
       the scanner starts guessing.`,
      rendered.map((svgMarkup) => `<div class="label-page">${svgMarkup}</div>`).join("\n"),
      total,
    );
  }

  const sheet = PAPER[paper];
  const usableW = sheet.widthMm - SHEET_MARGIN_MM * 2;
  const usableH = sheet.heightMm - SHEET_MARGIN_MM * 2;
  const cols = Math.max(1, Math.floor((usableW + SHEET_GAP_MM) / (size.widthMm + SHEET_GAP_MM)));
  const rows = Math.max(1, Math.floor((usableH + SHEET_GAP_MM) / (size.heightMm + SHEET_GAP_MM)));
  const perSheet = cols * rows;
  const sheets = Math.ceil(total / perSheet);

  const pages: string[] = [];
  for (let i = 0; i < total; i += perSheet) {
    pages.push(
      `<div class="sheet">${rendered
        .slice(i, i + perSheet)
        .map((svgMarkup) => `<div class="cell">${svgMarkup}</div>`)
        .join("\n")}</div>`,
    );
  }

  return page(
    `@page { size: ${paper === "A4" ? "A4" : "Letter"}; margin: ${SHEET_MARGIN_MM}mm; }
  .sheet { display: grid; page-break-after: always;
           grid-template-columns: repeat(${cols}, ${size.widthMm}mm);
           grid-auto-rows: ${size.heightMm}mm; gap: ${SHEET_GAP_MM}mm;
           justify-content: start; align-content: start; }
  .sheet:last-child { page-break-after: auto; }
  /* A dashed guide, not a solid rule: it says "cut here" without becoming part
     of the label if somebody cuts a millimetre wide. */
  .cell { outline: 0.2mm dashed #94a3b8; outline-offset: 0; background: #fff;
          overflow: hidden; }
  .cell svg { display: block; width: 100%; height: 100%; }
  @media screen {
    .sheet { background: #fff; padding: ${SHEET_MARGIN_MM}mm; margin: 0 auto 6mm;
             box-shadow: 0 1px 6px rgba(0,0,0,.25); width: ${sheet.widthMm}mm;
             box-sizing: border-box; }
  }`,
    `${plural} on ${sheets} ${paper} sheet${sheets === 1 ? "" : "s"},
     ${cols} × ${rows} per sheet at ${size.widthMm} × ${size.heightMm} mm.
     Print at 100% scale — never "fit to page", or the barcode changes size and
     the scanner starts guessing. Cut along the dashed guides.`,
    pages.join("\n"),
    total,
  );
}

function page(css: string, hint: string, body: string, total: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Labels — ${total}</title>
<style>
  ${css}
  html, body { margin: 0; padding: 0; background: #f1f5f9; }
  .hint { font: 14px/1.5 system-ui, -apple-system, sans-serif; padding: 12px 16px;
          color: #1e293b; background: #e2e8f0; }
  .hint button { font: inherit; font-weight: 600; margin-left: 8px; padding: 6px 14px;
                 border: 0; border-radius: 8px; background: #0284c7; color: #fff; }
  @media print { .hint { display: none; } }
</style>
</head>
<body>
<p class="hint">${hint}<button type="button" onclick="window.print()">Print</button></p>
${body}
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

/**
 * bwip-js returns a complete `<svg>` document; we need its contents *and* its
 * dimensions.
 *
 * The dimensions are the part that was wrong. The first version inlined the
 * markup and scaled it as though the coordinate space were 100 units wide,
 * which is a number bwip-js never produces: a QR of this payload measures 138
 * and a Code128 measures 408 × 54. Every printed label therefore had a QR
 * 1.38× oversized, sprawling across the text beside it, and a barcode stretched
 * to roughly twice its width. Reading the viewBox is the whole fix.
 */
function inlineSvg(markup: string): { inner: string; width: number; height: number } {
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(markup);
  return {
    inner: markup.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, ""),
    width: viewBox ? Number(viewBox[1]) : 100,
    height: viewBox ? Number(viewBox[2]) : 100,
  };
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
