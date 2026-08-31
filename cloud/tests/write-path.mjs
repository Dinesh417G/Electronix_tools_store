// The write path under the conditions production actually has.
//
// On 2026-08-28 every `POST /api/v1/txn/issue` against the deployment answered
// `504 Vercel Runtime Timeout Error: Task timed out after 300 seconds`. The
// terminal read "Saving…" for five minutes, the ledger stayed empty, and the
// core loop of the product turned out never to have worked in production even
// once. `e2e.mjs` was 21 green assertions the whole time.
//
// What happened, from Supabase's own logs:
//
//   15:33:19  postgres   could not receive data from client: Connection reset by peer
//   15:34:03  postgres   received SIGHUP, reloading configuration files
//   15:44:04  supavisor  Client socket closed while state was idle (transaction)
//
// Supabase reloaded its configuration and reset the connections underneath us.
// `db.ts` went on holding sockets it believed in, and **nothing bounded a
// query**: `connect_timeout` covers opening a connection, not waiting on one
// already open. The role behind DATABASE_URL had no `statement_timeout` of its
// own (the 2 min database default) and no `lock_timeout` at all, and `fetch`
// in the browser waits forever by default. Three layers, none of them bounded,
// so the wait ended when the platform killed the function.
//
// The fix is a bound at each layer. This test gates the one that can be
// checked without breaking a socket on purpose: **the connection this app
// makes carries the limits `db.ts` claims to set.** Delete that block and this
// fails, which is the whole job — the outage's signature was a wait nobody had
// put a number on.
//
// It then does what no other test here does: drives a real issue while reads
// are in flight. That did *not* reproduce the outage — it was tried first, and
// passed against the broken build in 184 ms, which is exactly why the fix is
// not about pool size. It stays because concurrency was untested either way,
// and because `e2e.mjs` is strictly sequential: not one of its assertions ever
// has two requests in the air.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 \
//     node --experimental-strip-types tests/write-path.mjs

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { sql as appSql } from "../src/lib/db.ts";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SN = "WRITEPATH-DEVICE-1";
const TABLET = "writepath-tablet";

// A claim screen, a live view and a touch are what actually share an instance.
// Not a stress figure — the outage needed no load at all.
const READERS = 8;

