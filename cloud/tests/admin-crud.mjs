// The catalog's write paths, and the alert acknowledgement — M7's own gate.
//
// §14's table lists twelve tests and none of them writes to the catalog.
// `route-smoke.mjs` asks `GET /api/v1/admin/items` and stops there;
// `endpoint-callers.mjs` proves POST, PUT, PATCH and DELETE are *wired* to a
// screen, which is a different claim from working. So the one endpoint M7 is
// gated on — "create item → print label → scan that printed label" — had its
// first step covered by nothing at all.
//
// Three of the assertions here are about triggers the route comments claim and
// nobody checks:
//
//   * `items_create_stock_row` gives a new item a stock row at zero, and
//     deliberately does *not* raise an alert for it. A catalog import that
//     hands the storekeeper 500 EMPTY alerts is a banner nobody reads again.
//   * `items_reevaluate_alert_on_reorder_change` makes a policy change surface
//     immediately instead of at the item's next movement, which for a slow
//     mover is months. That is a stock alert raised with **no ledger row**,
//     and this asserts the ledger stays untouched while it happens.
//   * `items_level_band_not_inverted` (0009) refuses a maximum below the
//     reorder level, and the route turns 23514 into a sentence.
//
// The quantities crossing as strings is also load-bearing rather than
// stylistic: `numeric(12,3)` through a JavaScript float is how a ledger that is
// supposed to add up stops adding up, and reorder_level feeds the alert
// evaluation directly. A number where a string belongs must be a 400.
//
// Everything it creates, it removes; everything it changes on a seeded row, it
// puts back. `stock_ledger` is append-only (§7), so this test never books a
// movement — the alert it raises comes from moving the threshold, not the
// stock, which is exactly the case with no other coverage.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/admin-crud.mjs

import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const sql = postgres(process.env.DATABASE_URL, { prepare: false, connect_timeout: 20 });

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (n) => console.log("\n" + n);

