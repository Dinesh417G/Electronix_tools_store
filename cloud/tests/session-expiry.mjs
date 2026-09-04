// §10's derive-on-read rule, through the API rather than through the function.
//
// `store-server` runs two background reapers — 90 s unclaimed expiry, 180 s
// idle close. Vercel has no process to run them in and cron on the hobby plan
// runs daily, so the deployed system **derives state on read** instead: a
// session is EXPIRED if it is stored UNCLAIMED and older than 90 s, CLOSED if
// stored ACTIVE and idle past 180 s.
//
// §10 states the failure mode precisely: *"Any new query that filters on
// `state` directly, rather than through the helper that applies these two
// rules, reintroduces the bug — a session that everyone can see is dead and
// the database still calls ACTIVE."*
//
// `session-transitions.mjs` proves `effectiveState` itself, with no database
// and no server. What nothing proved is that the **routes** ask it. A route
// that reads `state` straight from the row accepts a write against a session
// that timed out twenty minutes ago, and the ledger takes it — §7 has no
// opinion about how old a session is. This file is the difference between the
// rule existing and the rule being enforced.
//
// The clock is moved by backdating the row, not by sleeping: 180 s of real
// waiting per assertion is not a test anybody runs.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/session-expiry.mjs

import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SN = "EXPIRY-DEVICE-1";
const TABLET = "expiry-tablet";

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

const offered = new Set();

/**
 * Push one ATTLOG record and return the session it offered.
 *
 * The offsets are far apart on purpose. §9.1 deduplicates on
 * (device_id, zk_user_id, device_ts) at one-second resolution, so two calls a
 * second apart with offsets of 1 s and 2 s can land on the *same* stamp — the
 * second push is then correctly a no-op and this returns the first session
 * again. Two steps of this test would silently share one session, and step 2
 * un-backdating it would look like step 1 having written a ledger row.
 */
async function offer(operator, index) {
  const ts = new Date(Date.now() - index * 97_000);
  await call("/iclock/cdata?SN=" + SN + "&table=ATTLOG", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: operator.zk_user_id + "\t" + fmt(ts) + "\t0\t1\t\t\n",
  });
  // Scoped to this file's own device. §9.1's dedup key is
  // (device_id, zk_user_id, device_ts), so two test files using the same
  // operator and the same 97 s spacing produce *different* punches on
  // different devices — and a lookup that leaves the device out can match the
  // other file's punch, whose session is already CLOSED. CI runs these back to
  // back; locally they were a second apart and it never showed.
  const [row] = await sql`
    select s.id from sessions s
      join punches p on p.id = s.punch_id
      join devices d on d.id = p.device_id
     where d.serial_no = ${SN}
       and p.zk_user_id = ${operator.zk_user_id}
       and p.device_ts = ${new Date(fmt(ts) + "Z")}`;
  if (row?.id && offered.has(row.id)) {
    bad("offer(" + index + ") handed back a session an earlier step already used");
  }
  if (row?.id) offered.add(row.id);
  return row?.id;
}

const claim = (id, token) =>
  call("/api/v1/sessions/" + id + "/claim", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ tablet_id: TABLET }),
  });

/** The same, for a tablet other than this file's default. */
const claimAs = (id, token, tabletId) =>
  call("/api/v1/sessions/" + id + "/claim", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ tablet_id: tabletId }),
  });

const issue = (id, itemId, token, qty = "1") =>
  call("/api/v1/txn/issue", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({
      session_id: id, item_id: itemId, qty, client_txn_uuid: randomUUID(),
    }),
  });

const storedState = async (id) => {
  const [row] = await sql`select state from sessions where id = ${id}`;
  return row?.state;
};

