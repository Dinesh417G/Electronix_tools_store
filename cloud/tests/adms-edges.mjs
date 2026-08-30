// §9's rules about the device, at the edges the happy path never reaches.
//
// `e2e.mjs` proves the handshake and the retried batch. Four things it does not
// touch, each of which §9 states as a hard requirement:
//
//   * **Rule 4 — unknown users.** A punch whose `zk_user_id` maps to no
//     operator is still recorded, and raises an admin notice. Never drop data
//     because the operator master is incomplete; that is how a gap becomes
//     unexplainable six months later.
//
//   * **Rule 3 — distrust the device clock.** Indian half-hour offsets are a
//     known trouble spot on ZK firmware and a device on Wi-Fi can drift off
//     +05:30 silently. `received_at` drives every business decision;
//     `device_ts` is diagnostic. If §10's 90 s expiry were measured from what
//     the terminal claimed, a drifting clock would either expire a session
//     before the operator reached the tablet, or keep a dead one alive.
//
//   * **A batch is many records.** ATTLOG is one record per line, and the
//     acknowledgement is `OK: <n>` for exactly that n — the device reconciles
//     against the number.
//
//   * **Rubbish must not be a 500.** The device retries on any non-OK
//     response, so a handler that throws on a malformed line turns one bad
//     record into an endless retry loop against §9.2's ~200 ms budget.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/adms-edges.mjs

import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const SN = "ADMS-EDGE-1";

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
  const started = Date.now();
  const res = await fetch(BASE + path, opts);
  const ms = Date.now() - started;
  const text = await res.text();
  return { status: res.status, text, ms };
}

const bearer = (t) => ({ Authorization: "Bearer " + t, "Content-Type": "application/json" });

const push = (body) =>
  call("/iclock/cdata?SN=" + SN + "&table=ATTLOG", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body,
  });

/** `yyyy-MM-dd HH:mm:ss`, the only format the device sends. */
const fmt = (date) => date.toISOString().slice(0, 19).replace("T", " ");

/**
 * What `device_ts` will hold once the server has parsed that line.
 *
 * `parseDeviceTs` reads the device's naive stamp as UTC on purpose (§9.3: the
 * zone is a diagnostic inconvenience, and interpreting it one fixed way is
 * reversible given the device's configured offset, whereas guessing is not).
 * So the round trip is the string back through `Date`, as a Date — never as a
 * string parameter. `where device_ts = $1` with text on the right resolves to a
 * *text* comparison against `timestamptz::text`, which carries an offset the
 * device never sent and therefore matches nothing at all.
 */
const stored = (date) => new Date(fmt(date) + "Z");
const line = (userId, date) => userId + "\t" + fmt(date) + "\t0\t1\t\t";

const TABLET = "adms-edge-tablet";
const unknownIds = [];

