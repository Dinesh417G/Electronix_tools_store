// The operator's flow, driven through the actual terminal (CLAUDE.md §12).
//
// `tests/e2e.mjs` proves the API can do this. It cannot prove the terminal
// does, and until now nothing did: production had zero sessions and zero
// ledger rows written through the UI. Every screen in §12 was reachable only
// by a human with a phone, which meant in practice it was reachable by nobody.
//
// What this drives, as an operator would:
//
//   manual sign-in (the reader is not in the room) → TAKE OUT → find the item
//   → quantity → skip the optional step → confirm → the new on-hand is shown
//
// and then checks the ledger directly, because a screen that says "done" and a
// row that exists are different claims (§7).
//
// The timing target in §12 — scan to confirm under 8 seconds — is a human
// measurement and is not asserted here; what is asserted is that the path
// exists, that every step advances, and that the number that lands in the
// ledger is the number that was typed.
//
//   STORE_BASE=… STORE_ENROLMENT_SECRET=… DATABASE_URL=… node tests/terminal-flow.mjs

import postgres from "postgres";
import { launchChrome, sleep, tally, trim } from "./cdp.mjs";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SECRET = process.env.STORE_ENROLMENT_SECRET;
const EMP_CODE = process.env.TERMINAL_EMP_CODE ?? "E1042";
const PIN = process.env.TERMINAL_PIN ?? "3333";

