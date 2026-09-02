// The brake in front of the PIN check (auth-throttle.ts, migration 0010).
//
// What this defends, concretely: `POST /api/v1/auth/operator` and
// `POST /api/v1/sessions/manual` take an employee code and four digits, both
// are reachable from the public internet on the deployment, and before 0010
// neither counted how often it had said no. Ten thousand combinations against
// an endpoint that answers all of them is an afternoon. So the assertions here
// are mostly about *refusing to answer*, and one of them matters more than the
// rest: while a code is locked, the correct PIN is refused too. A throttle that
// still checks the PIN has slowed nothing down.
//
// The window is fifteen minutes and no test waits that long, so rows are
// backdated in SQL to move the clock. That is the honest way round — the
// alternative is a shorter window in test builds, which then tests something
// the deployment does not run.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/auth-throttle.mjs

import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { hash as argonHash } from "@node-rs/argon2";

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

// Mirrors the constants in src/lib/auth-throttle.ts. Deliberately duplicated
// rather than imported: if somebody loosens a limit, this file should fail and
// make them say so out loud.
const WINDOW_MINUTES = 15;
const MAX_PER_CODE = 10;
const MAX_PER_IP = 20;

const TAG = randomBytes(3).toString("hex").toUpperCase();
const CODE = `TEST-THR-${TAG}`;
const PIN = "4729";
const SPRAY_IP = "203.0.113." + (10 + Math.floor(Math.random() * 200));
const OTHER_IP = "198.51.100.7";
const TABLET = `test-thr-${TAG.toLowerCase()}`;

const codes = [CODE];
const tokenHashes = [];

async function call(path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, retryAfter: res.headers.get("retry-after") };
}

const login = (pin, headers) => call("/api/v1/auth/operator", { emp_code: CODE, pin }, headers);

async function makeOperator(empCode, pin) {
  const [row] = await sql`
    insert into operators (emp_code, full_name, role, pin_hash, active)
    values (${empCode}, ${"Throttle fixture " + empCode}, 'STOREKEEPER',
            ${await argonHash(pin)}, true)
    returning id`;
  return row.id;
}

/** Moves this code's history out of the window, which is how the clock ticks. */
async function ageOut(empCode) {
  await sql`
    update auth_attempts
       set at = at - make_interval(mins => ${WINDOW_MINUTES + 5})
     where emp_code = ${empCode}`;
}