try {
  step("0. fixtures and handshake");
  await sql`
    insert into tablets (tablet_id, name) values (${TABLET}, 'adms edge test')
    on conflict (tablet_id) do nothing`;
  const [admin] = await sql`select id from operators where active and role = 'ADMIN' limit 1`;
  const [operator] = await sql`
    select id, zk_user_id from operators
     where active and zk_user_id is not null and role = 'OPERATOR' limit 1`;
  const tabletToken = await mint("TABLET", { tabletId: TABLET });
  const adminToken = await mint("OPERATOR", { operatorId: admin.id });

  const hello = await call("/iclock/cdata?SN=" + SN + "&options=all&pushver=2.4.1");
  if (hello.status === 200) ok("handshake 200 in " + hello.ms + " ms");
  else bad("handshake answered " + hello.status);
  for (const key of ["GET OPTION FROM", "ATTLOGStamp", "TransFlag", "Realtime", "ServerVer"]) {
    if (hello.text.includes(key)) ok("the option block carries " + key);
    else bad("the option block is missing " + key + ": " + JSON.stringify(hello.text.slice(0, 120)));
  }
  const [device] = await sql`select id from devices where serial_no = ${SN}`;
  if (device) ok("the handshake registered the device");
  else bad("no device row after a handshake — §9's dedup key needs one");

  step("1. rule 4 — a punch from a user nobody has enrolled");
  const stranger = "99" + randomBytes(3).toString("hex").replace(/\D/g, "0").slice(0, 4);
  unknownIds.push(stranger);
  const unknown = await push(line(stranger, new Date()) + "\n");
  if (unknown.text.trim() === "OK: 1") ok("acknowledged exactly 'OK: 1'");
  else bad("acknowledged " + JSON.stringify(unknown.text) + ", expected 'OK: 1'");

  const kept = await sql`
    select id, claimed from punches where zk_user_id = ${stranger}`;
  if (kept.length === 1) ok("the punch was kept, not dropped (§9.4)");
  else bad(kept.length + " punch rows for an unknown user — data was dropped");
  if (kept[0] && kept[0].claimed === false) ok("and it offered no session");
  else bad("an unknown user's punch was marked claimed");

  const notice = await call("/api/v1/punches/unknown", { headers: bearer(adminToken) });
  if (notice.status === 200 && notice.text.includes(stranger)) {
    ok("it reaches the admin notice endpoint");
  } else {
    bad("/punches/unknown answered " + notice.status + " without the user id");
  }

  step("2. a batch is many records, and n is what the device reconciles against");
  const now = Date.now();
  const three = [
    line(unknownIds[0], new Date(now - 61_000)),
    line(unknownIds[0], new Date(now - 62_000)),
    line(unknownIds[0], new Date(now - 63_000)),
  ].join("\n") + "\n";
  const batch = await push(three);
  if (batch.text.trim() === "OK: 3") ok("three records acknowledged 'OK: 3'");
  else bad("a three-line batch answered " + JSON.stringify(batch.text));
  const [{ n: punchCount }] = await sql`
    select count(*)::int as n from punches where zk_user_id = ${unknownIds[0]}`;
  if (punchCount === 4) ok("four punches in total, one per distinct device_ts");
  else bad(punchCount + " punches after 1 + 3 distinct records");

  step("3. rule 3 — a device clock six months out does not age a session");
  const stale = new Date(now - 180 * 24 * 3600 * 1000);
  await push(line(operator.zk_user_id, stale) + "\n");
  const [session] = await sql`
    select s.id, s.state, s.opened_at, p.device_ts, p.received_at
      from sessions s join punches p on p.id = s.punch_id
     where p.zk_user_id = ${operator.zk_user_id}
       and p.device_ts = ${stored(stale)}`;
  if (session) ok("the stale punch still offered a session");
  else bad("no session for a punch whose device clock was six months slow");

  if (session) {
    const openedSkew = Math.abs(Date.now() - new Date(session.opened_at).getTime());
    if (openedSkew < 120_000) {
      ok("opened_at came from the server, not the device (" + Math.round(openedSkew / 1000) + "s ago)");
    } else {
      bad("opened_at is " + session.opened_at + " — §10's 90 s expiry is being measured from the device clock");
    }
    const claimed = await call("/api/v1/sessions/" + session.id + "/claim", {
      method: "POST",
      headers: bearer(tabletToken),
      body: JSON.stringify({ tablet_id: TABLET }),
    });
    if (claimed.status === 200) ok("and it is claimable — not born expired");
    else bad("claiming it answered " + claimed.status + " " + claimed.text.slice(0, 160));
    await call("/api/v1/sessions/" + session.id + "/close", {
      method: "POST", headers: bearer(tabletToken), body: JSON.stringify({}),
    });
  }

  step("4. and neither does a clock running ahead (+05:30 drift)");
  const ahead = new Date(now + 5.5 * 3600 * 1000);
  await push(line(operator.zk_user_id, ahead) + "\n");
  const [future] = await sql`
    select s.id, s.state, s.opened_at
      from sessions s join punches p on p.id = s.punch_id
     where p.zk_user_id = ${operator.zk_user_id}
       and p.device_ts = ${stored(ahead)}`;
  if (future) ok("a punch stamped five and a half hours from now still offered a session");
  else bad("no session for a punch from a device running ahead");
  if (future) {
    const skew = Date.now() - new Date(future.opened_at).getTime();
    if (skew > -60_000) ok("opened_at is not in the future either");
    else bad("opened_at is " + future.opened_at + ", which is ahead of the server clock");
    const unclaimed = await call("/api/v1/sessions/unclaimed", { headers: bearer(tabletToken) });
    if (unclaimed.text.includes(future.id)) ok("it appears on the claim screen");
    else bad("the claim screen does not list it — the operator is standing at a dead tablet");
    await sql`
      update sessions set state = 'EXPIRED', closed_at = now()
       where id = ${future.id} and state = 'UNCLAIMED'`;
  }

  step("5. rubbish must not become a retry loop");
  const cases = [
    ["an empty body", ""],
    ["a line with no tabs", "not-a-record\n"],
    ["a date the device could not have sent", "1042\tnot-a-date\t0\t1\t\t\n"],
    ["a blank line between records", "\n\n"],
  ];
  for (const [name, body] of cases) {
    const res = await push(body);
    if (res.status === 200 && /^OK/.test(res.text.trim())) {
      ok(name + " → " + res.text.trim().slice(0, 12) + " in " + res.ms + " ms");
    } else {
      bad(name + " → " + res.status + " " + JSON.stringify(res.text.slice(0, 120)) +
          " — the device retries anything that is not OK, forever");
    }
  }

  step("6. the other two endpoints the device polls");
  const poll = await call("/iclock/getrequest?SN=" + SN);
  if (poll.status === 200 && poll.text.trim().length > 0) {
    ok("getrequest answers " + JSON.stringify(poll.text.trim().slice(0, 20)));
  } else {
    bad("getrequest answered " + poll.status + " " + JSON.stringify(poll.text));
  }
  const result = await call("/iclock/devicecmd?SN=" + SN, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "ID=1&Return=0&CMD=DATA",
  });
  if (result.status === 200) ok("devicecmd accepts a command result");
  else bad("devicecmd answered " + result.status);

  step("7. §9.2 — every device call stayed inside the budget");
  const slow = [hello, unknown, batch, poll, result].filter((r) => r.ms > 1000);
  if (slow.length === 0) ok("no device call took over a second against a local database");
  else bad(slow.length + " device calls took over a second: " + slow.map((r) => r.ms + "ms").join(", "));
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  for (const id of unknownIds) {
    await sql`delete from punches where zk_user_id = ${id}`;
  }
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
