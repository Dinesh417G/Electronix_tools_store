// M7's software half, for the QR sticker: render the barcode the label
// actually carries, decode it with an independent reader, and check the payload
// survives.
//
// The optical half — toner spread, printer calibration, camera focus — still
// needs a real sheet and a real scan. This proves only that what we encode is
// what a reader gets, which is the part provable without a printer.
//
// It also pins the bug it was written to catch: bwip-js renders on a
// transparent background, which flattens to black and decodes as nothing.

import jsQR from "jsqr";
import { PNG } from "pngjs";
import { qrPng } from "../src/lib/labels.ts";

const PAYLOADS = ["TC-000001", "SHOP-ETCHED-77", "CNMG120408-TN2000"];
// 2 is roughly a 203 dpi thermal label; 8 is a 600 dpi office laser.
const SCALES = [2, 4, 8];

let failures = 0;

for (const payload of PAYLOADS) {
  for (const scale of SCALES) {
    const image = PNG.sync.read(await qrPng(payload, scale));
    const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    const got = decoded?.data ?? null;

    if (got !== payload) failures += 1;
    console.log(
      `  ${got === payload ? "PASS" : "FAIL"}  scale=${scale} ${image.width}x${image.height}  ` +
        `${payload} -> ${got ?? "no decode"}`,
    );
  }
}

console.log(failures === 0 ? "\nall QR payloads round-tripped" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
