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

  // Steps 3 and 4 were written for Reports and fixed nine panels. Door was
  // written before `useLoadable` existed and was never moved onto it, so it
  // kept the identical defect for another day — the shape of the bug survives
  // a fix aimed at the screen that reported it, which is the whole reason this
  // step exists rather than a comment saying "Door does it too".
  //
  // What made it worse here than anywhere else: Door's empty state is a
  // *conclusion*. "No terminal has ever handshaked with this server" tells an
  // engineer the plant's outbound routing is wrong. On 2026-08-31 it was drawn
  // from a request that had timed out, against a deployment that had a device
  // and a punch.
  /* Catalog rows must stack, not run along one line.
   *
   * `globals.css` sets `.admin .tap { display: inline-flex }` so a control in a
   * dense console row is not 3.5rem tall. Two classes beat one, so any button
   * inside the console that stacks a title over a description loses to it and
   * lays the two side by side. It has now done that twice: the Setup menu once
   * read "PeopleWho can take stock out", and the catalog once read
   * "EM-20-4F-TIALN EMPTY 2l Eme... B..". The CSS carries `.admin .tap.block`
   * as the escape hatch, and it only works if the markup asks for it.
   *
   * No text assertion can see this — every word is present either way. The
   * geometry is the whole signal: a stacked pair has the title's bottom at or
   * above the description's top, a collapsed pair overlaps them vertically.
   */
  t.step("4b. a console row stacks on a phone and lays out as columns on a monitor");

  /* Two shapes, one markup (`components/row.tsx`), so this has to be measured
     at two widths. The narrow half is the original check and the reason this
     step exists: `.admin .tap` is `inline-flex`, which beats a one-class
     utility and lays a row's three stacked lines out side by side — the
     catalog once read "EM-20-4F-TIALN EMPTY 2l Eme… B..". The wide half is
     the newer contract: at `sm:` and up those same lines are *supposed* to be
     side by side, one per column, or the console is a phone on a monitor.

     Found by structure rather than by the classes that do it, because keying
     on `block` or on `sm:flex` would pass on any build that dropped both the
     class and the rows. */
  const measureRow = `(() => {
    const list = document.querySelector("div.divide-y");
    const rows = !list ? [] : [...list.querySelectorAll("button")];
    // The lines live either directly under the button, or under a single
    // wrapper it holds — both shapes are legitimate, so descend to whichever
    // actually carries them.
    const holderOf = (b) => {
      const direct = [...b.querySelectorAll(":scope > div")];
      if (direct.length >= 2) return b;
      if (direct.length === 1 && direct[0].querySelectorAll(":scope > div").length >= 2) {
        return direct[0];
      }
      return null;
    };
    const row = rows.map(holderOf).find(Boolean);
    if (!row) return { missing: true };
    const lines = [...row.querySelectorAll(":scope > div")]
      .map((d) => {
        const r = d.getBoundingClientRect();
        return {
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          text: (d.textContent || "").trim().slice(0, 28),
        };
      })
      // A cell held open but empty at this width is not a line of anything.
      .filter((l) => l.width > 0 && l.text !== "");
    return { lines };
  })()`;

  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 412, height: 915, deviceScaleFactor: 2, mobile: true,
  });
  await browser.clickText("Catalog");
  await sleep(2000);
  const narrow = await browser.evaluate(measureRow);

  if (narrow.missing) {
    t.bad("no catalog row found to measure at 412px");
  } else {
    const overlapping = narrow.lines.filter(
      (line, i) => i > 0 && line.top < narrow.lines[i - 1].bottom - 1,
    );
    if (narrow.lines.length >= 2 && overlapping.length === 0) {
      t.ok(`at 412px a catalog row stacks its ${narrow.lines.length} lines`);
    } else if (narrow.lines.length < 2) {
      t.bad(
        `at 412px only ${narrow.lines.length} line(s) survived — ${JSON.stringify(narrow.lines)}. ` +
          "The columns are leaking below their breakpoint: laid out side by side " +
          "at phone width the subtitle and meta cells squeeze to nothing.",
      );
    } else {
      t.bad(
        `at 412px a catalog row runs its lines together — ${JSON.stringify(narrow.lines)}. ` +
          "`.admin .tap` is inline-flex; the row needs the `block` class.",
      );
    }
  }

  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(1200);
  const wide = await browser.evaluate(measureRow);

  if (wide.missing) {
    t.bad("no catalog row found to measure at 1280px");
  } else {
    const sideBySide = wide.lines.filter(
      (line, i) => i > 0 && line.top < wide.lines[i - 1].bottom - 1,
    );
    if (wide.lines.length >= 2 && sideBySide.length > 0) {
      t.ok(`at 1280px the same row lays its ${wide.lines.length} lines out as columns`);
    } else {
      t.bad(
        `at 1280px a catalog row is still stacked — ${JSON.stringify(wide.lines)}. ` +
          "The console is a phone on a monitor; `Row`'s cells need their `sm:` widths.",
      );
    }
  }
  await browser.send("Emulation.clearDeviceMetricsOverride", {});
  await sleep(500);


  t.step("4c. a column header sorts the list, rather than decorating it");

  /* What this proves and what it does not. `list-paging.mjs` proves the
     *server* orders the whole table — that is where the ordering lives, and it
     has to be checked there, because this crib holds 90 items against a
     `limit=200` fetch, so every row is on screen and a client-side sort would
     look identical. What only a browser can show is the half in between: that
     the header renders as a control at this width, that tapping it moves the
     state, and that the state reaches the request and comes back rendered.
     That wiring is exactly where this project's defects live — built at both
     ends, connected at neither. */
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(800);

  const clickSort = (label) =>
    browser.evaluate(`(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.getAttribute("aria-label") === "Sort by ${label}");
      if (!b) return false;
      b.click();
      return true;
    })()`);

  // The first row's title, found the same way step 4b finds a row: by shape,
  // not by a class that a restyle would take away.
  const firstCode = `(() => {
    const list = document.querySelector("div.divide-y");
    if (!list) return null;
    for (const b of list.querySelectorAll("button")) {
      const direct = [...b.querySelectorAll(":scope > div")];
      const holder =
        direct.length >= 2
          ? b
          : direct.length === 1 && direct[0].querySelectorAll(":scope > div").length >= 2
            ? direct[0]
            : null;
      if (!holder) continue;
      const first = holder.querySelector(":scope > div");
      return (first?.textContent || "").trim().split(/\s+/)[0] || null;
    }
    return null;
  })()`;

  const [{ lowest, highest }] = await sql`
    select min(item_code) as lowest, max(item_code) as highest from items where active`;

  if (await clickSort("Item")) {
    t.ok("the Item column is a control, not a label");
    await sleep(1500);
    const asc = await browser.evaluate(firstCode);
    if (asc === lowest) t.ok(`tapping it sorts by code: ${asc} is first`);
    else t.bad(`after tapping Item the first row is ${asc}, expected ${lowest}`);

    await clickSort("Item");
    await sleep(1500);
    const desc = await browser.evaluate(firstCode);
    if (desc === highest) t.ok(`tapping again reverses it: ${desc} is first`);
    else t.bad(`after a second tap the first row is ${desc}, expected ${highest}`);
  } else {
    t.bad("no sortable Item header on the catalog — the column is still a label");
  }

  t.step("4d. the header's columns line up with the rows they label");

  /* Reported by the owner as "not in alignment", from a screenshot of Alerts:
     Band and On hand landed at a different x on almost every row, and at a
     third one in the header.
   *
   * The cause was that a row's controls were laid out at whatever width they
   * happened to measure. An acknowledged alert offers one button where an
   * unacknowledged one offers two, so the flexible description cell absorbed a
   * different remainder on each row — and the header, which reserved no lane
   * at all, lined up with neither. The catalog had the same fault twice over:
   * its rows carry a selection box on the left and a Serials button on the
   * right, and the header declared neither.
   *
   * Measured, not eyeballed, and on Alerts specifically because it is the list
   * whose rows genuinely differ from one another. Every row must put its cells
   * at the same x, and those must be the header's. */
  await browser.send("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await browser.clickText("Alerts");
  await sleep(2500);

  const columns = await browser.evaluate(`(() => {
    const header = [...document.querySelectorAll("div")].find(
      (d) => d.className.includes("uppercase") && d.className.includes("sm:flex"));
    if (!header) return { missing: "header" };
    const left = (el) => Math.round(el.getBoundingClientRect().left);
    // The header's labelled columns, ignoring the gutters it holds open for
    // controls — those carry no text to line anything up with.
    const heads = [...header.children]
      .filter((c) => (c.textContent || "").trim() !== "")
      .map(left);

    const rows = [...document.querySelectorAll(".group")].slice(0, 8).map((g) => {
      const inner = g.firstElementChild;
      const wrap = [...inner.children].find((c) => c.className.includes("min-w-0"));
      const text = wrap.className.includes("sm:flex") ? wrap : wrap.firstElementChild;
      const value = [...inner.children].find((c) => c.className.includes("text-right"));
      return {
        cells: [...text.children].map(left).concat(value ? [left(value)] : []),
        acknowledged: /acknowledged/.test(g.textContent || ""),
      };
    });
    return { heads, rows };
  })()`);

  if (columns.missing || (columns.rows ?? []).length === 0) {
    t.bad("could not measure the alert table: " + JSON.stringify(columns));
  } else {
    const shapes = new Set(columns.rows.map((r) => r.cells.join(",")));
    if (shapes.size === 1) {
      t.ok(`all ${columns.rows.length} alert rows put their cells at the same x`);
    } else {
      t.bad(`alert rows disagree on where their columns are: ${[...shapes].join(" / ")}`);
    }

    // The rows agreeing with each other is half of it; they have to agree with
    // the labels above them.
    const row = columns.rows[0].cells;
    const lined = columns.heads.every((x, i) => Math.abs(x - row[i]) <= 1);
    if (lined) t.ok(`and with the header: ${columns.heads.join(", ")}`);
    else t.bad(`header at ${columns.heads.join(", ")}, rows at ${row.join(", ")}`);

    // The case from the screenshot: a row with fewer buttons than its
    // neighbours. Without one, every row has the same controls and the fault
    // cannot appear — so say so rather than passing quietly.
    if (columns.rows.some((r) => r.acknowledged) && columns.rows.some((r) => !r.acknowledged)) {
      t.ok("measured across acknowledged and unacknowledged rows");
    } else {
      console.log("  note  every alert row carries the same controls here");
    }
  }

  await browser.send("Emulation.clearDeviceMetricsOverride", {});
  await sleep(500);

  t.step("5. a door that could not be asked does not report a door that never spoke");
  await browser.clickText("Setup");
  await sleep(1500);
  await browser.clickText("Door");
  await sleep(2500);
  screen = await browser.text();
  if (/Terminals|Recent punches/i.test(screen)) {
    t.ok("the Door screen loads when the server answers");
  } else {
    t.bad("could not reach the Door screen: " + trim(screen));
  }

  await browser.evaluate(`(() => {
    window.__realFetch = window.__realFetch ?? window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("/api/v1/admin/devices")) {
        return Promise.reject(new DOMException("timed out", "TimeoutError"));
      }
      return window.__realFetch(input, init);
    };
    return true;
  })()`);

  await browser.clickText("Refresh");
  await sleep(3000);
  screen = await browser.text();

  if (screen.includes("No terminal has ever handshaked")) {
    t.bad("a failed request still claims no terminal has ever handshaked");
  } else {
    t.ok("the never-handshaked sentence is not shown for a request that failed");
  }

  if (/did not load|could not ask|try again/i.test(screen)) {
    t.ok("it says the screen could not ask, and offers to try again");
  } else {
    t.bad("no failure state on a failed door read: " + trim(screen));
  }

  t.step("6. and the door screen comes back on retry, rather than staying stuck");
  await browser.evaluate(`(() => { window.fetch = window.__realFetch; return true; })()`);
  await browser.clickText("Try again");
  await sleep(3000);
  screen = await browser.text();
  if (/did not load/i.test(screen)) {
    t.bad("the Door screen stayed in its failure state after a successful retry");
  } else if (/Terminals|Recent punches/i.test(screen)) {
    t.ok("it recovered without a reload");
  } else {
    t.bad("unexpected screen after retry: " + trim(screen));
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
