// End-to-end against a real database — CLAUDE.md M4's acceptance gate, and the
// test §14 names as "the first cloud test worth writing".
//
// Until this existed, the cloud implementation had no test that touched a
// database at all: the ledger service, the session machine, the ADMS handler
// and the report queries were covered only by the Rust suite testing the
// *other* implementation of the same rules. The shared migrations meant the §7
// trigger and the negative-stock guard were the same objects on both sides,
// which is what made that survivable — but nothing proved the TypeScript half
// called them correctly.
//
// What it drives, in order:
//
//   1. ADMS handshake                        §9
//   2. punch, then the identical batch again §9.1 — exactly one punch row
//   3. claim, then a second tablet claiming  §10 — 409
//   4. items/lookup                          §11 — budget 100 ms
//   5. issue, and on_hand falls by that much §7
//   6. an issue past zero                    §7  — 409 INSUFFICIENT_STOCK
//   6b. a quantity past numeric(12,3)      §11 — 400, not an unmapped 500
//   7. reverse, and on_hand comes back       §7
//   8. submit after close                    §10 — 410
//   9. reconcile every item                  §7  — sum(delta_qty) == on_hand
//  10. UPDATE on stock_ledger                §7  — refused by the trigger
//
// Assumes a migrated, seeded database and a running server:
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100  node tests/e2e.mjs
//
// It talks to the database directly only to mint its own tokens (enrolment
// needs a secret this test has no business knowing) and to read back what the
// API claims to have written. Every assertion about behaviour goes through HTTP.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SN = "E2E-DEVICE-1";
const TABLET = "e2e-tablet";
const TABLET_B = "e2e-tablet-second";

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
  // Same scheme as src/lib/auth.ts: 32 random bytes base64url, stored as its
  // sha256. A token is 256 bits of randomness, so a fast hash is right for it.
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, operator_id, expires_at)
    values (${hash}, ${kind}, ${tabletId}, ${operatorId}, now() + interval '1 hour')`;
  minted.push(hash);
  return token;
}

async function call(path, opts = {}) {
  const started = Date.now();
  const res = await fetch(BASE + path, opts);
  const ms = Date.now() - started;
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, ms };
}

const bearer = (t) => ({ Authorization: "Bearer " + t, "Content-Type": "application/json" });
const onHand = async (itemId) => {
  const [row] = await sql`select on_hand from item_stock where item_id = ${itemId}`;
  return Number(row.on_hand);
};

// A punch carries a device clock, and §9.3 says never to trust it — but two
// punches one second apart must still be two rows, so each run gets its own.
const stamp = (offsetSeconds) =>
  new Date(Date.now() - offsetSeconds * 1000).toISOString().slice(0, 19).replace("T", " ");

async function openSession(operator, tabletToken, tabletId, offsetSeconds) {
  const ts = stamp(offsetSeconds);
  const line = operator.zk_user_id + "\t" + ts + "\t0\t1\t\t\n";
  const push = () => call("/iclock/cdata?SN=" + SN + "&table=ATTLOG", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: line,
  });
  const first = await push();
  const cards = await call("/api/v1/sessions/unclaimed", { headers: bearer(tabletToken) });
  const list = Array.isArray(cards.body) ? cards.body : (cards.body?.sessions ?? []);
  const card = list.find((c) => c.operator_id === operator.id) ?? list[0];
  const id = card?.session_id ?? card?.id;
  const claim = await call("/api/v1/sessions/" + id + "/claim", {
    method: "POST",
    headers: bearer(tabletToken),
    body: JSON.stringify({ tablet_id: tabletId }),
  });
  return { id, push, first, claim, cards: list };
}

try {
  step("0. fixtures");
  const [operator] = await sql`
    select id, emp_code, zk_user_id from operators
     where active and zk_user_id is not null and role = 'OPERATOR' limit 1`;
  const [admin] = await sql`
    select id from operators where active and role = 'ADMIN' limit 1`;
  if (!operator || !admin) throw new Error("seed an OPERATOR and an ADMIN first");
  const [item] = await sql`
    select i.id, i.item_code, s.on_hand from items i
      join item_stock s on s.item_id = i.id
     where i.active and not i.allow_negative and s.on_hand >= 2
     order by s.on_hand desc limit 1`;
  if (!item) throw new Error("seed a catalog first");
  console.log("  operator " + operator.emp_code + " (zk " + operator.zk_user_id + ")");
  console.log("  item     " + item.item_code + ", on_hand " + item.on_hand);

  for (const t of [TABLET, TABLET_B]) {
    await sql`
      insert into tablets (tablet_id, name) values (${t}, 'e2e')
      on conflict (tablet_id) do update set active = true`;
  }
  const tabletTok = await mint("TABLET", { tabletId: TABLET });
  const tabletBTok = await mint("TABLET", { tabletId: TABLET_B });
  const adminTok = await mint("OPERATOR", { operatorId: admin.id });

  step("1. ADMS handshake (§9)");
  const hs = await call("/iclock/cdata?SN=" + SN + "&options=all&pushver=2.4.1");
  if (hs.status === 200 && String(hs.body).startsWith("GET OPTION FROM: " + SN)) {
    ok("handshake answered the option block in " + hs.ms + " ms");
  } else {
    bad("handshake " + hs.status + " " + JSON.stringify(hs.body).slice(0, 120));
  }

  step("2. punch and its retry (§9.1 — the device retries on any non-OK)");
  const countPunches = async () => {
    const [{ n }] = await sql`
      select count(*)::int as n from punches p join devices d on d.id = p.device_id
       where d.serial_no = ${SN} and p.zk_user_id = ${String(operator.zk_user_id)}`;
    return n;
  };
  const before = await countPunches();
  const session = await openSession(operator, tabletTok, TABLET, 5);
  const retry = await session.push();
  for (const [label, r] of [["first push", session.first], ["retry", retry]]) {
    if (String(r.body).trim() === "OK: 1") ok(label + ' acknowledged "OK: 1" in ' + r.ms + " ms");
    else bad(label + " -> " + JSON.stringify(r.body).slice(0, 120));
  }
  const added = (await countPunches()) - before;
  if (added === 1) ok("one punch row from two identical batches");
  else bad(added + " punch rows added — dedup is broken");

  step("3. claim, and a second tablet refused (§10)");
  if (session.claim.status < 300) ok("claimed " + session.id);
  else bad("claim -> " + session.claim.status + " " + JSON.stringify(session.claim.body));
  const steal = await call("/api/v1/sessions/" + session.id + "/claim", {
    method: "POST",
    headers: bearer(tabletBTok),
    body: JSON.stringify({ tablet_id: TABLET_B }),
  });
  if (steal.status === 409) ok("second tablet refused with 409");
  else bad("second claim -> " + steal.status + ", §11 says 409");

  step("4. lookup (§11 — the budget is 100 ms)");
  const lookup = await call(
    "/api/v1/items/lookup?barcode=" + encodeURIComponent(item.item_code),
    { headers: bearer(tabletTok) },
  );
  const found = lookup.body?.item?.id ?? lookup.body?.id;
  if (lookup.status === 200 && found === item.id) ok("resolved " + item.item_code + " in " + lookup.ms + " ms");
  else bad("lookup -> " + lookup.status + " " + JSON.stringify(lookup.body).slice(0, 120));

  step("5. issue (§7 — one ledger row, on_hand follows)");
  const opening = Number(item.on_hand);
  const issue = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletTok),
    body: JSON.stringify({
      session_id: session.id,
      item_id: item.id,
      qty: "2",
      client_txn_uuid: randomUUID(),
    }),
  });
  if (issue.status < 300) ok("issue accepted (" + issue.status + ")");
  else bad("issue -> " + issue.status + " " + JSON.stringify(issue.body).slice(0, 200));
  const ledgerId = issue.body?.ledger_id ?? issue.body?.ledger_ids?.[0];
  const afterIssue = await onHand(item.id);
  if (afterIssue === opening - 2) ok("on_hand " + opening + " -> " + afterIssue);
  else bad("on_hand " + afterIssue + ", expected " + (opening - 2));

  step("6. issue past zero (§7 — refused, not silently allowed)");
  // A fresh session: §10 closes one on submit, so the session that carried the
  // issue above is legitimately gone. Reusing it would test 410, not the guard.
  const overdrawSession = await openSession(operator, tabletTok, TABLET, 4);
  const overdraw = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletTok),
    body: JSON.stringify({
      session_id: overdrawSession.id,
      item_id: item.id,
      qty: String(afterIssue + 1000),
      client_txn_uuid: randomUUID(),
    }),
  });
  if (overdraw.status === 409) ok("409 " + (overdraw.body?.error ?? "") + " — the guard held");
  else bad("overdraw -> " + overdraw.status + ", §11 says 409");
  const afterOverdraw = await onHand(item.id);
  if (afterOverdraw === afterIssue) ok("a refused issue moved no stock");
  else bad("on_hand changed on a refused issue: " + afterIssue + " -> " + afterOverdraw);

  step("6b. a quantity the column cannot hold is a bad request, not a 500");
  // `numeric(12,3)` holds values under 10^9. Before lib/quantity.ts this
  // reached Postgres and came back as an unmapped 22003, which the API
  // reported as INTERNAL — the same failure mode api-error.ts already refuses
  // for the §7 guards: a bad number from a terminal is the caller's problem to
  // fix, and it can only fix what it is told. `store_core` has rejected this in
  // the domain since M1; this side did not.
  // A distinct device_ts: the dedup key is (device, user, device_ts), so
  // reusing an offset would resolve to the punch above instead of a new one.
  const oversizeSession = await openSession(operator, tabletTok, TABLET, 6);
  const oversize = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletTok),
    body: JSON.stringify({
      session_id: oversizeSession.id,
      item_id: item.id,
      qty: "1000000000",
      client_txn_uuid: randomUUID(),
    }),
  });
  if (oversize.status === 400) ok("400 on a quantity past the column's range");
  else bad("oversize qty -> " + oversize.status + ", expected 400");
  const afterOversize = await onHand(item.id);
  if (afterOversize === afterOverdraw) ok("and it moved no stock");
  else bad("on_hand changed on a refused oversize issue");

  step("7. reverse (§7 — correct by a reversing row, never an edit)");
  const reverse = ledgerId
    ? await call("/api/v1/txn/" + ledgerId + "/reverse", {
        method: "POST",
        headers: bearer(adminTok),
        body: JSON.stringify({ note: "e2e" }),
      })
    : null;
  if (reverse && reverse.status < 300) ok("reversed ledger row " + ledgerId);
  else bad("reverse -> " + reverse?.status + " " + JSON.stringify(reverse?.body).slice(0, 200));
  const afterReverse = await onHand(item.id);
  if (afterReverse === opening) ok("on_hand restored to " + afterReverse);
  else bad("on_hand " + afterReverse + ", expected " + opening);
  const [{ n: reversalRows }] = await sql`
    select count(*)::int as n from stock_ledger where reverses_id = ${ledgerId ?? 0}`;
  if (reversalRows === 1) ok("exactly one reversing row points at it");
  else bad(reversalRows + " reversing rows — §6 allows at most one");

  step("8. submit after close (§10 — 410, and the tablet keeps the typing)");
  const doomed = await openSession(operator, tabletTok, TABLET, 3);
  const closed = await call("/api/v1/sessions/" + doomed.id + "/close", {
    method: "POST",
    headers: bearer(tabletTok),
    body: JSON.stringify({}),
  });
  if (closed.status < 300) ok("session closed on explicit Done");
  else bad("close -> " + closed.status + " " + JSON.stringify(closed.body).slice(0, 120));
  const late = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletTok),
    body: JSON.stringify({
      session_id: doomed.id,
      item_id: item.id,
      qty: "1",
      client_txn_uuid: randomUUID(),
    }),
  });
  if (late.status === 410) ok("410 on a submit after close");
  else bad("post-close submit -> " + late.status + ", §11 says 410");

  step("9. reconcile (§7 — any drift is a bug, not a data-entry problem)");
  const drift = await sql`
    select i.item_code
      from item_stock s
      join items i on i.id = s.item_id
      left join stock_ledger l on l.item_id = s.item_id
     group by i.item_code, s.on_hand
    having s.on_hand <> coalesce(sum(l.delta_qty), 0)`;
  if (drift.length === 0) ok("zero drift across every item");
  else bad(drift.length + " item(s) drifted: " + drift.map((d) => d.item_code).join(", "));

  step("10. the ledger is append-only (§7, enforced by trigger)");
  for (const [what, run] of [
    ["UPDATE", () => sql`update stock_ledger set note = 'tamper' where id = ${ledgerId ?? 0}`],
    ["DELETE", () => sql`delete from stock_ledger where id = ${ledgerId ?? 0}`],
  ]) {
    try {
      await run();
      bad(what + " on stock_ledger succeeded — the trigger is missing");
    } catch {
      ok(what + " on stock_ledger refused");
    }
  }

  step("11. the idle screen's status agrees with its own header");
  // The strip is headed TODAY and its counts are scoped to a window the tablet
  // sends. The recent list was not scoped at all, so a quiet morning rendered
  // "7 movements" above eight rows, the last from the previous evening. A panel
  // that contradicts its own header teaches the reader to distrust every number
  // on the screen — including the stock figures, which is the whole product.
  // Ninety seconds, not an hour. An hour-wide window passed against a build
  // with the scope removed: this database holds far more than twenty movements
  // from the last hour, so the unscoped "last twenty" all fell inside it by
  // accident and the check proved nothing. A window narrower than the run's own
  // history is what makes an unscoped query show its stray rows.
  const since = new Date(Date.now() - 90 * 1000);
  const status = await call(
    `/api/v1/terminal/status?since=${encodeURIComponent(since.toISOString())}`,
    { headers: { Authorization: "Bearer " + tabletTok } },
  );
  if (status.status === 200) ok("200");
  else bad("terminal status answered " + status.status);

  const rows = status.body?.recent ?? [];
  const stray = rows.find((r) => new Date(r.created_at) < since);
  if (!stray) ok(`all ${rows.length} recent rows fall inside the window`);
  else bad(`a row from ${stray.created_at} is listed under a window starting ${since.toISOString()}`);

  // The list is capped at 8, so it may be shorter than the count but never
  // longer: more rows than movements is the contradiction itself.
  if (rows.length <= status.body?.today?.movements) {
    ok(`${rows.length} rows under a count of ${status.body.today.movements}`);
  } else {
    bad(`${rows.length} rows listed but only ${status.body?.today?.movements} counted`);
  }

  // Counts each way, not summed quantities: §6 gives every item a uom, and
  // adding twenty-litre drums to carbide inserts is a number with no unit.
  const t = status.body?.today ?? {};
  if (t.out_count + t.in_count === t.movements) {
    ok(`out ${t.out_count} + in ${t.in_count} = ${t.movements} movements`);
  } else {
    bad(`${t.out_count} + ${t.in_count} does not equal ${t.movements}`);
  }

  // §9.3 and the reason `since` is the tablet's: the window is clamped, so a
  // client cannot ask the server to scan the whole ledger.
  const absurd = await call(
    "/api/v1/terminal/status?since=1970-01-01T00:00:00.000Z",
    { headers: { Authorization: "Bearer " + tabletTok } },
  );
  const clamped = absurd.body?.recent ?? [];
  const cutoff = Date.now() - 25 * 60 * 60 * 1000;
  if (absurd.status === 200 && !clamped.some((r) => new Date(r.created_at).getTime() < cutoff)) {
    ok("a since of 1970 falls back to the last 24 hours rather than scanning the ledger");
  } else {
    bad("an unbounded since was honoured: " + clamped.length + " rows");
  }

} catch (e) {
  bad("aborted: " + (e instanceof Error ? e.message : String(e)));
} finally {
  for (const hash of minted) {
    await sql`update api_tokens set revoked_at = now() where token_hash = ${hash}`.catch(() => {});
  }
  console.log("\n" + "=".repeat(56));
  console.log(pass.length + " passed, " + fail.length + " failed");
  if (fail.length) console.log(fail.map((f) => "  - " + f).join("\n"));
  await sql.end({ timeout: 5 });
  process.exit(fail.length ? 1 : 0);
}
