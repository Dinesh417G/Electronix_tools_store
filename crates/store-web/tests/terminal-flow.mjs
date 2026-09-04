// The operator's flow, driven through the actual terminal (CLAUDE.md §12).
//
// This side of the workspace had no such test, and it is exactly what that
// cost: the quantity pad used its own default as a prefix, so tapping **2** on
// a pad showing **1** booked **12** — a plausible number that nothing refuses,
// on a success screen, with the bin ten short a week later. Every API-level
// test passed throughout, correctly: the API was never asked for 12, the
// screen sent it.
//
// What it drives, as an operator would:
//
//   enrol → idle → manual sign-in (§10's fallback) → TAKE OUT → find the item
//   → quantity → skip the optional step → confirm
//
// and then asks the server what the on-hand actually is, because a screen that
// says "done" and a row that exists are different claims (§7).
//
// It also pins the two structural rules the shell was rebuilt around (§12):
// the page never scrolls — a screen fills the viewport and its list scrolls
// inside it — and the back control lives *inside* the bottom bar rather than
// floating over content. Both are assertions about geometry because no text
// assertion can see either: every word is present and correct on the broken
// build.
//
//   STORE_BASE=… STORE_ENROLMENT_SECRET=… node tests/terminal-flow.mjs

import { launchChrome, sleep, tally, trim } from "./cdp.mjs";

const BASE = process.env.STORE_BASE ?? "http://127.0.0.1:8097";
const SECRET = process.env.STORE_ENROLMENT_SECRET ?? "electronix-dev-enrolment";
const EMP_CODE = process.env.TERMINAL_EMP_CODE ?? "E1042";
const PIN = process.env.TERMINAL_PIN ?? "3333";

const t = tally();
const browser = await launchChrome();

/** Ask the API as the terminal itself — the token the browser just enrolled. */
const asTerminal = (path) =>
  browser.evaluate(`(async () => {
    const token = localStorage.getItem("electronix.store.token");
    const r = await fetch(${JSON.stringify(BASE)} + ${JSON.stringify(path)},
      { headers: { authorization: "Bearer " + token } });
    return { status: r.status, body: await r.json() };
  })()`);

/**
 * The two geometry rules, checked on whatever screen is showing.
 *
 * `pageScrolls` is the one that caught the original fault: `Screen` was
 * `min-h-full`, a percentage against a parent with no definite height, so every
 * screen collapsed to its own content and anything taller than the viewport
 * scrolled the *page* instead of its own list. The admin catalog was an 8845 px
 * document inside a 987 px window.
 *
 * `backOutsideBar` is the other half. A `fixed` control sits over content and
 * padding only protects the end of a list, so the fix is structural: the bar is
 * a flex sibling, and back lives in it.
 */
const geometry = () =>
  browser.evaluate(`(() => {
    const bar = [...document.querySelectorAll("div")].find(
      (d) => d.className.includes("border-t") && d.className.includes("shrink-0"));
    const back = document.querySelector('[aria-label="Back"]');
    return {
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
      hasBar: !!bar,
      // A bar that does not reach the bottom edge means something else is
      // holding the column open, which is the collapse coming back.
      barAtBottom: bar
        ? Math.abs(bar.getBoundingClientRect().bottom - window.innerHeight) < 2
        : false,
      backOutsideBar: back !== null && bar !== null && !bar.contains(back),
      // Does the screen actually fill the space the shell gave it?
      //
      // This is the assertion that catches the original fault, and the page
      // scroll above is not: with the shell owning the viewport, a screen that
      // collapses does so *inside* the content region — the page stays exactly
      // one viewport tall and the bar stays at the bottom, while the screen
      // sits in a puddle at the top with justify-between spreading nothing.
      // Restoring min-h-full was checked against this file: every other
      // assertion here passed.
      fills: (() => {
        const main = document.querySelector("main");
        const screen = main?.firstElementChild;
        if (!main || !screen) return null;
        const room = main.getBoundingClientRect().height;
        const used = screen.getBoundingClientRect().height;
        return { room: Math.round(room), used: Math.round(used) };
      })(),
    };
  })()`);