try {
  step("0. fixtures");
  const [operator] = await sql`
    select id, zk_user_id from operators
     where active and zk_user_id is not null and role = 'OPERATOR' order by emp_code limit 1`;
  const [item] = await sql`
    select i.id, i.item_code from items i join item_stock s on s.item_id = i.id
     where i.active and s.on_hand >= 10 order by i.item_code limit 1`;
  await sql`
    insert into devices (serial_no, name) values (${SN}, 'expiry test')
    on conflict (serial_no) do nothing`;
  await sql`
    insert into tablets (tablet_id, name) values (${TABLET}, 'expiry test')
    on conflict (tablet_id) do nothing`;
  const tabletToken = await mint("TABLET", { tabletId: TABLET });
  ok("operator " + operator.zk_user_id + ", item " + item.item_code);

  step("1. an ACTIVE session idle past 180 s is dead on read");
  const stale = await offer(operator, 1);
  const claimed = await claim(stale, tabletToken);
  if (claimed.status === 200) ok("claimed, so it is stored ACTIVE");
  else bad("claim answered " + claimed.status + " " + JSON.stringify(claimed.body));

  // 200 s of no activity, without waiting 200 s.
  await sql`
    update sessions set last_activity_at = now() - interval '200 seconds'
     where id = ${stale}`;

  if ((await storedState(stale)) === "ACTIVE") {
    ok("the row still says ACTIVE — nothing swept it, and nothing will");
  } else {
    bad("the stored state is " + (await storedState(stale)) + ", expected ACTIVE");
  }

  const read = await call("/api/v1/sessions/" + stale, { headers: bearer(tabletToken) });
  const reported = read.body?.state ?? read.body?.session?.state;
  if (reported === "CLOSED") ok("GET /sessions/{id} reports the effective state: CLOSED");
  else bad("GET /sessions/{id} reported " + JSON.stringify(reported) + " for a session idle 200 s");

  const late = await issue(stale, item.id, tabletToken);
  if (late.status === 410) {
    ok("an issue against it is 410 — §11's code, the one the tablet branches on");
  } else {
    bad("issue against a timed-out session answered " + late.status + " " +
        JSON.stringify(late.body) + " — the ledger has no opinion about how old a session is");
  }

  const touched = await call("/api/v1/sessions/" + stale + "/touch", {
    method: "POST", headers: bearer(tabletToken), body: JSON.stringify({}),
  });
  if (touched.status === 410) ok("and a keepalive is refused too — a keepalive is a write");
  else bad("/touch on a timed-out session answered " + touched.status);

  // The assertion that matters. A keepalive that merely answers 200 is untidy;
  // a keepalive that moves last_activity_at is a session brought back from the
  // dead, and the very next issue is a ledger row §7 can never delete.
  const afterTouch = await issue(stale, item.id, tabletToken);
  if (afterTouch.status === 410) {
    ok("still 410 after the keepalive — nothing was resurrected");
  } else {
    bad("RESURRECTED: the keepalive revived a session §10 had closed, and the issue answered " +
        afterTouch.status);
  }

  step("1b. a keepalive belongs to the tablet holding the session");
  const other = "expiry-tablet-second";
  await sql`
    insert into tablets (tablet_id, name) values (${other}, 'expiry test B')
    on conflict (tablet_id) do nothing`;
  const otherToken = await mint("TABLET", { tabletId: other });
  const mine = await offer(operator, 6);
  await claim(mine, tabletToken);
  const poached = await call("/api/v1/sessions/" + mine + "/touch", {
    method: "POST", headers: bearer(otherToken), body: JSON.stringify({}),
  });
  if (poached.status === 409) {
    ok("a second tablet cannot extend a session it does not hold");
  } else {
    bad("a second tablet's keepalive answered " + poached.status +
        " — §10 binds a claimed session to one tablet");
  }
  await call("/api/v1/sessions/" + mine + "/close", {
    method: "POST", headers: bearer(tabletToken), body: JSON.stringify({}),
  });

  step("2. an ACTIVE session inside the window still works");
  const live = await offer(operator, 2);
  await claim(live, tabletToken);
  await sql`
    update sessions set last_activity_at = now() - interval '100 seconds'
     where id = ${live}`;
  const inTime = await issue(live, item.id, tabletToken);
  if (inTime.status === 200) ok("idle 100 s of 180 is still working, not abandoned");
  else bad("an issue at 100 s idle answered " + inTime.status + " " + JSON.stringify(inTime.body));

  step("3. an UNCLAIMED punch older than 90 s is off the claim screen");
  const old = await offer(operator, 3);
  await sql`update sessions set opened_at = now() - interval '120 seconds' where id = ${old}`;

  const cards = await call("/api/v1/sessions/unclaimed", { headers: bearer(tabletToken) });
  if (!cards.text.includes(old)) ok("it is not offered as a name card");
  else bad("a punch from 120 s ago is still on the claim screen");

  const tooLate = await claim(old, tabletToken);
  if (tooLate.status === 410) ok("claiming it is 410, not a session that opens two minutes late");
  else bad("claiming a 120 s old punch answered " + tooLate.status + " " + JSON.stringify(tooLate.body));

  if ((await storedState(old)) === "UNCLAIMED") {
    ok("stored UNCLAIMED throughout — the row lags, the reads do not");
  } else {
    bad("stored state became " + (await storedState(old)));
  }

  step("4. a fresh punch is still claimable, so this is not just refusing everything");
  const fresh = await offer(operator, 4);
  const fine = await claim(fresh, tabletToken);
  if (fine.status === 200) ok("a punch from a moment ago claims normally");
  else bad("claiming a fresh punch answered " + fine.status + " " + JSON.stringify(fine.body));
  await call("/api/v1/sessions/" + fresh + "/close", {
    method: "POST", headers: bearer(tabletToken), body: JSON.stringify({}),
  });


  step("4b. two tablets claiming one card: exactly one wins (§10)");

  /* §10: "A claimed session is bound to one tablet_id. A second tablet cannot
     claim it." The pure machine refuses it — but only when it *reads* ACTIVE.
     Two tablets claiming together both read UNCLAIMED, both pass, and the
     writer's guard was `state in ('UNCLAIMED', 'ACTIVE')`, which then matched
     the row the first claim had just made ACTIVE. Both were answered 200 and
     the loser was handed the winner's tablet id in its own response. Six
     probes out of six against the running app, so not a narrow race — and two
     claims at once is the tailgating case the claim screen exists for.

     `e2e.mjs` pins the sequential 409 and passed throughout: it claims one
     tablet after the other, which is the case that was never broken. */
  await sql`
    insert into tablets (tablet_id, name) values ('race-tablet-a', 'race test a'),
                                                 ('race-tablet-b', 'race test b')
    on conflict (tablet_id) do nothing`;
  const tokenA = await mint("TABLET", { tabletId: "race-tablet-a" });
  const tokenB = await mint("TABLET", { tabletId: "race-tablet-b" });

  const contested = await offer(operator, 5);
  const [raceA, raceB] = await Promise.all([
    claimAs(contested, tokenA, "race-tablet-a"),
    claimAs(contested, tokenB, "race-tablet-b"),
  ]);

  const winners = [raceA, raceB].filter((r) => r.status === 200);
  const losers = [raceA, raceB].filter((r) => r.status === 409);
  if (winners.length === 1 && losers.length === 1) {
    ok("one claim answered 200 and the other 409");
  } else {
    bad(
      "two tablets claimed one session and got " +
        raceA.status + " and " + raceB.status +
        " — §10 binds a session to one tablet",
    );
  }

  // The database has to agree with whichever tablet was told it won. A pair of
  // 200/409 answers over a row that ended up held by the *loser* would be the
  // same bug with better manners.
  const [held] = await sql`select tablet_id from sessions where id = ${contested}`;
  if (winners.length === 1 && held?.tablet_id === winners[0].body?.tablet_id) {
    ok("and the row is held by the tablet that was told it won: " + held.tablet_id);
  } else {
    bad("the session is held by " + held?.tablet_id + ", winners: " +
        JSON.stringify(winners.map((w) => w.body?.tablet_id)));
  }

  // The half the loose guard existed for, which the fix must not take away: a
  // tablet re-claiming a session it already holds is a reconnect, not a
  // conflict.
  const again = await claimAs(contested, held?.tablet_id === "race-tablet-a" ? tokenA : tokenB,
                              held?.tablet_id);
  if (again.status === 200) ok("the holder re-claiming after a reconnect still succeeds");
  else bad("a re-claim by the holding tablet answered " + again.status);

  await call("/api/v1/sessions/" + contested + "/close", {
    method: "POST",
    headers: bearer(held?.tablet_id === "race-tablet-a" ? tokenA : tokenB),
    body: JSON.stringify({}),
  });

  step("5. the ledger is unmoved by any of the refusals (§7)");
  const [drift] = await sql`
    select count(*)::int as n
      from item_stock s
      join (select item_id, sum(delta_qty) as total from stock_ledger group by item_id) l
        on l.item_id = s.item_id
     where s.on_hand <> l.total`;
  if (drift.n === 0) ok("sum(delta_qty) equals on_hand for every item");
  else bad(drift.n + " items drifted");

  const [ghost] = await sql`
    select count(*)::int as n from stock_ledger where session_id = ${stale}`;
  if (ghost.n === 0) ok("the timed-out session wrote nothing at all");
  else bad(ghost.n + " ledger rows belong to a session that had already timed out");
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
