// The camera that stayed black until you toggled to search and back.
//
// Reported from a Pixel 6a on Chrome, which has everything scanning needs:
// press TAKE OUT, the viewfinder is a black rectangle and nothing ever
// detects; press Search, press Scan, and the same camera works perfectly.
//
// Two faults, one symptom.
//
//   1. `ItemScreen`'s scanner effect depended on `resolve`, which closes over
//      the `onPick` the parent passes as an inline arrow — a new function on
//      every render of the whole terminal. So the camera was torn down and
//      reopened on every parent render, and entering the item screen is
//      exactly when the parent is busiest (the poll dropping the card that was
//      just claimed, the revision bump, the connection pill going live).
//
//   2. `startScanner`'s handle cleared `video.srcObject` unconditionally on
//      `stop()`. `getUserMedia` takes about a second on a phone, so the
//      restart above resolved *after* its replacement had already attached a
//      live stream to the same element — and the stale handle blanked it.
//      `readyState` then stayed 0, `detect()` never ran, and the
//      swallowed-frame catch in `tick` reported nothing at all.
//
// Fault 2 is what produced the black rectangle; fault 1 is what made it happen
// on the first scan of every session. Both are checked here, because fixing
// either alone leaves the other free to bring it back — fault 2 on its own
// still reopens the camera constantly, and fault 1 on its own still races any
// genuine unmount.
//
// No database, no browser: the scanner module touches only DOM globals, and
// those are stubbed below.
//
//   node --experimental-strip-types tests/scanner-restart.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

let checks = 0;
const ok = (cond, what) => {
  assert.ok(cond, what);
  checks += 1;
};

// ── The DOM this module actually uses ───────────────────────────────────────

const timers = new Map();
let rafId = 0;
globalThis.requestAnimationFrame = (cb) => {
  const id = ++rafId;
  timers.set(id, setTimeout(cb, 5));
  return id;
};
globalThis.cancelAnimationFrame = (id) => {
  clearTimeout(timers.get(id));
  timers.delete(id);
};

class FakeTrack {
  constructor() {
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
  getCapabilities() {
    return {};
  }
}

/** Just enough MediaStream for `startScanner`: tracks, and identity. */
class FakeStream {
  constructor(label) {
    this.label = label;
    this.track = new FakeTrack();
  }
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}

/** One `<video>`, shared by both scanners — which is the whole point. */
const video = {
  srcObject: null,
  // Frames are flowing as far as `tick` is concerned; whether it ever gets to
  // look is what this test is about.
  readyState: 4,
  setAttribute() {},
  play: async () => {},
};

// A detector that finds nothing. Detection itself is not under test.
globalThis.BarcodeDetector = class {
  async detect() {
    return [];
  }
};

/** Queue of streams to hand out, so each call gets a distinguishable one. */
let pending = [];
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: async () => {
        const next = pending.shift();
        if (!next) throw Object.assign(new Error("no camera"), { name: "NotFoundError" });
        return next();
      },
    },
  },
});

const { startScanner } = await import("../src/lib/scanner.ts");

const later = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. A stale handle must not blank the live camera ────────────────────────
//
// The interleaving that a Pixel produces: the first scanner opens its camera,
// attaches, and is still inside `video.play()` when its effect is torn down.
// The replacement opens, attaches, and is live. Only then does the first one's
// promise resolve, see `cancelled`, and call `stop()`.

const streamA = new FakeStream("A");
const streamB = new FakeStream("B");

// A's camera opens promptly; A's `play()` is what runs long. On a real device
// that is unremarkable — `play()` on a stream that is about to be replaced
// stalls and then rejects, which `startScanner` catches and ignores.
let releaseAPlay;
const aPlayed = new Promise((r) => (releaseAPlay = r));
pending = [() => streamA, () => streamB];

const noop = () => {};
const startA = startScanner({ video, onDetect: noop, onError: noop });
// Swap in the slow `play` only for A's turn: the stub above is shared.
video.play = async () => {
  video.play = async () => {};
  await aPlayed;
};

await later(1);
const startB = startScanner({ video, onDetect: noop, onError: noop });
const handleB = await startB;

ok(video.srcObject === streamB, "the replacement scanner is the one on screen");

// Now the abandoned first scanner finally finishes and is stopped, exactly as
// `ItemScreen`'s `cancelled` branch does.
releaseAPlay();
const handleA = await startA;
handleA.stop();

ok(
  video.srcObject === streamB,
  "a stale scanner must not clear a <video> it no longer owns — this is the black rectangle",
);
ok(streamA.track.stopped, "the abandoned scanner still releases its own camera");
ok(!streamB.track.stopped, "the live scanner's camera is left alone");

// ── 2. stop() is idempotent ─────────────────────────────────────────────────
//
// A handle is routinely stopped twice: once by the effect cleanup that holds
// it, once by the late `cancelled` branch of the promise that produced it.

handleA.stop();
ok(video.srcObject === streamB, "stopping a stale handle twice is still a no-op");

handleB.stop();
ok(video.srcObject === null, "the owning scanner does hand the element back");
ok(streamB.track.stopped, "and releases its camera");

// ── 3. The effect must not depend on the callback's identity ────────────────
//
// Fault 1, checked by reading the source, because reproducing it needs React
// and a parent render. `resolve` is rebuilt on every parent render, so naming
// it in the dependency array is what reopened the camera constantly. The
// running scanner reaches the current callback through a ref instead.

const EFFECT = /useEffect\(\(\) => \{\s*if \(mode !== "scan"\) return;[\s\S]*?\}, \[([^\]]*)\]\);/;

for (const rel of [
  "cloud/src/screens/Terminal.tsx",
  "crates/store-web/src/screens/Terminal.tsx",
]) {
  const src = readFileSync(join(repo, rel), "utf8");
  const found = src.match(EFFECT);
  assert.ok(found, `${rel}: could not find the scanner effect`);
  const deps = found[1]
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);

  ok(
    deps.length === 1 && deps[0] === "mode",
    `${rel}: the scanner effect must depend on \`mode\` alone, not on [${deps.join(", ")}] — ` +
      "anything rebuilt per render reopens the camera per render",
  );
  ok(
    /onDetect: \(code\) => void resolveRef\.current\(code\)/.test(src),
    `${rel}: detection must reach the current callback through a ref`,
  );
}

// ── 4. Both scanner modules carry the ownership guard ───────────────────────

for (const rel of ["cloud/src/lib/scanner.ts", "crates/store-web/src/lib/scanner.ts"]) {
  const src = readFileSync(join(repo, rel), "utf8");
  ok(
    /if \(video\.srcObject === stream\) video\.srcObject = null;/.test(src),
    `${rel}: stop() must only clear a <video> it still owns`,
  );
  ok(/if \(stopped\) return;/.test(src), `${rel}: stop() must be idempotent`);
}

console.log(`scanner-restart: ${checks} assertions passed`);