async function checkGeometry(screen) {
  const g = await geometry();
  if (g.pageScrolls) t.bad(`${screen}: the page scrolls — a screen is taller than the shell`);
  else t.ok(`${screen}: the page does not scroll`);
  if (!g.hasBar || !g.barAtBottom) t.bad(`${screen}: no bottom bar at the bottom edge`);
  if (g.backOutsideBar) t.bad(`${screen}: back is floating outside the bar`);
  if (g.fills === null) {
    t.bad(`${screen}: no screen inside the shell's content region`);
  } else if (g.fills.used < g.fills.room - 2) {
    t.bad(
      `${screen}: the screen collapsed — ${g.fills.used}px used of ${g.fills.room}px`,
    );
  } else {
    t.ok(`${screen}: the screen fills its region (${g.fills.used}px)`);
  }
}

// ── 1. Enrol ────────────────────────────────────────────────────────────

t.step("1. the device enrols");
// A phone, not whatever window Chrome opened. The geometry checks below are
// about where controls land and how much room a screen is given, and a 600 px
// desktop window is not a shape any operator holds — it makes the bottom of
// every screen artificially crowded and reports faults no device would show.
await browser.send("Emulation.setDeviceMetricsOverride", {
  width: 412,
  height: 915,
  deviceScaleFactor: 2,
  mobile: true,
});
await browser.goto(BASE);

