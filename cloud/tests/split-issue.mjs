// One item, several machines, one confirm — §11's split issue.
//
// §11 describes a second body shape for POST /api/v1/txn/issue:
//
//   { session_id, item_id, reason_id?, note?, splits: [{ machine_id, qty }] }
//
// It writes one ledger row per machine inside **one** transaction, so §7's
// negative-stock guard applies to the *total*: an operator who asks for more
// than the bin holds gets nothing written, rather than the first two machines
// served and the third refused. That claim is why this file exists — nothing
// in the suite touched the split path at all, and a half-written batch is the
// kind of §7 damage that cannot be deleted afterwards, only reversed.
//
// It also drives §12's outbox against the split form: a batch whose
// acknowledgement was lost is retried with the same client_txn_uuids, by which
// time the session has closed on submit (§10). Answering that with 410 would
// send the operator to key in rows that are already in the ledger — the
// duplicate the outbox exists to prevent.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/split-issue.mjs

import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SN = "SPLIT-DEVICE-1";
const TABLET = "split-tablet";

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
  return { status: res.status, body };
}

const bearer = (t) => ({ Authorization: "Bearer " + t, "Content-Type": "application/json" });

const onHand = async (itemId) => {
  const [row] = await sql`select on_hand from item_stock where item_id = ${itemId}`;
  return Number(row.on_hand);
};

const rowsFor = async (sessionId) => sql`
  select id, delta_qty::text as delta_qty, machine_id, client_txn_uuid
    from stock_ledger where session_id = ${sessionId} order by id`;

const stamp = (offsetSeconds) =>
  new Date(Date.now() - offsetSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");

async function openSession(operator, tabletToken, offsetSeconds) {
  const line = operator.zk_user_id + "\t" + stamp(offsetSeconds) + "\t0\t1\t\t\n";
  await call("/iclock/cdata?SN=" + SN + "&table=ATTLOG", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: line,
  });
  const cards = await call("/api/v1/sessions/unclaimed", { headers: bearer(tabletToken) });
  const list = Array.isArray(cards.body) ? cards.body : (cards.body?.sessions ?? []);
  const card = list.find((c) => c.operator_id === operator.id) ?? list[0];
  const id = card?.session_id ?? card?.id;
  await call("/api/v1/sessions/" + id + "/claim", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({ tablet_id: TABLET }),
  });
  return id;
}