try {
  step("0. fixtures — an operator this test owns, with a PIN it knows");
  await makeOperator(CODE, PIN);
  ok(`created ${CODE}`);

  step("1. what the log holds, and what it deliberately does not");
  const columns = (
    await sql`
      select column_name from information_schema.columns
       where table_schema = current_schema() and table_name = 'auth_attempts'
       order by column_name`
  ).map((r) => r.column_name);
  const expected = ["at", "client_ip", "emp_code", "id", "route", "succeeded"];
  if (columns.join(",") === expected.join(",")) {
    ok("auth_attempts holds " + expected.join(", ") + " — no PIN, no hash of one");
  } else {
    bad("auth_attempts columns are " + columns.join(", "));
  }
  const [{ relrowsecurity }] = await sql`
    select relrowsecurity from pg_class
     where oid = (current_schema() || '.auth_attempts')::regclass`;
  if (relrowsecurity) ok("§6: RLS is on, so PostgREST can neither read nor write it");
  else bad("auth_attempts has RLS disabled — PostgREST can read every attempt");

  step("2. the right PIN still works, and is recorded as a success");
  const first = await login(PIN);
  if (first.status === 200) ok("200 for the correct PIN");
  else bad(`the correct PIN answered ${first.status}: ` + JSON.stringify(first.body));
  const [{ n: successes }] = await sql`
    select count(*)::int as n from auth_attempts
     where emp_code = ${CODE} and succeeded`;
  if (successes === 1) ok("one success on the log");
  else bad(`${successes} successes recorded, expected 1`);

  step(`3. ${MAX_PER_CODE} wrong PINs are each refused 401, not throttled early`);
  const wrongStatuses = new Set();
  for (let i = 0; i < MAX_PER_CODE; i++) wrongStatuses.add((await login("0000")).status);
  if (wrongStatuses.size === 1 && wrongStatuses.has(401)) ok(`all ${MAX_PER_CODE} answered 401`);
  else bad("statuses were " + [...wrongStatuses].join(", "));

  step("4. the next attempt is refused 429 — and so is the correct PIN");
  const locked = await login("0000");
  if (locked.status === 429) ok("429 once the count is reached");
  else bad(`attempt ${MAX_PER_CODE + 1} answered ${locked.status}`);
  if (locked.retryAfter && Number(locked.retryAfter) > 0) {
    ok(`Retry-After: ${locked.retryAfter}s, so a client need not guess`);
  } else {
    bad("no Retry-After header on the 429");
  }
  if (typeof locked.body?.message === "string" && /try again in/i.test(locked.body.message)) {
    ok(`the message is written for a person at a tablet: "${locked.body.message}"`);
  } else {
    bad("429 message is " + JSON.stringify(locked.body));
  }
  if (!/exist|unknown|no such/i.test(locked.body?.message ?? "")) {
    ok("and it does not say whether the employee code is real");
  } else {
    bad("the 429 message enumerates employee codes");
  }

  const withRightPin = await login(PIN);
  if (withRightPin.status === 429) {
    ok("THE POINT: while locked, the correct PIN is refused too — no guess is checked");
  } else {
    bad(`the correct PIN answered ${withRightPin.status} while locked; guessing is not slowed`);
  }

  step("5. §10's manual sign-in shares the count, because it shares the PIN");
  const tabletToken = randomBytes(32).toString("base64url");
  const tabletHash = createHash("sha256").update(tabletToken).digest("hex");
  await sql`
    insert into tablets (tablet_id, name) values (${TABLET}, 'throttle test')
    on conflict (tablet_id) do nothing`;
  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, expires_at)
    values (${tabletHash}, 'TABLET', ${TABLET}, now() + interval '1 hour')`;
  tokenHashes.push(tabletHash);
  const manual = await call(
    "/api/v1/sessions/manual",
    { emp_code: CODE, pin: PIN, tablet_id: TABLET },
    { Authorization: "Bearer " + tabletToken },
  );
  if (manual.status === 429) ok("a locked code cannot open a session from the terminal either");
  else bad(`/sessions/manual answered ${manual.status} for a locked code`);

  step("6. the window slides, and the lock lifts on its own");
  await ageOut(CODE);
  const afterWindow = await login(PIN);
  if (afterWindow.status === 200) ok(`${WINDOW_MINUTES} minutes later the correct PIN works again`);
  else bad(`after the window the correct PIN answered ${afterWindow.status}`);

  step("7. a success clears that code's own near-misses");
  await ageOut(CODE);
  for (let i = 0; i < MAX_PER_CODE - 1; i++) await login("0000");
  const recovered = await login(PIN);
  if (recovered.status === 200) ok(`${MAX_PER_CODE - 1} wrong then right: still in`);
  else bad(`the correct PIN answered ${recovered.status} at ${MAX_PER_CODE - 1} failures`);
  const afterSuccess = await login("0000");
  if (afterSuccess.status === 401) {
    ok("and the count restarts from that success rather than from the window");
  } else {
    bad(`the first failure after a success answered ${afterSuccess.status}`);
  }

  step("8. spraying one guess at many codes is caught by the address, not the code");
  await ageOut(CODE);
  const sprayHeaders = { "x-forwarded-for": SPRAY_IP };
  for (let i = 0; i < MAX_PER_IP; i++) {
    const victim = `TEST-THR-${TAG}-${i}`;
    codes.push(victim);
    await call("/api/v1/auth/operator", { emp_code: victim, pin: "0000" }, sprayHeaders);
  }
  const freshCode = `TEST-THR-${TAG}-FRESH`;
  codes.push(freshCode);
  const sprayed = await call(
    "/api/v1/auth/operator",
    { emp_code: freshCode, pin: "0000" },
    sprayHeaders,
  );
  if (sprayed.status === 429) ok(`${MAX_PER_IP} failures from one address stops that address`);
  else bad(`attempt ${MAX_PER_IP + 1} from ${SPRAY_IP} answered ${sprayed.status}`);

  const elsewhere = await call(
    "/api/v1/auth/operator",
    { emp_code: freshCode, pin: "0000" },
    { "x-forwarded-for": OTHER_IP },
  );
  if (elsewhere.status === 401) ok("while a different address is unaffected");
  else bad(`a request from ${OTHER_IP} answered ${elsewhere.status}`);

  const stillIn = await login(PIN);
  if (stillIn.status === 200) {
    ok("and the storekeeper sprayed at from elsewhere can still sign in from the store");
  } else {
    bad(`the sprayed code answered ${stillIn.status} from an unrelated address`);
  }
} catch (e) {
  bad("threw: " + (e?.stack ?? e));
} finally {
  await sql`delete from auth_attempts where emp_code = any(${codes})`;
  await sql`delete from auth_attempts where client_ip in (${SPRAY_IP}, ${OTHER_IP})`;
  if (tokenHashes.length) await sql`delete from api_tokens where token_hash = any(${tokenHashes})`;
  await sql`delete from sessions where operator_id in (
              select id from operators where emp_code = any(${codes}))`;
  await sql`delete from operators where emp_code = any(${codes})`;
  await sql`delete from tablets where tablet_id = ${TABLET}`;
  await sql.end();

  console.log("\n" + "=".repeat(56));
  console.log(`${pass.length} passed, ${fail.length} failed`);
  if (fail.length) {
    for (const f of fail) console.log("  FAIL  " + f);
    process.exit(1);
  }
}