let body = await browser.text();
if (/Set up this device/i.test(body)) {
  const inputs = await browser.evaluate(
    `document.querySelectorAll("input").length`,
  );
  if (inputs < 3) t.bad(`the enrol form has ${inputs} inputs`);
  await browser.evaluate(`(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    const els = [...document.querySelectorAll("input")];
    setter.call(els[2], ${JSON.stringify(SECRET)});
    els[2].dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  await browser.clickText("Enrol this device");
  await sleep(1500);
  body = await browser.text();
}
if (/ELECTRONIX TOOL STORE/i.test(body)) t.ok("the terminal is enrolled and idle");
else t.bad(`not on the idle screen: ${trim(body)}`);

await checkGeometry("idle");

// ── 2. §3: the screen says what this crib actually is ───────────────────

t.step("2. the idle screen words itself from the devices table (§3)");
const status = await asTerminal("/api/v1/terminal/status");
if (status.status !== 200) {
  t.bad(`/terminal/status answered ${status.status}`);
} else {
  const { installed, online } = status.body.reader;
  const expected = !installed
    ? "Sign in with your employee number and PIN."
    : online
      ? "Put your finger on the door reader, then tap your name."
      : "The door reader has gone quiet — use your number instead.";
  const idle = await browser.text();

  if (idle.includes(expected)) {
    t.ok(`reader installed=${installed} online=${online}: the screen says so`);
  } else {
    t.bad(`reader installed=${installed} online=${online}, screen says: ${trim(idle)}`);
  }

  // The one that matters: a crib that never had a reader must never be told
  // to use one. Only one branch runs per pass — CI performs an ADMS handshake
  // before this — so this is the assertion that survives either way.
  if (!installed && /finger on the door reader/i.test(idle)) {
    t.bad("a crib with no reader is being told to use one");
  } else {
    t.ok("the screen never invents a reader");
  }
}

// ── 3. The shortage chips open the list they counted ────────────────────

t.step("3. a count that can be tapped");
const chip = await browser.evaluate(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find((e) => /tap to see/i.test(e.textContent || ""));
  if (!b) return null;
  const n = Number((b.textContent || "").match(/\\d+/)?.[0]);
  const level = /EMPTY/.test(b.textContent) ? "EMPTY" : "LOW";
  b.click();
  return { n, level };
})()`);

if (chip === null) {
  t.ok("nothing is short — no chip to tap");
} else {
  await sleep(1200);
  const listed = await browser.evaluate(`(() => {
    const wanted = ${JSON.stringify(chip.level)};
    const other = wanted === "LOW" ? "EMPTY" : "LOW";
    return {
      rows: document.querySelectorAll('[class*="rounded-xl"][class*="bg-slate-900"]').length,
      leaked: new RegExp(other).test(document.body.innerText),
      titled: /Low on stock|Empty bins/.test(document.body.innerText),
    };
  })()`);

  if (!listed.titled) t.bad("the chip did not open a shortage list");
  // The server's `low=true` means LOW *or* EMPTY, which is right for a stock
  // screen and wrong here: a chip counting seven must not open a list of nine.
  else if (listed.rows !== chip.n)
    t.bad(`the ${chip.level} chip counted ${chip.n} and listed ${listed.rows}`);
  else t.ok(`the ${chip.level} chip counted ${chip.n} and listed ${listed.rows}`);

  await checkGeometry("shortages");

  const backInBar = await browser.evaluate(`(() => {
    const bar = [...document.querySelectorAll("div")].find(
      (d) => d.className.includes("border-t") && d.className.includes("shrink-0"));
    const back = bar?.querySelector('[aria-label="Back"]');
    if (!back) return false;
    back.click();
    return true;
  })()`);
  if (backInBar) t.ok("back is in the bar, and it goes back");
  else t.bad("no back control inside the bottom bar");
  await sleep(900);
}

// ── 4. Sign in the way a crib with no reader has to ─────────────────────

t.step("4. manual sign-in (§10's fallback, and §3's only route on some cribs)");
await browser.clickText("enter my number");
await sleep(700);
await browser.evaluate(`(() => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value").set;
  const els = [...document.querySelectorAll("input")];
  setter.call(els[0], ${JSON.stringify(EMP_CODE)});
  els[0].dispatchEvent(new Event("input", { bubbles: true }));
  setter.call(els[1], ${JSON.stringify(PIN)});
  els[1].dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(300);
await browser.clickText("continue");
await sleep(1500);

body = await browser.text();
if (/Welcome/i.test(body)) t.ok("signed in without a punch");
else t.bad(`manual sign-in did not open a session: ${trim(body)}`);
await checkGeometry("direction");

// ── 5. Find something with stock in it ──────────────────────────────────

t.step("5. take something out");
const stock = await asTerminal("/api/v1/stock?limit=60");
const target = (stock.body ?? []).find((i) => Number(i.on_hand) > 20);
if (!target) {
  t.bad("no seeded item has enough stock to issue from");
  await browser.close();
  t.report();
  process.exit(1);
}
const before = Number(target.on_hand);

await browser.clickText("TAKE OUT");
await sleep(900);
await checkGeometry("item");

await browser.clickText("search");
await sleep(400);
await browser.evaluate(`(() => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, "value").set;
  const el = document.querySelector("input");
  setter.call(el, ${JSON.stringify(target.item_code)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(1200);
const picked = await browser.clickText(target.item_code);
if (!picked) t.bad(`search did not offer ${target.item_code}`);
await sleep(900);

// ── 6. The pad, which is where the money is ─────────────────────────────

t.step("6. the quantity pad");
const readPad = () =>
  browser.evaluate(`(() => {
    const m = document.body.innerText.match(/^\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$/m);
    return m ? m[1] : null;
  })()`);

await checkGeometry("quantity");

// Default 1 — what makes a single-insert issue two taps rather than five.
const defaulted = await browser.evaluate(
  `/\\b1\\b/.test(document.body.innerText)`,
);
if (defaulted) t.ok("the pad defaults to 1");

// …and the default must not become a prefix. This is the regression: on the
// build before this test, tapping 2 here produced 12 and the ledger agreed.
await browser.evaluate(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find((e) => (e.textContent || "").trim() === "2");
  if (b) b.click();
  return !!b;
})()`);
await sleep(400);
const afterTwo = await readPad();
if (afterTwo === "2") t.ok("tapping 2 on a pad showing 1 means 2");
else t.bad(`tapping 2 on a pad showing 1 gave ${afterTwo}`);

// After the first digit the pad appends normally: 2 then 5 is 25.
await browser.evaluate(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find((e) => (e.textContent || "").trim() === "5");
  if (b) b.click();
  return !!b;
})()`);
await sleep(400);
const afterFive = await readPad();
if (afterFive === "25") t.ok("the pad still appends after the first digit (25)");
else t.bad(`2 then 5 gave ${afterFive}`);

// Back to 2 for the transaction, so the assertion below is a small number.
await browser.evaluate(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find((e) => (e.textContent || "").trim() === "⌫");
  if (b) b.click();
  return !!b;
})()`);
await sleep(400);

// ── 7. Skip, confirm, and ask the server ────────────────────────────────

t.step("7. skip the optional step and confirm");
await browser.clickText("next");
await sleep(800);
await checkGeometry("optional");
await browser.clickText("skip");
await sleep(900);
await checkGeometry("confirm");
await browser.clickText("confirm");
await sleep(2000);

body = await browser.text();
if (/Now in system/i.test(body)) t.ok("the success screen came up");
else t.bad(`no success screen: ${trim(body)}`);

const after = await asTerminal(
  `/api/v1/items/lookup?barcode=${encodeURIComponent(target.item_code)}`,
);
const now = Number(after.body?.on_hand);
if (now === before - 2) {
  t.ok(`${target.item_code}: ${before} → ${now}, exactly what was typed`);
} else {
  t.bad(`${target.item_code}: ${before} → ${now}, expected ${before - 2}`);
}

await browser.close();
t.report();
