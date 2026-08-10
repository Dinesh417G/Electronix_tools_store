// The M9 acceptance gate, browser side (CLAUDE.md §13).
//
//   > Terminal offline outbox survives a 10-minute LAN cut with zero duplicates.
//
// Driven against a real `store-server` with a real browser, a real IndexedDB
// queue and a real service worker. The network is cut by aborting requests at
// the browser, which is what the phone actually experiences when the Wi-Fi
// drops — `fetch` rejects, and the app cannot tell "never arrived" from
// "arrived, and the answer was lost".
//
// Two cuts are exercised, and the second is the one that matters:
//
//   1. a clean cut — the request never reaches the server;
//   2. a **lost acknowledgement** — the request reaches the server and commits,
//      and the response is thrown away. This is where duplicates come from, and
//      it is invisible to the client.
//
// The ten minutes are simulated rather than waited out: the cut is held across
// many flush attempts, which is what ten minutes of a thirty-second retry loop
// amounts to. Waiting in real time would make this untestable in CI without
// making it prove anything more.
//
// Usage:  node outbox-soak.mjs <base-url> <enrolment-secret>

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:8099";
const SECRET = process.argv[3] ?? "smoke-test-secret";

const log = (...args) => console.log(...args);
const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

function assertEqual(actual, expected, what) {
  if (String(actual) !== String(expected)) {
    fail(`${what}: expected ${expected}, got ${actual}`);
  }
  log(`  ok  ${what} = ${actual}`);
}

/** Punch at the door as the ADMS terminal would. */
async function punch(zkUserId, when) {
  const response = await fetch(`${BASE}/iclock/cdata?SN=ZK-SOAK-01&table=ATTLOG`, {
    method: "POST",
    body: `${zkUserId}\t${when}\t0\t2\t0\t0`,
  });
  const body = await response.text();
  if (!body.startsWith("OK")) fail(`the device push was not acknowledged: ${body}`);
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const page = await ctx.newPage();

const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

// ── The cut ─────────────────────────────────────────────────────────────
//
// `mode` is one of:
//   "up"      everything through
//   "cut"     writes abort before reaching the server
//   "lost"    writes reach the server and commit; the *response* is discarded
let mode = "up";
let sentWhileLost = 0;

await page.route("**/api/v1/txn/**", async (route) => {
  if (mode === "up") return route.continue();

  if (mode === "cut") {
    return route.abort("internetdisconnected");
  }

  // "lost": let it commit, then throw the answer away.
  try {
    await route.fetch();
    sentWhileLost += 1;
  } catch {
    // ignore — the point is that the client never learns either way
  }
  return route.abort("internetdisconnected");
});

log("1. enrol and claim a session while the network is up");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByPlaceholder("e.g. Store door tablet").fill("Soak test");
await page.locator("input[type=password]").fill(SECRET);
await page.getByRole("button", { name: /Enrol this device/ }).click();
await page.waitForSelector("text=ELECTRONIX TOOL STORE", { timeout: 15000 });

// Wait for the event stream before punching. A punch that arrives before the
// stream is connected is not lost — the reconciliation read picks it up — but
// it would make this test wait a minute for no reason.
await page.waitForSelector("text=Live", { timeout: 15000 });

/** Walk one issue through the terminal, from punch to CONFIRM. */
async function issueOnce(qtyTaps, when) {
  await page.waitForSelector("text=Live", { timeout: 15000 });
  await punch("1042", when);
  await page.waitForSelector("text=Who are you?", { timeout: 15000 });
  await page.getByText("R. Kumar").click();
  await page.waitForSelector("text=TAKE OUT", { timeout: 15000 });
  await page.getByText("TAKE OUT").click();
  await page.waitForSelector("text=What are you taking?", { timeout: 15000 });
  await page.getByPlaceholder(/Code, description/).fill("SOAK");
  await page.waitForSelector("text=SOAK-ITEM", { timeout: 15000 });
  await page.getByText("SOAK-ITEM").first().click();
  await page.waitForSelector("text=In system", { timeout: 15000 });
  for (const tap of qtyTaps) {
    await page.getByRole("button", { name: tap, exact: true }).click();
  }
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForSelector("text=Anything else?", { timeout: 15000 });
  await page.getByRole("button", { name: "SKIP", exact: true }).click();
  await page.waitForSelector("text=Confirm", { timeout: 15000 });
  await page.getByRole("button", { name: "CONFIRM", exact: true }).click();
}

/** How many rows are queued in IndexedDB right now. */
async function queuedCount() {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("electronix-store-outbox", 1);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction("pending", "readonly").objectStore("pending").count();
          req.onsuccess = () => {
            resolve(req.result);
            db.close();
          };
          req.onerror = () => reject(req.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
}

// ── Cut 1: the request never arrives ────────────────────────────────────
log("\n2. CUT — three issues while the LAN is down");
mode = "cut";

let clock = 0;
const stamp = () => {
  clock += 1;
  const d = new Date(Date.UTC(2026, 7, 10, 4, 0, clock));
  return d.toISOString().slice(0, 19).replace("T", " ");
};

for (const taps of [["+1"], ["+5"], ["+1", "+1"]]) {
  await issueOnce(taps, stamp());
  await page.waitForSelector("text=/Saved on this device/", { timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForTimeout(200);
}

assertEqual(await queuedCount(), 3, "queued after the cut");

log("\n3. hold the cut across many flush attempts (a 10-minute retry loop)");
for (let i = 0; i < 20; i += 1) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(50);
}
assertEqual(await queuedCount(), 3, "still queued while the LAN is down");

const beforeRestore = await fetch(`${BASE}/api/v1/version`).then((r) => r.status);
assertEqual(beforeRestore, 200, "the server was reachable all along");

log("\n4. RESTORE — flush");
mode = "up";
for (let i = 0; i < 30 && (await queuedCount()) > 0; i += 1) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(200);
}
assertEqual(await queuedCount(), 0, "queue drained after the LAN returned");

// ── Cut 2: the acknowledgement is lost ──────────────────────────────────
log("\n5. LOST ACK — the request commits, the answer is discarded");
mode = "lost";
sentWhileLost = 0;

await issueOnce(["+10"], stamp());
await page.waitForSelector("text=/Saved on this device/", { timeout: 15000 });
await page.getByRole("button", { name: "Done" }).click();

if (sentWhileLost < 1) fail("the request never reached the server — test is not testing anything");
log(`  (the server received ${sentWhileLost} request(s) whose answers were discarded)`);
assertEqual(await queuedCount(), 1, "queued despite having committed");

log("\n6. RESTORE — the retry must be answered, not refused");
mode = "up";
for (let i = 0; i < 30 && (await queuedCount()) > 0; i += 1) {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(200);
}
assertEqual(await queuedCount(), 0, "queue drained after the lost-ack retry");

// The banner that would appear if the retry had been refused. Its absence is
// the whole point: an operator told "not recorded" re-enters by hand.
const refused = await page
  .locator("text=/refused by the server and not recorded/")
  .count();
assertEqual(refused, 0, "no 'refused' banner shown for a committed transaction");

log("\n7. the ledger");
if (consoleErrors.length) fail(`console errors: ${consoleErrors.join(", ")}`);
await browser.close();

// Reported back to the caller, which checks the arithmetic against the API.
log("SOAK-COMPLETE");
