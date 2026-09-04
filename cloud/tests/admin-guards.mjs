// The two rules §11 adds on the cloud side, neither of which had a test.
//
//   * **Deactivate, never delete.** Operators, machines and reason codes all
//     retire by `active = false`. Every one of them is pointed at by
//     `stock_ledger`, and §7's claim that the history still answers "who took
//     the forty inserts, on which machine, and why" survives exactly as long as
//     those rows do.
//
//   * **The last active ADMIN cannot be removed or demoted**, by either verb,
//     with the check inside the same transaction as the change. §11 says the
//     first admin cannot come from this API; without the guard the last one can
//     leave through it, and then nothing can create the person who would fix
//     that. A crib whose console nobody can open is not a recoverable state —
//     it needs a Rust toolchain and the database password to escape.
//
// This one rearranges who is an admin, so it snapshots every operator's role
// and active flag first and puts them back in `finally`, whatever happens.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/admin-guards.mjs

import { createHash, randomBytes } from "node:crypto";
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
  return { status: res.status, body };
}

const bearer = (t) => ({ Authorization: "Bearer " + t, "Content-Type": "application/json" });

let snapshot = [];
const created = [];

try {
  step("0. snapshot every operator, so this is undoable");
  snapshot = await sql`select id, role, active from operators`;
  const admins = snapshot.filter((o) => o.active && o.role === "ADMIN");
  if (admins.length === 0) {
    bad("no active ADMIN to work with");
    throw new Error("fixtures");
  }
  ok(snapshot.length + " operators, " + admins.length + " of them active admins");

  const theAdmin = admins[0];
  const adminToken = await mint(theAdmin.id);

  // Make theAdmin the only one, which is the state the guard is about.
  await sql`
    update operators set active = false
     where role = 'ADMIN' and active and id <> ${theAdmin.id}`;
  const [{ n: soleCheck }] = await sql`
    select count(*)::int as n from operators where active and role = 'ADMIN'`;
  if (soleCheck === 1) ok("exactly one active ADMIN for the rest of this run");
  else bad(soleCheck + " active admins, expected 1");

  step("1. the last ADMIN cannot leave by DELETE");
  const deleted = await call("/api/v1/admin/operators/" + theAdmin.id, {
    method: "DELETE",
    headers: bearer(adminToken),
  });
  if (deleted.status === 409 && deleted.body?.error === "LAST_ADMIN") {
    ok("409 LAST_ADMIN");
  } else {
    bad("DELETE answered " + deleted.status + " " + JSON.stringify(deleted.body));
  }
  let [row] = await sql`select active, role from operators where id = ${theAdmin.id}`;
  if (row.active && row.role === "ADMIN") ok("the transaction rolled back — still an active ADMIN");
  else bad("left as active=" + row.active + " role=" + row.role);

  step("2. nor by demotion");
  const demoted = await call("/api/v1/admin/operators/" + theAdmin.id, {
    method: "PATCH",
    headers: bearer(adminToken),
    body: JSON.stringify({ role: "OPERATOR" }),
  });
  if (demoted.status === 409 && demoted.body?.error === "LAST_ADMIN") ok("409 LAST_ADMIN");
  else bad("PATCH role answered " + demoted.status + " " + JSON.stringify(demoted.body));

  step("3. nor by being switched off");
  const off = await call("/api/v1/admin/operators/" + theAdmin.id, {
    method: "PATCH",
    headers: bearer(adminToken),
    body: JSON.stringify({ active: false }),
  });
  if (off.status === 409 && off.body?.error === "LAST_ADMIN") ok("409 LAST_ADMIN");
  else bad("PATCH active:false answered " + off.status + " " + JSON.stringify(off.body));

  [row] = await sql`select active, role from operators where id = ${theAdmin.id}`;
  if (row.active && row.role === "ADMIN") ok("three refusals later, the console is still reachable");
  else bad("left as active=" + row.active + " role=" + row.role);

  step("4. with a second admin, the first may go");
  const spare = await call("/api/v1/admin/operators", {
    method: "POST",
    headers: bearer(adminToken),
    body: JSON.stringify({
      emp_code: "ZZ-GUARD-" + randomBytes(3).toString("hex"),
      full_name: "Guard Test Admin",
      role: "ADMIN",
      pin: "9182",
    }),
  });
  if (spare.status === 200 || spare.status === 201) ok("a second ADMIN was created");
  else bad("creating a second admin answered " + spare.status + " " + JSON.stringify(spare.body));
  const spareId = spare.body?.id;
  if (spareId) created.push(spareId);

  const nowAllowed = await call("/api/v1/admin/operators/" + theAdmin.id, {
    method: "DELETE",
    headers: bearer(adminToken),
  });
  if (nowAllowed.status === 200) ok("the first admin retires once somebody else can administer");
  else bad("DELETE answered " + nowAllowed.status + " " + JSON.stringify(nowAllowed.body));

  step("5. deactivate, never delete (§7 needs the row)");
  [row] = await sql`select active from operators where id = ${theAdmin.id}`;
  if (row && row.active === false) ok("the operator row is still there, active = false");
  else bad("the operator row is " + JSON.stringify(row) + " — a ledger row points at it");

  step("6. a retired admin's token stops working immediately");
  const afterRetire = await call("/api/v1/admin/operators", { headers: bearer(adminToken) });
  if (afterRetire.status === 401 || afterRetire.status === 403) {
    ok("the revoked token is refused " + afterRetire.status);
  } else {
    bad("the retired admin's token still answered " + afterRetire.status);
  }

  step("7. machines and reason codes retire the same way");
  const spareToken = await mint(spareId);
  const [machine] = await sql`select id, code from machines where active order by code limit 1`;
  const retired = await call("/api/v1/admin/machines/" + machine.id, {
    method: "DELETE",
    headers: bearer(spareToken),
  });
  if (retired.status === 200) ok("machine " + machine.code + " retired");
  else bad("retiring a machine answered " + retired.status + " " + JSON.stringify(retired.body));
  const [stillThere] = await sql`select active from machines where id = ${machine.id}`;
  if (stillThere && stillThere.active === false) {
    ok("the machine row survives, so old ledger rows still name it");
  } else {
    bad("machine row is " + JSON.stringify(stillThere));
  }
  await sql`update machines set active = true where id = ${machine.id}`;

  step("8. a non-admin cannot reach any of this");
  const [operator] = await sql`
    select id from operators where active and role = 'OPERATOR' limit 1`;
  if (operator) {
    const operatorToken = await mint(operator.id);
    const refused = await call("/api/v1/admin/operators", { headers: bearer(operatorToken) });
    if (refused.status === 403) ok("an OPERATOR token is 403 on the admin API");
    else bad("an OPERATOR token answered " + refused.status);
  } else {
    bad("no active OPERATOR to check the role gate with");
  }
  step("9. the last-admin count is taken behind a lock, not merely in a transaction");
  // The guard used to be a count inside the transaction that made the change,
  // and the comment above it claimed that was enough against two admins
  // demoting each other. It is not: they touch two *different* rows, so nothing
  // conflicts, and at READ COMMITTED each counts the other as still active
  // until it commits. Both see one admin left, both commit, and the crib has
  // none. ADMIN_SET_LOCK is what makes the count exact.
  //
  // Only PATCH is driven over HTTP here. `db.ts` runs `max: 1`, so a second
  // request while the first is blocked would be waiting on the connection pool
  // rather than on the lock — an assertion that passes for the wrong reason.
  // Both verbs are checked directly in
  // `crates/store-server/tests/admin_console.rs`.
  const ADMIN_SET_LOCK = 0x454c454354; // "ELECT", the same number the route uses
  const holder = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, connect_timeout: 20 });
  try {
    // Both halves matter. `acquired` is what the first version of this step got
    // wrong: it fired the PATCH straight after calling begin(), before the
    // holding transaction had connected, so the route sailed through an
    // unlocked database and the step failed against correct code.
    let release;
    let acquired;
    const held = new Promise((resolve) => { release = resolve; });
    const locked = new Promise((resolve) => { acquired = resolve; });
    const holding = holder.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${ADMIN_SET_LOCK}::bigint)`;
      acquired();
      await held;
    });
    await locked;

    const patch = (signal) =>
      fetch(BASE + "/api/v1/admin/operators/" + spareId, {
        method: "PATCH",
        headers: bearer(spareToken),
        body: JSON.stringify({ department: "Lock Test" }),
        signal,
      });

    const blocked = await patch(AbortSignal.timeout(1500)).then(
      (res) => "answered " + res.status,
      (err) => (err?.name === "TimeoutError" || err?.name === "AbortError" ? "waited" : "threw " + err?.name),
    );
    if (blocked === "waited") ok("PATCH waits while the admin set is locked");
    else bad("PATCH did not wait for the lock: " + blocked);

    release();
    await holding;

    // The control. Without this the assertion above proves only that something
    // was slow, which a broken route can also be.
    const after = await patch(AbortSignal.timeout(10_000)).then(
      (res) => res.status,
      (err) => "threw " + err?.name,
    );
    if (after === 200) ok("and goes straight through once the lock is released");
    else bad("PATCH after release answered " + after);
  } finally {
    await holder.end({ timeout: 5 });
  }

} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  // Put every operator back exactly as it was, then remove what this test made.
  for (const o of snapshot) {
    await sql`
      update operators set role = ${o.role}, active = ${o.active} where id = ${o.id}`;
  }
  for (const id of created) {
    await sql`delete from api_tokens where operator_id = ${id}`;
    await sql`delete from operators where id = ${id}`;
  }
  if (minted.length) await sql`delete from api_tokens where token_hash = any(${minted})`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
