// Which schema a deployment writes to, and the proof that it is not public.
//
// The free Supabase tier allows two active projects and both are spoken for,
// so Preview deployments cannot have a database of their own. They get a
// `preview` schema inside the production project instead, carrying the same
// migrations, reached by `DATABASE_SCHEMA=preview` — which `db.ts` turns into
// a `search_path` startup parameter on the connection.
//
// That makes one environment variable the whole of the isolation between a
// throwaway preview and the real crib's ledger. §7 says a movement is never
// deleted, so a preview that wrote into `public` could not be tidied up
// afterwards: the rows would be there for good, in the audit trail the product
// exists to defend. This test is what stands behind that variable.
//
// It fails on the db.ts that has no DATABASE_SCHEMA support: without the
// search_path parameter every case below lands in `public`, and the third one
// says so.
//
//   DATABASE_URL=… node --experimental-strip-types tests/db-schema.mjs

import postgres from "postgres";

const URL = process.env.DATABASE_URL;
if (!URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (n) => console.log("\n" + n);

// A scratch schema, so this never depends on `preview` existing in whatever
// database CI happens to point at.
const SCHEMA = "dbschema_probe";

// `db.ts` caches its client on globalThis and reads the environment once, when
// it connects. Every case here is a different environment, so each one drops
// the cached client first — otherwise the second case silently measures the
// first one's connection.
async function withEnv(env, fn) {
  const before = {
    DATABASE_SCHEMA: process.env.DATABASE_SCHEMA,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  globalThis.__toolCribSql = undefined;
  const { sql } = await import("../src/lib/db.ts");
  try {
    return await fn(sql);
  } finally {
    try { await sql.end({ timeout: 5 }); } catch { /* already closed */ }
    globalThis.__toolCribSql = undefined;
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const admin = postgres(URL, { prepare: false, max: 1, onnotice: () => {} });

try {
  step("0. a scratch schema with a table that also exists in public");
  await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await admin.unsafe(`create schema ${SCHEMA}`);
  await admin.unsafe(`create table ${SCHEMA}.schema_probe (marker text primary key)`);
  await admin.unsafe(`drop table if exists public.schema_probe`);
  await admin.unsafe(`create table public.schema_probe (marker text primary key)`);
  ok(`${SCHEMA}.schema_probe and public.schema_probe both exist`);

  step("1. DATABASE_SCHEMA unset — production, unchanged");
  await withEnv({ DATABASE_SCHEMA: undefined }, async (sql) => {
    const [row] = await sql`select current_schema() as schema`;
    if (row.schema === "public") ok("current_schema() is public");
    else bad(`current_schema() is ${row.schema}, expected public`);
  });

  step("2. a name that is not an identifier is refused, not sent");
  for (const bogus of ["preview; drop schema public cascade", "Preview", "1preview"]) {
    await withEnv({ DATABASE_SCHEMA: bogus }, async (sql) => {
      try {
        await sql`select 1`;
        bad(`accepted DATABASE_SCHEMA=${JSON.stringify(bogus)}`);
      } catch (err) {
        if (String(err?.message).includes("DATABASE_SCHEMA")) {
          ok(`refused DATABASE_SCHEMA=${JSON.stringify(bogus)}`);
        } else {
          bad(`refused ${JSON.stringify(bogus)} for the wrong reason: ${err?.message}`);
        }
      }
    });
  }

  step("3. DATABASE_SCHEMA set — reads and writes land there, not in public");
  await withEnv({ DATABASE_SCHEMA: SCHEMA }, async (sql) => {
    const [row] = await sql`select current_schema() as schema`;
    if (row.schema === SCHEMA) ok(`current_schema() is ${SCHEMA}`);
    else bad(`current_schema() is ${row.schema}, expected ${SCHEMA}`);

    // Unqualified, exactly as every query in src/lib is written.
    await sql`insert into schema_probe (marker) values ('written-by-the-app')`;
    const [there] = await sql`select count(*)::int as n from schema_probe`;
    if (there.n === 1) ok("an unqualified insert is visible to an unqualified read");
    else bad(`${there.n} rows in the scratch schema, expected 1`);
  });

  const [scratch] = await admin.unsafe(`select count(*)::int as n from ${SCHEMA}.schema_probe`);
  const [pub] = await admin.unsafe(`select count(*)::int as n from public.schema_probe`);
  if (scratch.n === 1) ok(`the row is in ${SCHEMA}`);
  else bad(`${scratch.n} rows in ${SCHEMA}, expected 1`);
  if (pub.n === 0) ok("public was not written to at all");
  else bad(`${pub.n} rows landed in public — the isolation does not hold`);

  step("4. extensions stay reachable, so the catalog's trigram indexes work");
  await withEnv({ DATABASE_SCHEMA: SCHEMA }, async (sql) => {
    try {
      const [row] = await sql`select similarity('cnmg120408', 'cnmg 1204') as s`;
      if (Number(row.s) > 0) ok("pg_trgm's similarity() resolves on the preview path");
      else bad("similarity() returned " + row.s);
    } catch (err) {
      bad("pg_trgm unreachable with DATABASE_SCHEMA set: " + err?.message);
    }
  });
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  try {
    await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await admin.unsafe(`drop table if exists public.schema_probe`);
  } catch { /* nothing to clean */ }
  await admin.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
