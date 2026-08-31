// What the console does when it cannot get an answer — the two faults behind
// the screenshots of 2026-08-30.
//
// **1. A dead token was never noticed.** An operator token lasts 12 hours
// (§11). The console kept it in localStorage, kept drawing the admin screens,
// and answered every tap with the server's own words — *"token is not valid"* —
// in a red banner with no route back to the sign-in form. The token in that
// browser had expired more than fifteen hours earlier; the database confirmed
// no operator token had been issued in that session at all.
//
// **2. A failed request was drawn as an empty one.** Every panel did
// `.catch(() => setRows([]))`. Reports rendered *"Nothing went out in this
// period"* — a confident statement about the crib — from a request that had
// timed out. Stock, Alerts and Ledger did the same with no banner whatsoever.
// A storekeeper reading that concludes the shop consumed nothing all month,
// which is the most expensive sentence this console can print.
//
// Both are about the same thing: a screen must never turn "I could not ask"
// into "there is none".
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 \
//     STORE_ENROLMENT_SECRET=… node tests/admin-session.mjs

import postgres from "postgres";
import { launchChrome, sleep, tally, trim } from "./cdp.mjs";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SECRET = process.env.STORE_ENROLMENT_SECRET;
const EMP_CODE = process.env.ADMIN_EMP_CODE ?? "E9001";
const PIN = process.env.ADMIN_PIN ?? "1111";

if (!SECRET) {
  console.error("STORE_ENROLMENT_SECRET is required — the browser enrols first");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, connect_timeout: 20 });
const t = tally();
const browser = await launchChrome({ port: 9357 });

const ADMIN_TOKEN_KEY = "electronix.store.admin_token";

async function signIn() {
  await browser.goto(BASE, 3000);

  // Enrol this browser as a terminal if it has never been here.
  if ((await browser.text()).includes("Enrol this device")) {
    await browser.fill([['input[type="password"]', SECRET]]);
    await browser.clickText("Enrol this device");
    await sleep(2500);
  }

  // Bottom-right switcher → Admin.
  await browser.evaluate(`localStorage.setItem("electronix.store.mode", "admin")`);
  await browser.goto(BASE, 3000);

  await browser.fill([
    ['input[autocomplete="username"], input:not([type="password"])', EMP_CODE],
    ['input[type="password"]', PIN],
  ]);
  await browser.clickText("Sign in");
  await sleep(2500);
}

try {
  t.step("0. sign in to the console");
  const [admin] = await sql`
    select id, emp_code from operators
     where active and role = 'ADMIN' and emp_code = ${EMP_CODE} and pin_hash is not null`;
  if (!admin) {
    throw new Error(
      `no active ADMIN ${EMP_CODE} with a PIN — run: npm run seed -- --demo-operators`,
    );
  }

  await signIn();
  let screen = await browser.text();
  if (screen.includes("Catalog") && screen.includes("Setup")) {
    t.ok("the console is open");
  } else {
    t.bad("did not reach the console: " + trim(screen));
  }

  t.step("1. a token the server refuses sends you back to the sign-in form");
  // Exactly the state the screenshot was taken in: a token string that is no
  // longer live. Revoking the real one is the same thing from the API's side.
  await sql`
    update api_tokens set revoked_at = now()
     where operator_id = ${admin.id} and revoked_at is null`;

  // Reports, not Stock: the Stock, Alerts and Ledger tabs read through the
  // *tablet* token (`api`), which is still perfectly valid — only the panels
  // that go through `adminApi` carry the operator token this step just killed.
  await browser.clickText("Reports");
  await sleep(3000);
  screen = await browser.text();

  if (screen.includes("token is not valid")) {
    t.bad('the console still shows the raw "token is not valid" and stays put');
  } else {
    t.ok("the raw server message is not what the operator is left looking at");
  }

  if (/employee code/i.test(screen) || /sign in/i.test(screen)) {
    t.ok("it fell back to the sign-in form, which is the only thing that helps");
  } else {
    t.bad("no sign-in form after a refused token: " + trim(screen));
  }

  const stored = await browser.evaluate(
    `localStorage.getItem(${JSON.stringify(ADMIN_TOKEN_KEY)})`,
  );
  if (!stored) t.ok("and the dead token was dropped, so a reload does not repeat it");
  else t.bad("the refused token is still in localStorage");

  t.step("2. signing in again works, and the console comes back");
  await sql`
    update api_tokens set revoked_at = null
     where operator_id = ${admin.id} and revoked_at is not null and expires_at > now()`;
  await signIn();
  screen = await browser.text();
  if (screen.includes("Catalog") && screen.includes("Reports")) {
    t.ok("back in");
  } else {
    t.bad("could not sign in again: " + trim(screen));
  }

  t.step("3. a report that could not load does not claim nothing went out");
  await browser.clickText("Reports");
  await sleep(2000);

  // Make every API call fail the way a timeout does, from the page's own side.
  await browser.evaluate(`(() => {
    window.__realFetch = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/v1/reports/")) {
        return Promise.reject(new DOMException("timed out", "TimeoutError"));
      }
      return window.__realFetch(input, init);
    };
    return true;
  })()`);

  // Change the grouping so the panel refetches through the broken fetch.
  await browser.clickText("Item");
  await sleep(3000);
  screen = await browser.text();

  if (screen.includes("Nothing went out in this period")) {
    t.bad('a failed report still says "Nothing went out in this period"');
  } else {
    t.ok("the empty-report sentence is not shown for a request that failed");
  }

  if (/did not load|could not ask|try again/i.test(screen)) {
    t.ok("it says the screen could not ask, and offers to try again");
  } else {
    t.bad("no failure state on a failed report: " + trim(screen));
  }

  t.step("4. and once the network is back, Try again actually works");
  await browser.evaluate(`(() => { window.fetch = window.__realFetch; return true; })()`);
  await browser.clickText("Try again");
  await sleep(3000);
  screen = await browser.text();
  if (/did not load/i.test(screen)) {
    t.bad("still showing the failure after a successful retry");
  } else {
    t.ok("the panel recovered without a reload");
  }
} catch (err) {
  t.bad("threw: " + (err?.message ?? err));
} finally {
  await sql`
    update api_tokens set revoked_at = now()
     where kind = 'OPERATOR' and revoked_at is null and expires_at > now()`;
  await sql.end({ timeout: 5 });
  await browser.close();
}

t.report();