// Generous by three orders of magnitude: a healthy issue answers in about a
// tenth of a second, and the outage took 300 000 ms. A wide budget keeps this
// about starvation rather than about the speed of the machine running it.
const BUDGET_MS = 10_000;

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
async function mint(kind, { tabletId = null } = {}) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, expires_at)
    values (${hash}, ${kind}, ${tabletId}, now() + interval '1 hour')`;
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

/** Postgres reports these in ms, or with a unit suffix when they are round. */
const millis = (setting) => {
  const s = String(setting).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(\d+)\s*(us|ms|s|min|h)$/);
  if (!m) return NaN;
  return Number(m[1]) * { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000 }[m[2]];
};

try {
  step("1. every wait this app makes has a number on it (db.ts)");
  // Through the app's own client, not a fresh connection: the point is that
  // the settings `db.ts` passes actually reach the session it hands the routes.
  const [limits] = await appSql`
    select current_setting('statement_timeout') as statement_timeout,
           current_setting('lock_timeout') as lock_timeout,
           current_setting('idle_in_transaction_session_timeout') as idle_in_txn`;

  for (const [name, value] of Object.entries({
    statement_timeout: limits.statement_timeout,
    lock_timeout: limits.lock_timeout,
    idle_in_transaction_session_timeout: limits.idle_in_txn,
  })) {
    const ms = millis(value);
    if (Number.isFinite(ms) && ms > 0 && ms <= 60_000) {
      ok(name + " = " + value);
    } else {
      bad(
        name + " = " + value +
        " — unbounded or too long. A query with no limit is what let the " +
        "function hang for 300 s while the operator watched 'Saving…'.",
      );
    }
  }

  step("1b. nothing bounded by the database can be left outside it");
  // The 2026-08-31 sequel to the outage above, and a different shape of the
  // same lesson.
  //
  // `authenticate()` fired two touches per request as
  // `void sql\`update …\`.catch(() => {})` — issued, never awaited. On this
  // platform there is no "after the response": the instance is frozen the
  // moment the response is delivered, so an unawaited query can be suspended
  // part-way through its protocol exchange. What that leaves behind was
  // visible in `pg_stat_activity` on the live database:
  //
  //   state=active  wait_event=ClientRead  xact_age=00:04:55
  //   query: select t.id, t.kind … from api_tokens t left join operators o …
  //
  // `active` on `ClientRead` is not executing, so `statement_timeout` never
  // counts it; it is not `idle in transaction`, so
  // `idle_in_transaction_session_timeout` never counts it either. Step 1's
  // three bounds are blind to it by construction. With `max: 1` that socket is
  // the instance's only connection, so every later request queued behind it
  // until Vercel killed the function at 300 s — the console's Door screen read
  // "did not answer within 25.2s" and `/api/v1/admin/devices` hung five times
  // out of five.
  //
  // So this is a source check, deliberately: the defect is a query that
  // *escapes the request*, and no assertion made from inside a request can see
  // one. Both halves of the fix are checked — no fire-and-forget on the server,
  // and a deadline above `statement_timeout` for when one arrives another way.
  const serverSources = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name)) serverSources.push(full);
    }
  };
  await walk("src/lib");
  await walk("src/app");

  const stranded = [];
  for (const file of serverSources) {
    const text = await readFile(file, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (line.includes("void sql`") || line.includes("void tx`")) {
        stranded.push(file + ":" + (i + 1));
      }
    }
  }
  if (stranded.length === 0) {
    ok("no query is fired without being awaited (" + serverSources.length + " files)");
  } else {
    bad(
      "a query is fired and never awaited, which is what wedged the connection " +
      "on 2026-08-31: " + stranded.join(", "),
    );
  }

  // The other way a query escapes the shape the pooler expects: several of them
  // started at once on the one connection `max: 1` allows.
  //
  // `/api/v1/admin/devices` ran three in a `Promise.all`, and it was the only
  // route in the app that did. It was also the only route that hung — 503 at
  // the deadline, every time, on production `dc08acd`, while every other
  // authenticated route answered in about 200 ms. postgres.js pipelines them
  // onto one socket as though it owns the connection; Supavisor in transaction
  // mode hands out a connection per transaction. The desync leaves the backend
  // `active` on `ClientRead` holding an open transaction, and the next request
  // on that instance behind it.
  //
  // Step 4 below drives eight concurrent reads and passes, which is exactly why
  // this is a source check: there is no pooler in front of a local Postgres, so
  // nothing here can reproduce it. Same blind spot as 2026-08-28.
  const concurrent = [];
  for (const file of serverSources) {
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!line.includes("Promise.all")) return;
      const window = lines.slice(i, i + 12).join("\n");
      if (/sql`|tx`/.test(window)) concurrent.push(`${file}:${i + 1}`);
    });
  }
  if (concurrent.length === 0) {
    ok("no route starts two queries at once on the one pooled connection");
  } else {
    bad(
      "queries are started concurrently on a max:1 connection, which desyncs " +
      "through the transaction pooler: " + concurrent.join(", "),
    );
  }

  const dbSource = await readFile("src/lib/db.ts", "utf8");
  const deadline = dbSource.match(/DB_DEADLINE_MS\s*=\s*([\d_]+)/);
  const statementMs = millis(limits.statement_timeout);
  if (!deadline) {
    bad("db.ts sets no DB_DEADLINE_MS — a wedged socket is bounded by nothing");
  } else if (Number(deadline[1].replace(/_/g, "")) <= statementMs) {
    bad(
      "DB_DEADLINE_MS is not above statement_timeout, so it fires on queries " +
      "the database would have reported on itself",
    );
  } else {
    ok("db.ts bounds a query at " + deadline[1] + " ms, above statement_timeout");
  }

  step("2. fixtures");
  const [operator] = await sql`
    select id, emp_code, zk_user_id from operators
     where active and zk_user_id is not null and role = 'OPERATOR' limit 1`;
  if (!operator) throw new Error("seed an OPERATOR first");
  const [item] = await sql`
    select i.id, i.item_code, s.on_hand from items i
      join item_stock s on s.item_id = i.id
     where i.active and not i.allow_negative and s.on_hand >= 2
     order by s.on_hand desc limit 1`;
  if (!item) throw new Error("seed a catalog first");
  console.log("  operator " + operator.emp_code + ", item " + item.item_code);

  await sql`
    insert into tablets (tablet_id, name) values (${TABLET}, 'write-path')
    on conflict (tablet_id) do update set active = true`;
  const tabletTok = await mint("TABLET", { tabletId: TABLET });

  step("3. open a session the way the door does");
  const ts = new Date(Date.now() - 5000).toISOString().slice(0, 19).replace("T", " ");
  await call("/iclock/cdata?SN=" + SN + "&options=all&pushver=2.4.1");
  await call("/iclock/cdata?SN=" + SN + "&table=ATTLOG", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: operator.zk_user_id + "\t" + ts + "\t0\t1\t\t\n",
  });
  const cards = await call("/api/v1/sessions/unclaimed", { headers: bearer(tabletTok) });
  const list = Array.isArray(cards.body) ? cards.body : (cards.body?.sessions ?? []);
  const card = list.find((c) => c.operator_id === operator.id) ?? list[0];
  const sessionId = card?.session_id ?? card?.id;
  if (!sessionId) throw new Error("no unclaimed session to claim");
  const claim = await call("/api/v1/sessions/" + sessionId + "/claim", {
    method: "POST",
    headers: bearer(tabletTok),
    body: JSON.stringify({ tablet_id: TABLET }),
  });
  if (claim.status < 300) ok("claimed " + sessionId);
  else bad("claim -> " + claim.status + " " + JSON.stringify(claim.body).slice(0, 120));

  step("4. issue while " + READERS + " readers poll, as the claim screen does");
  // The readers run for exactly as long as the write does, so a pass says the
  // write got through contention rather than that the contention had stopped.
  let polling = true;
  let reads = 0;
  const readerFailures = [];
  const reader = async () => {
    while (polling) {
      try {
        const r = await call("/api/v1/sessions/unclaimed", { headers: bearer(tabletTok) });
        if (r.status !== 200) readerFailures.push("unclaimed -> " + r.status);
        reads += 1;
      } catch (e) {
        readerFailures.push(String(e?.message ?? e));
      }
    }
  };
  const readers = Array.from({ length: READERS }, reader);

  const before = await onHand(item.id);
  const started = Date.now();
  const issue = await call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(tabletTok),
    body: JSON.stringify({
      session_id: sessionId,
      item_id: item.id,
      qty: "1",
      client_txn_uuid: randomUUID(),
    }),
  });
  const elapsed = Date.now() - started;
  polling = false;
  await Promise.all(readers);
  console.log("  " + reads + " reads landed while the write was in flight");

  if (issue.status === 200) ok("issue accepted (200) under read load");
  else bad("issue -> " + issue.status + " " + JSON.stringify(issue.body).slice(0, 160));

  if (elapsed < BUDGET_MS) ok("completed in " + elapsed + " ms, inside the " + BUDGET_MS + " ms budget");
  else bad("took " + elapsed + " ms — a write starved by concurrent reads");

  step("5. and it actually committed (§7)");
  const after = await onHand(item.id);
  if (Math.abs(before - after - 1) < 1e-9) ok("on_hand " + before + " -> " + after);
  else bad("on_hand went " + before + " -> " + after + ", expected a fall of exactly 1");

  const [row] = await sql`
    select count(*)::int as n from stock_ledger
     where session_id = ${sessionId} and txn_type = 'ISSUE'`;
  if (row.n === 1) ok("exactly one ISSUE row for the session");
  else bad(row.n + " ISSUE rows for the session — §7 says one movement, one row");

  if (readerFailures.length === 0) ok("no reader was starved either");
  else bad(readerFailures.length + " reader failures, first: " + readerFailures[0]);
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  // Leave the database as it was found, apart from the ledger — §7 forbids
  // deleting a movement, and a test is not an exception to that.
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
  await appSql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