if (!SECRET) {
  console.error("STORE_ENROLMENT_SECRET is required — the browser enrols as a terminal first");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — the ledger is checked directly");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, connect_timeout: 20 });
const t = tally();

const onHand = async (itemCode) => {
  const [row] = await sql`
    select s.on_hand::text as on_hand from item_stock s
      join items i on i.id = s.item_id where i.item_code = ${itemCode}`;
  return Number(row.on_hand);
};

const browser = await launchChrome({ port: 9355 });

try {
  t.step("0. an item with stock to take, and an operator who can take it");
  const [item] = await sql`
    select i.item_code, i.description, s.on_hand::text as on_hand
      from items i join item_stock s on s.item_id = i.id
     where i.active and not i.allow_negative and s.on_hand >= 5
     order by s.on_hand desc limit 1`;
  if (!item) throw new Error("seed a catalog with stock first");
  const [operator] = await sql`
    select id, full_name from operators where emp_code = ${EMP_CODE} and active`;
  if (!operator) throw new Error(`operator ${EMP_CODE} is missing — seed --demo-operators`);
  console.log(`  ${item.item_code}, ${item.on_hand} on hand; operator ${EMP_CODE}`);
  const before = await onHand(item.item_code);

  t.step("1. enrol this browser as a terminal");
  await browser.goto(BASE);
  if ((await browser.evaluate('document.querySelectorAll("input").length')) >= 2) {
    await browser.fill([['input[type="password"]', SECRET]]);
    if (await browser.clickText("Enrol this device")) t.ok("device enrolled");
    else t.bad("no 'Enrol this device' button");
    await sleep(2500);
  } else {
    t.ok("device already enrolled");
  }

  const idle = await browser.text();
  // Not the door-reader sentence any more. §3 listed a ZK terminal under
  // "physical setup this software assumes", and that assumption is wrong for a
  // crib that wants the tablet and nothing else — so the line under the button
  // now depends on whether a device has ever checked in. The sign-in button is
  // what identifies this screen in every configuration.
  if (/sign me in/i.test(idle)) t.ok("the idle screen is up");
  else t.bad("not the idle screen: " + trim(idle));

  // The reader is optional, and the screen has to tell the truth about the
  // crib it is standing in: never installed, installed and talking, installed
  // and gone quiet all need different sentences, and the first two need
  // opposite remedies from the third.
  const [device] = await sql`
    select count(*) > 0 as installed,
           max(last_seen_at) > now() - interval '15 minutes' as online
      from devices`;
  const expected = !device.installed
    ? /Fingerprint on your own phone/i
    : device.online
      ? /finger on the door reader/i
      : /door reader has gone quiet/i;
  if (expected.test(idle)) {
    t.ok(
      `the reader line matches the database: installed=${device.installed}, online=${device.online ?? false}`,
    );
  } else {
    t.bad(
      `reader line does not match installed=${device.installed} online=${device.online}: ` +
        trim(idle),
    );
  }
  // Whatever the state, the crib must never be told to use hardware it does
  // not have. This is the whole point of making it optional.
  if (!device.installed && /finger on the door reader/i.test(idle)) {
    t.bad("a crib with no reader was told to put a finger on one");
  } else {
    t.ok("no instruction to use hardware this crib does not have");
  }

  t.step("2. sign in without the reader (§10 — manual identity)");
  if (!(await browser.clickText("Reader not working"))) t.bad("no manual entry link");
  await sleep(900);
  await browser.fill([
    ['input:not([type="password"])', EMP_CODE],
    ['input[type="password"]', PIN],
  ]);
  // The PIN field is a text input masked in CSS (Terminal.tsx explains why), so
  // the password selector may not match it. Fall back to the second input.
  await browser.evaluate(`(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    const inputs = [...document.querySelectorAll("input")];
    if (inputs.length >= 2 && !inputs[1].value) {
      setter.call(inputs[1], ${JSON.stringify(PIN)});
      inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    }
    return true;
  })()`);
  // The button says Continue on this screen, not Sign in.
  await browser.clickText("Continue");
  await sleep(2500);

  const direction = await browser.text();
  if (/TAKE OUT/i.test(direction)) t.ok("signed in — the direction screen is up");
  else t.bad("no direction screen: " + trim(direction));

  t.step("3. TAKE OUT → find the item by searching (§12.4)");
  if (!(await browser.clickText("TAKE OUT"))) t.bad("no TAKE OUT button");
  await sleep(1200);

  // A headless Chrome has no camera, so the terminal opens on search — which is
  // §12.4's rule doing its job rather than a limitation of the test.
  await browser.clickText("Search instead");
  await sleep(600);
  await browser.fill([["input", item.item_code]]);
  await sleep(1500);
  if (await browser.clickText(item.item_code, "button, li, div[role='button']")) {
    t.ok("picked the item from search results");
  } else {
    t.bad("the item never appeared in search: " + trim(await browser.text()));
  }
  await sleep(1200);

  const card = await browser.text();
  if (card.includes(item.item_code)) t.ok("the item card shows the code");
  else t.bad("no item card: " + trim(card));

  t.step("4. quantity 2, skip the optional step, confirm");
  const typedQty = 2;
  // The numeric pad is buttons, not an input: tap "2" the way an operator does.
  if (!(await browser.clickText(String(typedQty)))) {
    t.bad("no numeric pad");
  }
  await sleep(500);
  await browser.clickText("Next");
  await sleep(800);
  // §12.6: skipping must never be slower than filling.
  await browser.clickText("Skip");
  await sleep(800);
  const confirmed = await browser.clickText("Confirm");
  if (!confirmed) t.bad("no CONFIRM button: " + trim(await browser.text()));
  await sleep(3000);

  const done = await browser.text();
  if (/on hand|now low|taken|done/i.test(done)) t.ok("the success screen came up");
  else t.bad("no success screen: " + trim(done));

  t.step("5. the ledger, not the screen (§7)");
  const after = await onHand(item.item_code);
  if (after === before - typedQty) {
    t.ok(`on_hand fell by exactly ${typedQty}: ${before} → ${after}`);
  } else {
    t.bad(`on_hand went ${before} → ${after}, expected ${before - typedQty}`);
  }

  const [row] = await sql`
    select l.delta_qty::text as delta_qty, l.txn_type, l.operator_id, l.session_id,
           s.manual_identity, s.identity_source, s.state
      from stock_ledger l
      join items i on i.id = l.item_id
      left join sessions s on s.id = l.session_id
     where i.item_code = ${item.item_code}
     order by l.id desc limit 1`;

  if (row && Number(row.delta_qty) === -typedQty) t.ok("one ISSUE row for exactly that quantity");
  else t.bad(`last ledger row is ${row?.delta_qty} ${row?.txn_type}`);

  if (row?.operator_id === operator.id) t.ok("attributed to the operator who signed in");
  else t.bad("the ledger row names somebody else");

  // §8: a typed PIN is the weakest of the three identities, and the row has to
  // say so or the reports quietly overstate what the door knows.
  if (row?.manual_identity === true && row?.identity_source === "PIN") {
    t.ok("the session records PIN identity, flagged manual (§8)");
  } else {
    t.bad(`session identity is ${row?.identity_source}, manual=${row?.manual_identity}`);
  }

  // §10: submitting closes the session, so a second transaction needs a new one.
  if (row?.state === "CLOSED") t.ok("the session closed on submit (§10)");
  else t.bad(`session state is ${row?.state}, expected CLOSED`);
} finally {
  await browser.close();
  await sql.end({ timeout: 5 });
}

t.report();