try {
  step("0. fixtures");
  const [operator] = await sql`
    select id, zk_user_id from operators
     where active and zk_user_id is not null and role = 'OPERATOR' limit 1`;
  const machines = await sql`select id, code from machines where active order by code limit 3`;
  const [item] = await sql`
    select i.id, i.item_code, s.on_hand::text as on_hand
      from items i join item_stock s on s.item_id = i.id
     where i.active and not i.allow_negative and s.on_hand >= 20
     order by i.item_code limit 1`;
  if (!operator || machines.length < 3 || !item) {
    bad("fixtures missing — needs a seeded catalog with machines and stock");
    throw new Error("fixtures");
  }
  await sql`
    insert into devices (serial_no, name) values (${SN}, 'split test')
    on conflict (serial_no) do nothing`;
  await sql`
    insert into tablets (tablet_id, name) values (${TABLET}, 'split test')
    on conflict (tablet_id) do nothing`;
  const tabletToken = await mint("TABLET", { tabletId: TABLET });
  ok("item " + item.item_code + " at " + item.on_hand + ", " + machines.length + " machines");

  step("1. one item, two machines, one confirm");
  const before = await onHand(item.id);
  const session = await openSession(operator, tabletToken, 1);
  const issued = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: session,
      item_id: item.id,
      splits: [
        { machine_id: machines[0].id, qty: "2" },
        { machine_id: machines[1].id, qty: "3" },
      ],
    }),
  });
  if (issued.status === 200) ok("split issue accepted");
  else bad("split issue answered " + issued.status + ": " + JSON.stringify(issued.body));

  const written = await rowsFor(session);
  if (written.length === 2) ok("two ledger rows, one per machine (§7: one movement, one row)");
  else bad(written.length + " ledger rows for a 2-way split");

  const byMachine = new Map(written.map((r) => [r.machine_id, r.delta_qty]));
  if (byMachine.get(machines[0].id) === "-2.000") ok(machines[0].code + " charged -2");
  else bad(machines[0].code + " got " + byMachine.get(machines[0].id) + ", expected -2.000");
  if (byMachine.get(machines[1].id) === "-3.000") ok(machines[1].code + " charged -3");
  else bad(machines[1].code + " got " + byMachine.get(machines[1].id) + ", expected -3.000");

  const after = await onHand(item.id);
  if (after === before - 5) ok("on_hand fell by the total: " + before + " → " + after);
  else bad("on_hand " + before + " → " + after + ", expected " + (before - 5));

  if (Array.isArray(issued.body?.ledger_ids) && issued.body.ledger_ids.length === 2) {
    ok("the response names both rows, so the success screen can say how many");
  } else {
    bad("ledger_ids was " + JSON.stringify(issued.body?.ledger_ids));
  }

  step("2. §7's guard applies to the total, not row by row");
  const stock = await onHand(item.id);
  const session2 = await openSession(operator, tabletToken, 2);
  const half = Math.floor(stock / 2);
  const past = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: session2,
      item_id: item.id,
      // Each split is affordable on its own. Together they are not.
      splits: [
        { machine_id: machines[0].id, qty: String(half) },
        { machine_id: machines[1].id, qty: String(half) },
        { machine_id: machines[2].id, qty: String(stock) },
      ],
    }),
  });
  if (past.status === 409 && past.body?.error === "INSUFFICIENT_STOCK") {
    ok("409 INSUFFICIENT_STOCK on the total");
  } else {
    bad("answered " + past.status + " " + JSON.stringify(past.body) + ", expected 409 INSUFFICIENT_STOCK");
  }
  const leftovers = await rowsFor(session2);
  if (leftovers.length === 0) ok("nothing was written — not even the affordable rows");
  else bad(leftovers.length + " rows survived a refused batch, and §7 cannot delete them");
  const stillThere = await onHand(item.id);
  if (stillThere === stock) ok("on_hand unmoved by the refused batch");
  else bad("on_hand moved to " + stillThere + " on a refused batch");

  step("3. §12: the batch whose acknowledgement was lost");
  const session3 = await openSession(operator, tabletToken, 3);
  const body3 = {
    session_id: session3,
    item_id: item.id,
    splits: [
      { machine_id: machines[0].id, qty: "1", client_txn_uuid: randomUUID() },
      { machine_id: machines[1].id, qty: "1", client_txn_uuid: randomUUID() },
    ],
  };
  const beforeReplay = await onHand(item.id);
  const first = await call("/api/v1/txn/issue", {
    method: "POST", headers: bearer(tabletToken), body: JSON.stringify(body3),
  });
  const retry = await call("/api/v1/txn/issue", {
    method: "POST", headers: bearer(tabletToken), body: JSON.stringify(body3),
  });
  if (first.status === 200) ok("the first attempt committed");
  else bad("first attempt answered " + first.status + ": " + JSON.stringify(first.body));
  if (retry.status === 200) {
    ok("the retry is answered, not refused for a session that closed on submit");
  } else {
    bad("retry answered " + retry.status + " " + JSON.stringify(retry.body) +
        " — §12: the tablet reports that to the operator, who then keys in a real duplicate");
  }
  if (JSON.stringify(retry.body?.ledger_ids) === JSON.stringify(first.body?.ledger_ids)) {
    ok("the retry names the same rows");
  } else {
    bad("retry named " + JSON.stringify(retry.body?.ledger_ids) +
        ", first named " + JSON.stringify(first.body?.ledger_ids));
  }
  const replayRows = await rowsFor(session3);
  if (replayRows.length === 2) ok("still two rows after the retry, not four");
  else bad(replayRows.length + " rows after a retried batch");
  const afterReplay = await onHand(item.id);
  if (afterReplay === beforeReplay - 2) ok("stock moved once, for both attempts");
  else bad("on_hand " + beforeReplay + " → " + afterReplay + ", expected " + (beforeReplay - 2));

  step("4. shapes the tablet must not get away with");
  const session4 = await openSession(operator, tabletToken, 4);
  const zero = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: session4,
      item_id: item.id,
      splits: [{ machine_id: machines[0].id, qty: "0" }],
    }),
  });
  if (zero.status === 400) ok("a zero split is 400, not a zero-delta ledger row");
  else bad("a zero split answered " + zero.status + " " + JSON.stringify(zero.body));

  const many = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({
      session_id: session4,
      item_id: item.id,
      splits: Array.from({ length: 21 }, () => ({ machine_id: machines[0].id, qty: "1" })),
    }),
  });
  if (many.status === 400) ok("21 splits is 400 — the cap is enforced");
  else bad("21 splits answered " + many.status);

  step("5. every split row still reconciles (§7)");
  const [drift] = await sql`
    select count(*)::int as n
      from item_stock s
      join (select item_id, sum(delta_qty) as total from stock_ledger group by item_id) l
        on l.item_id = s.item_id
     where s.on_hand <> l.total`;
  if (drift.n === 0) ok("sum(delta_qty) equals on_hand for every item");
  else bad(drift.n + " items drifted");
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
