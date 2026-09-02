// PUT IN, and the alert ladder it walks back down — M6 and M8's cloud half.
//
// Neither had a test on this side. `POST /api/v1/txn/receipt` had none at all:
// `e2e.mjs` drives an issue and a reversal, and stops there, so the direction
// the storekeeper uses to restock the crib was never once exercised against a
// database. And M8's gate — "issuing past the reorder level raises LOW, then
// EMPTY at zero; both appear on the dashboard and as a tablet banner" — was
// only ever checked as report arithmetic in `reports-db.mjs`, which is a
// different claim entirely.
//
// The ladder is the interesting part, because it is trigger-maintained
// (0003's `sync_stock_alert`) and the application only reads it. Walking an
// item OK → LOW → EMPTY → OK and asserting what `stock_alerts` holds at each
// rung is what proves the read model and the alert rows agree. A crib whose
// banner says EMPTY when the bin has forty inserts in it gets ignored, and
// then the real one gets ignored too.
//
// It leaves the item where it found it, by receipt rather than by deletion:
// §7 forbids removing a movement, and a test is not an exception to that.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/receipt-and-alerts.mjs

import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SN = "RECEIPT-DEVICE-1";
const TABLET = "receipt-tablet";

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
async function mint(kind, { tabletId = null, operatorId = null } = {}) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, operator_id, expires_at)
    values (${hash}, ${kind}, ${tabletId}, ${operatorId}, now() + interval '1 hour')`;
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
const fmt = (date) => date.toISOString().slice(0, 19).replace("T", " ");

const stock = async (itemId) => {
  const [row] = await sql`
    select on_hand::text as on_hand, alert_state from item_stock where item_id = ${itemId}`;
  return row;
};

const openAlert = async (itemId) => {
  const [row] = await sql`
    select level, acknowledged_at from stock_alerts
     where item_id = ${itemId} and resolved_at is null`;
  return row ?? null;
};

let index = 0;
async function session(operator, tabletToken) {
  // Offsets far apart: §9.1 deduplicates on a one-second device stamp, so two
  // punches from the same run must not land on the same second.
  const ts = new Date(Date.now() - ++index * 97_000);
  await call("/iclock/cdata?SN=" + SN + "&table=ATTLOG", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: operator.zk_user_id + "\t" + fmt(ts) + "\t0\t1\t\t\n",
  });
  // Scoped to this file's own device: the dedup key includes device_id, and
  // another test file using the same operator and spacing would otherwise be
  // matched here.
  const [row] = await sql`
    select s.id from sessions s
      join punches p on p.id = s.punch_id
      join devices d on d.id = p.device_id
     where d.serial_no = ${SN}
       and p.zk_user_id = ${operator.zk_user_id}
       and p.device_ts = ${new Date(fmt(ts) + "Z")}`;
  await call("/api/v1/sessions/" + row.id + "/claim", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({ tablet_id: TABLET }),
  });
  return row.id;
}

let item = null;

try {
  step("0. fixtures — an item this test owns outright");
  const [operator] = await sql`
    select id, zk_user_id from operators
     where active and zk_user_id is not null and role = 'OPERATOR' order by emp_code limit 1`;
  await sql`
    insert into devices (serial_no, name) values (${SN}, 'receipt test')
    on conflict (serial_no) do nothing`;
  await sql`
    insert into tablets (tablet_id, name) values (${TABLET}, 'receipt test')
    on conflict (tablet_id) do nothing`;
  const tabletToken = await mint("TABLET", { tabletId: TABLET });

  // Its own item, so the ladder below is not competing with whatever else the
  // suite has done to the catalog.
  const code = "TEST-ALERT-" + randomBytes(3).toString("hex").toUpperCase();
  const [created] = await sql`
    insert into items (item_code, description, uom, reorder_level)
    values (${code}, 'Alert ladder fixture', 'NOS', 5)
    returning id, item_code, reorder_level::text as reorder_level`;
  item = created;
  ok("created " + item.item_code + " at reorder level " + item.reorder_level);

  const fresh = await stock(item.id);
  if (fresh && fresh.on_hand === "0.000" && fresh.alert_state === "EMPTY") {
    ok("a new item starts EMPTY, not OK — a bin with nothing in it is not fine");
  } else {
    bad("a new item is " + JSON.stringify(fresh));
  }

  step("1. PUT IN — the direction nothing had ever tested");
  const s1 = await session(operator, tabletToken);
  const [reason] = await sql`
    select id, code from reason_codes where applies_to = 'RECEIPT' and active
     order by sort_order limit 1`;
  const receipt = await call("/api/v1/txn/receipt", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: s1,
      item_id: item.id,
      qty: "100",
      unit_cost: "42.50",
      reason_id: reason.id,
      client_txn_uuid: randomUUID(),
    }),
  });
  if (receipt.status === 200) ok("100 in, accepted");
  else bad("receipt answered " + receipt.status + " " + JSON.stringify(receipt.body));

  const [row] = await sql`
    select txn_type, delta_qty::text as delta_qty, unit_cost::text as unit_cost, reason_id
      from stock_ledger where session_id = ${s1}`;
  if (row?.txn_type === "RECEIPT") ok("the ledger row is a RECEIPT");
  else bad("txn_type is " + row?.txn_type);
  if (row?.delta_qty === "100.000") ok("delta is positive: +100 (§7's sign rule)");
  else bad("delta_qty is " + row?.delta_qty);
  if (row?.unit_cost === "42.50") ok("unit cost snapshotted at 42.50 — M6's gate");
  else bad("unit_cost is " + row?.unit_cost);
  if (row?.reason_id === reason.id) ok("filed under " + reason.code);
  else bad("reason_id is " + row?.reason_id);

  const stocked = await stock(item.id);
  if (stocked.on_hand === "100.000") ok("on_hand rose to 100");
  else bad("on_hand is " + stocked.on_hand);
  if (stocked.alert_state === "OK") ok("and the alert cleared to OK");
  else bad("alert_state is " + stocked.alert_state + " with 100 on hand");
  if ((await openAlert(item.id)) === null) ok("no open alert row is left behind");
  else bad("an alert is still open on a full bin");

  step("2. issuing past the reorder level raises LOW (M8)");
  const s2 = await session(operator, tabletToken);
  const toLow = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: s2, item_id: item.id, qty: "96", client_txn_uuid: randomUUID(),
    }),
  });
  if (toLow.status === 200) ok("96 out, leaving 4 against a reorder level of 5");
  else bad("issue answered " + toLow.status + " " + JSON.stringify(toLow.body));
  if (toLow.body?.crossed_threshold === true) {
    ok("the response says the threshold was crossed — the success screen's LOW notice");
  } else {
    bad("crossed_threshold was " + JSON.stringify(toLow.body?.crossed_threshold));
  }
  const low = await stock(item.id);
  if (low.alert_state === "LOW") ok("item_stock says LOW");
  else bad("alert_state is " + low.alert_state + " at 4 of 5");
  const lowAlert = await openAlert(item.id);
  if (lowAlert?.level === "LOW") ok("an open LOW alert row exists");
  else bad("open alert is " + JSON.stringify(lowAlert));

  step("3. it reaches the screens that are supposed to show it");
  const summary = await call("/api/v1/alerts/summary", { headers: bearer(tabletToken) });
  if (summary.status === 200 && Number(summary.body?.low ?? summary.body?.LOW ?? 0) >= 1) {
    ok("the tablet banner count includes it: " + JSON.stringify(summary.body));
  } else {
    bad("/alerts/summary answered " + summary.status + " " + JSON.stringify(summary.body));
  }
  const listed = await call("/api/v1/alerts", { headers: bearer(tabletToken) });
  if (listed.status === 200 && listed.text.includes(item.id)) ok("and the dashboard list names it");
  else bad("/alerts answered " + listed.status + " without the item");

  const lowStock = await call("/api/v1/stock?low=true", { headers: bearer(tabletToken) });
  if (lowStock.status === 200 && lowStock.text.includes(item.item_code)) {
    ok("/stock?low=true finds it too");
  } else {
    bad("/stock?low=true answered " + lowStock.status + " without " + item.item_code);
  }

  step("4. EMPTY at zero, and the LOW alert is resolved rather than duplicated");
  const s4 = await session(operator, tabletToken);
  const toEmpty = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: s4, item_id: item.id, qty: "4", client_txn_uuid: randomUUID(),
    }),
  });
  if (toEmpty.status === 200) ok("the last 4 go out");
  else bad("issue answered " + toEmpty.status + " " + JSON.stringify(toEmpty.body));
  const empty = await stock(item.id);
  if (empty.on_hand === "0.000" && empty.alert_state === "EMPTY") ok("0 on hand, state EMPTY");
  else bad("item_stock is " + JSON.stringify(empty));

  const open = await sql`
    select level from stock_alerts where item_id = ${item.id} and resolved_at is null`;
  if (open.length === 1 && open[0].level === "EMPTY") {
    ok("exactly one open alert, and it is the EMPTY one");
  } else {
    bad(open.length + " open alerts: " + JSON.stringify(open.map((a) => a.level)));
  }

  step("5. an empty bin refuses the next issue (§7)");
  const s5 = await session(operator, tabletToken);
  const past = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: s5, item_id: item.id, qty: "1", client_txn_uuid: randomUUID(),
    }),
  });
  if (past.status === 409 && past.body?.error === "INSUFFICIENT_STOCK") ok("409 INSUFFICIENT_STOCK");
  else bad("answered " + past.status + " " + JSON.stringify(past.body));

  step("6. restocking walks the ladder back down");
  const s6 = await session(operator, tabletToken);
  const back = await call("/api/v1/txn/receipt", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: s6, item_id: item.id, qty: "50", client_txn_uuid: randomUUID(),
    }),
  });
  if (back.status === 200) ok("50 back in");
  else bad("receipt answered " + back.status + " " + JSON.stringify(back.body));
  const restored = await stock(item.id);
  if (restored.alert_state === "OK") ok("alert_state back to OK");
  else bad("alert_state is " + restored.alert_state + " at 50 of a 5 reorder level");
  if ((await openAlert(item.id)) === null) ok("and no alert is left open");
  else bad("an alert survived the restock");

  step("7. the item reconciles, ladder and all (§7)");
  const [sums] = await sql`
    select s.on_hand::text as on_hand, sum(l.delta_qty)::text as ledger
      from item_stock s join stock_ledger l on l.item_id = s.item_id
     where s.item_id = ${item.id}
     group by s.on_hand`;
  if (sums && sums.on_hand === sums.ledger) ok("on_hand equals sum(delta_qty): " + sums.on_hand);
  else bad("on_hand " + sums?.on_hand + " vs ledger " + sums?.ledger);
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  // The item is this test's own, and its ledger rows are movements — §7 says a
  // movement is never deleted. Retire it instead, exactly as the console does.
  if (item) await sql`update items set active = false where id = ${item.id}`;
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