const minted = [];
async function mint(operatorId) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, operator_id, expires_at)
    values (${hash}, 'OPERATOR', ${operatorId}, now() + interval '1 hour')`;
  minted.push(hash);
  return token;
}

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, opts);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, text };
}

const bearer = (t) => ({ Authorization: "Bearer " + t, "Content-Type": "application/json" });

const tag = randomBytes(3).toString("hex").toUpperCase();
const code = (suffix) => `ZZ-CRUD-${tag}-${suffix}`;

/** A complete item body. PUT replaces the whole row, so every field is sent. */
const itemBody = (over = {}) => ({
  item_code: code("A"),
  description: "Crud test insert",
  uom: "NOS",
  iso_code: "CNMG120408",
  grade: "TN2000",
  manufacturer: "Testco",
  reorder_level: "10",
  allow_negative: false,
  ...over,
});

const createdItems = [];
const createdAlerts = [];
let levelSnapshot = null;

try {
  step("0. fixtures");
  const [admin] = await sql`
    select id, emp_code from operators where active and role = 'ADMIN' order by emp_code limit 1`;
  const [keeper] = await sql`
    select id, emp_code from operators where active and role = 'STOREKEEPER' order by emp_code limit 1`;
  const [operator] = await sql`
    select id, emp_code from operators where active and role = 'OPERATOR' order by emp_code limit 1`;
  if (!admin || !keeper || !operator) {
    bad("need an active ADMIN, STOREKEEPER and OPERATOR — run the seed first");
    throw new Error("fixtures");
  }
  const adminToken = await mint(admin.id);
  const keeperToken = await mint(keeper.id);
  const operatorToken = await mint(operator.id);
  ok(`admin ${admin.emp_code}, storekeeper ${keeper.emp_code}, operator ${operator.emp_code}`);

  step("1. POST /admin/items creates, and the trigger gives it a stock row");
  const created = await call("/api/v1/admin/items", {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify(itemBody()),
  });
  if (created.status === 201 && created.body?.id) ok("201 with an id");
  else bad("POST answered " + created.status + " " + JSON.stringify(created.body));
  const itemId = created.body?.id;
  if (!itemId) throw new Error("nothing to work with");
  createdItems.push(itemId);

  const [stockRow] = await sql`
    select on_hand::text as on_hand, alert_state from item_stock where item_id = ${itemId}`;
  if (stockRow?.on_hand === "0.000") ok("item_stock row exists at 0.000");
  else bad("item_stock row is " + JSON.stringify(stockRow));
  // evaluate_alert_level(0, …) is EMPTY, so the *state* is EMPTY at birth …
  if (stockRow?.alert_state === "EMPTY") ok("alert_state EMPTY — nothing in the bin yet");
  else bad("alert_state is " + stockRow?.alert_state);

  // … but items_after_insert deliberately does not call sync_stock_alert.
  // Creating a catalog entry is not a movement, and a bulk import that raises
  // 500 alerts is a banner nobody looks at twice.
  const [{ n: alertsForNew }] = await sql`
    select count(*)::int as n from stock_alerts where item_id = ${itemId}`;
  if (alertsForNew === 0) ok("no alert row raised by creating an item");
  else bad(alertsForNew + " alert row(s) raised by a catalog insert");

  step("2. the item code is unique, and the conflict says so");
  const dupe = await call("/api/v1/admin/items", {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify(itemBody()),
  });
  if (dupe.status === 409 && dupe.body?.error === "ITEM_CODE_TAKEN") ok("409 ITEM_CODE_TAKEN");
  else bad("duplicate code answered " + dupe.status + " " + JSON.stringify(dupe.body));

  step("3. quantities cross the wire as strings, and a number is refused");
  const numeric = await call("/api/v1/admin/items", {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ ...itemBody({ item_code: code("N") }), reorder_level: 10 }),
  });
  if (numeric.status === 400) ok("400 — a float is not a numeric(12,3)");
  else bad("a numeric reorder_level answered " + numeric.status);

  const badUom = await call("/api/v1/admin/items", {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ ...itemBody({ item_code: code("U") }), uom: "EACH" }),
  });
  if (badUom.status === 400) ok("400 — EACH is not one of the five units");
  else bad("an unknown uom answered " + badUom.status);

  step("4. PUT replaces the row");
  const put = await call("/api/v1/admin/items/" + itemId, {
    method: "PUT",
    headers: bearer(keeperToken),
    body: JSON.stringify(itemBody({
      description: "Crud test insert, renamed",
      bin_location: "A-01-9",
      uom: "BOX",
      reorder_level: "10",
      max_level: "50",
      reorder_qty: "25",
    })),
  });
  if (put.status === 200) ok("200");
  else bad("PUT answered " + put.status + " " + JSON.stringify(put.body));

  let [row] = await sql`
    select description, bin_location, uom,
           reorder_level::text as reorder_level, max_level::text as max_level,
           reorder_qty::text as reorder_qty
      from items where id = ${itemId}`;
  if (row.description === "Crud test insert, renamed" && row.bin_location === "A-01-9"
      && row.uom === "BOX") {
    ok("description, bin and uom all changed");
  } else {
    bad("row reads " + JSON.stringify(row));
  }

  const putDupe = await call("/api/v1/admin/items/" + itemId, {
    method: "PUT",
    headers: bearer(keeperToken),
    // Any other existing code will do; the seed has 90 of them.
    body: JSON.stringify(itemBody({ item_code: (await sql`
      select item_code from items where id <> ${itemId} order by item_code limit 1`)[0].item_code })),
  });
  if (putDupe.status === 409 && putDupe.body?.error === "ITEM_CODE_TAKEN") {
    ok("renaming onto another item's code is 409");
  } else {
    bad("PUT onto a taken code answered " + putDupe.status);
  }

  const putMissing = await call("/api/v1/admin/items/" + randomUUID(), {
    method: "PUT",
    headers: bearer(keeperToken),
    body: JSON.stringify(itemBody({ item_code: code("X") })),
  });
  if (putMissing.status === 404) ok("PUT on an unknown id is 404");
  else bad("PUT on an unknown id answered " + putMissing.status);

  step("5. PATCH is the stock band alone, and only what was sent");
  const patched = await call("/api/v1/admin/items/" + itemId, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({ reorder_level: "12" }),
  });
  if (patched.status === 200) ok("200");
  else bad("PATCH answered " + patched.status + " " + JSON.stringify(patched.body));

  [row] = await sql`
    select reorder_level::text as reorder_level, max_level::text as max_level,
           reorder_qty::text as reorder_qty, description
      from items where id = ${itemId}`;
  if (row.reorder_level === "12.000") ok("reorder_level moved to 12");
  else bad("reorder_level is " + row.reorder_level);
  // The distinction the route comment makes: omitted keeps, explicit null
  // clears. Without it there is no way to say "this bin has no ceiling" as
  // opposed to "leave the ceiling alone".
  if (row.max_level === "50.000" && row.reorder_qty === "25.000") {
    ok("the fields PATCH did not mention kept their values");
  } else {
    bad("max_level " + row.max_level + ", reorder_qty " + row.reorder_qty);
  }
  if (row.description === "Crud test insert, renamed") ok("PATCH left the catalog fields alone");
  else bad("description is now " + row.description);

  const cleared = await call("/api/v1/admin/items/" + itemId, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({ max_level: null }),
  });
  [row] = await sql`
    select reorder_level::text as reorder_level, max_level::text as max_level
      from items where id = ${itemId}`;
  if (cleared.status === 200 && row.max_level === null) ok("an explicit null clears the ceiling");
  else bad("max_level is " + row.max_level + " after sending null (" + cleared.status + ")");
  if (row.reorder_level === "12.000") ok("and left the reorder level where it was");
  else bad("reorder_level is " + row.reorder_level);

  const empty = await call("/api/v1/admin/items/" + itemId, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({}),
  });
  if (empty.status === 400) ok("an empty PATCH is 400, not a no-op 200");
  else bad("PATCH {} answered " + empty.status);

  step("6. the database refuses an inverted band, and the route says it in English");
  const inverted = await call("/api/v1/admin/items/" + itemId, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({ reorder_level: "12", max_level: "5" }),
  });
  if (inverted.status === 400) ok("400");
  else bad("an inverted band answered " + inverted.status + " " + JSON.stringify(inverted.body));
  const said = JSON.stringify(inverted.body ?? "");
  if (/maximum cannot be below/i.test(said)) ok("the message is a sentence, not a constraint name");
  else bad("the message reads " + said);

  step("7. a vendor barcode resolves to our item");
  const vendorCode = "VND-" + tag + "-0001";
  const barcode = await call(`/api/v1/admin/items/${itemId}/barcodes`, {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ code: vendorCode, kind: "VENDOR" }),
  });
  if (barcode.status === 201) ok("201");
  else bad("POST barcode answered " + barcode.status + " " + JSON.stringify(barcode.body));

  // The end of the wire: a barcode nobody can scan back is not an integration.
  const resolved = await call("/api/v1/items/lookup?barcode=" + encodeURIComponent(vendorCode), {
    headers: bearer(operatorToken),
  });
  if (resolved.status === 200 && resolved.body?.id === itemId) {
    ok("GET /items/lookup resolves it to the item we attached it to");
  } else {
    bad("lookup answered " + resolved.status + " " + JSON.stringify(resolved.body));
  }

  const takenBarcode = await call(`/api/v1/admin/items/${itemId}/barcodes`, {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ code: vendorCode }),
  });
  if (takenBarcode.status === 409 && takenBarcode.body?.error === "BARCODE_TAKEN") {
    ok("409 BARCODE_TAKEN — one code can never mean two items");
  } else {
    bad("a duplicate barcode answered " + takenBarcode.status);
  }
  if (String(takenBarcode.body?.message ?? "").includes(code("A"))) {
    ok("and the message names the item already holding it");
  } else {
    bad("the message is " + JSON.stringify(takenBarcode.body?.message));
  }

  const orphanBarcode = await call(`/api/v1/admin/items/${randomUUID()}/barcodes`, {
    method: "POST",
    headers: bearer(keeperToken),
    body: JSON.stringify({ code: "VND-" + tag + "-ORPHAN" }),
  });
  if (orphanBarcode.status === 404) ok("a barcode on an unknown item is 404");
  else bad("it answered " + orphanBarcode.status);

  step("8. moving the threshold raises an alert, with no movement in the ledger");
  const [victim] = await sql`
    select i.id, i.item_code, i.reorder_level::text as reorder_level,
           i.max_level::text as max_level, s.on_hand::text as on_hand
      from items i join item_stock s on s.item_id = i.id
     where i.active and s.alert_state = 'OK' and s.on_hand > 0
     order by i.item_code limit 1`;
  if (!victim) {
    bad("no seeded item sitting OK with stock — is the catalog seeded?");
    throw new Error("fixtures");
  }
  levelSnapshot = victim;
  const before = await sql`select id from stock_alerts where item_id = ${victim.id}`;
  const [{ n: ledgerBefore }] = await sql`
    select count(*)::int as n from stock_ledger where item_id = ${victim.id}`;

  // Above on_hand, so LOW rather than EMPTY: EMPTY is a quantity claim and
  // this changes no quantity.
  const raise = Math.ceil(Number(victim.on_hand)) + 5;
  const moved = await call("/api/v1/admin/items/" + victim.id, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({ reorder_level: String(raise), max_level: String(raise + 10) }),
  });
  if (moved.status === 200) ok(`${victim.item_code}: reorder level ${victim.reorder_level} → ${raise}`);
  else bad("PATCH answered " + moved.status + " " + JSON.stringify(moved.body));

  const [after] = await sql`select alert_state from item_stock where item_id = ${victim.id}`;
  if (after?.alert_state === "LOW") ok("alert_state OK → LOW without anything being issued");
  else bad("alert_state is " + after?.alert_state);

  const [{ n: ledgerAfter }] = await sql`
    select count(*)::int as n from stock_ledger where item_id = ${victim.id}`;
  if (ledgerAfter === ledgerBefore) ok("the ledger is untouched — §7 saw no movement, because there was none");
  else bad(ledgerAfter - ledgerBefore + " ledger row(s) appeared from a policy change");

  const opened = await sql`
    select id, level, acknowledged_at, resolved_at from stock_alerts
     where item_id = ${victim.id} and resolved_at is null`;
  const alert = opened[0];
  for (const a of opened) if (!before.some((b) => b.id === a.id)) createdAlerts.push(a.id);
  if (alert && alert.level === "LOW") ok("an open LOW alert row exists");
  else bad("open alerts for it: " + JSON.stringify(opened));

  step("9. acknowledging is not resolving");
  const acked = await call(`/api/v1/alerts/${alert.id}/ack`, {
    method: "POST",
    headers: bearer(keeperToken),
  });
  if (acked.status === 200) ok("200");
  else bad("ack answered " + acked.status + " " + JSON.stringify(acked.body));
  if (acked.body?.acknowledged_by === keeper.emp_code) ok("it records who read it: " + keeper.emp_code);
  else bad("acknowledged_by is " + JSON.stringify(acked.body?.acknowledged_by));

  const [ackedRow] = await sql`
    select acknowledged_at, acknowledged_by, resolved_at from stock_alerts where id = ${alert.id}`;
  if (ackedRow.acknowledged_at) ok("acknowledged_at is set");
  else bad("acknowledged_at is still null");
  if (ackedRow.acknowledged_by === keeper.id) ok("acknowledged_by is the operator behind the token");
  else bad("acknowledged_by is " + ackedRow.acknowledged_by);
  // The headline claim of the route: a shortage somebody has merely read about
  // is still a shortage.
  if (ackedRow.resolved_at === null) ok("resolved_at is still null — the shortage is real until stock crosses back");
  else bad("acknowledging resolved the alert");

  const listed = await call("/api/v1/alerts", { headers: bearer(keeperToken) });
  const stillListed = Array.isArray(listed.body)
    && listed.body.some((a) => a.id === alert.id && a.acknowledged_at);
  if (stillListed) ok("it is still on GET /alerts, now carrying its acknowledged_at");
  else bad("an acknowledged alert vanished from the dashboard");

  step("10. putting the threshold back resolves it, and a resolved alert cannot be acked");
  const restore = await call("/api/v1/admin/items/" + victim.id, {
    method: "PATCH",
    headers: bearer(keeperToken),
    body: JSON.stringify({
      reorder_level: victim.reorder_level,
      max_level: victim.max_level,
    }),
  });
  if (restore.status === 200) ok("reorder level restored to " + victim.reorder_level);
  else bad("restoring answered " + restore.status + " " + JSON.stringify(restore.body));

  const [restored] = await sql`select alert_state from item_stock where item_id = ${victim.id}`;
  if (restored?.alert_state === "OK") ok("alert_state LOW → OK");
  else bad("alert_state is " + restored?.alert_state);

  const [closed] = await sql`select resolved_at from stock_alerts where id = ${alert.id}`;
  if (closed.resolved_at) ok("the alert row closed itself");
  else bad("the alert is still open after the level came back");

  const ackClosed = await call(`/api/v1/alerts/${alert.id}/ack`, {
    method: "POST",
    headers: bearer(keeperToken),
  });
  if (ackClosed.status === 404) ok("acking a resolved alert is 404");
  else bad("it answered " + ackClosed.status);

  const ackUnknown = await call(`/api/v1/alerts/${randomUUID()}/ack`, {
    method: "POST",
    headers: bearer(keeperToken),
  });
  if (ackUnknown.status === 404) ok("acking an unknown alert is 404");
  else bad("it answered " + ackUnknown.status);

  step("11. DELETE retires — §7 needs the row to stay");
  const retired = await call("/api/v1/admin/items/" + itemId, {
    method: "DELETE",
    headers: bearer(adminToken),
  });
  if (retired.status === 204) ok("204");
  else bad("DELETE answered " + retired.status + " " + JSON.stringify(retired.body));

  [row] = await sql`select active from items where id = ${itemId}`;
  if (row && row.active === false) ok("the row survives, active = false");
  else bad("the item row is " + JSON.stringify(row));

  const listDefault = await call("/api/v1/admin/items?q=" + encodeURIComponent(code("A")), {
    headers: bearer(keeperToken),
  });
  const visible = Array.isArray(listDefault.body) && listDefault.body.some((i) => i.id === itemId);
  if (!visible) ok("it has left the catalog list");
  else bad("a retired item is still listed by default");

  const listRetired = await call(
    "/api/v1/admin/items?include_retired=true&q=" + encodeURIComponent(code("A")),
    { headers: bearer(keeperToken) },
  );
  const back = Array.isArray(listRetired.body) && listRetired.body.some((i) => i.id === itemId);
  if (back) ok("include_retired=true finds it again — it can come back");
  else bad("include_retired=true did not list it");

  const deleteMissing = await call("/api/v1/admin/items/" + randomUUID(), {
    method: "DELETE",
    headers: bearer(adminToken),
  });
  if (deleteMissing.status === 404) ok("DELETE on an unknown id is 404");
  else bad("it answered " + deleteMissing.status);

  step("12. an OPERATOR cannot edit the catalog");
  for (const [verb, path, body] of [
    ["POST", "/api/v1/admin/items", itemBody({ item_code: code("R") })],
    ["PUT", "/api/v1/admin/items/" + itemId, itemBody({ item_code: code("R") })],
    ["PATCH", "/api/v1/admin/items/" + itemId, { reorder_level: "1" }],
    ["DELETE", "/api/v1/admin/items/" + itemId, null],
    ["POST", `/api/v1/admin/items/${itemId}/barcodes`, { code: "VND-" + tag + "-NO" }],
  ]) {
    const refused = await call(path, {
      method: verb,
      headers: bearer(operatorToken),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (refused.status === 403) ok(`${verb} ${path.replace(itemId, "{id}")} → 403`);
    else bad(`${verb} ${path.replace(itemId, "{id}")} answered ${refused.status}`);
  }
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  // Put the seeded item's band back even if an assertion threw between the
  // change and the restore, or the next run starts from a catalog this test
  // quietly re-levelled.
  if (levelSnapshot) {
    await sql`
      update items
         set reorder_level = ${levelSnapshot.reorder_level},
             max_level = ${levelSnapshot.max_level}
       where id = ${levelSnapshot.id}`;
  }
  if (createdAlerts.length) {
    await sql`delete from stock_alerts where id = any(${createdAlerts}::uuid[])`;
  }
  if (createdItems.length) {
    // print_jobs and tool_serials both reference items with ON DELETE RESTRICT
    // on the serial side, so they go first. `stock_ledger` does too — which is
    // why this test never books a movement against an item it created.
    await sql`delete from print_jobs where item_id = any(${createdItems}::uuid[])`;
    await sql`delete from tool_serials where item_id = any(${createdItems}::uuid[])`;
    await sql`delete from items where id = any(${createdItems}::uuid[])`;
  }
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
