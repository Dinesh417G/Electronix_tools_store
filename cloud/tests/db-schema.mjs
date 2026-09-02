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
  // ── 5 and 6: the other half of the isolation, which is not the app's ──
  //
  // `DATABASE_SCHEMA` decides where the *application* writes. It says nothing
  // about where a trigger writes, and until 0011 the answer was "whichever
  // schema the caller's search_path happened to name first", because the §7
  // trigger bodies say `items` and `item_stock` with no schema on them.
  //
  // Two schemas holding the same rows is not a hypothetical here — it is
  // precisely what `preview` and `public` are.
  step("5. the eight §7 functions have a pinned search_path (0011)");
  const NAMES = [
    "set_updated_at",
    "stock_ledger_after_insert",
    "stock_ledger_is_append_only",
    "evaluate_alert_level",
    "sync_stock_alert",
    "items_after_insert",
    "items_after_reorder_level_change",
    "next_tool_serial",
  ];
  const unpinned = await admin`
    select p.proname
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = any(${NAMES}) and p.proconfig is null
     order by p.proname`;
  if (unpinned.length === 0) {
    ok("all eight resolve their tables in their own schema, whoever calls them");
  } else {
    bad("mutable search_path on: " + unpinned.map((r) => r.proname).join(", "));
  }

  step("6. and a write to public's ledger updates public's read model, not the caller's");
  const TWIN = "dbschema_twin";
  await admin.unsafe(`drop schema if exists ${TWIN} cascade`);
  await admin.unsafe(`create schema ${TWIN}`);
  for (const t of ["items", "item_stock", "stock_alerts"]) {
    await admin.unsafe(`create table ${TWIN}.${t} (like public.${t} including all)`);
  }

  // Rolled back, and it has to be: §7 refuses to delete a ledger row, and the
  // consumption test that runs after this one asserts an empty ledger.
  const ROLLBACK = Symbol("rollback");
  let landed = null;
  try {
    await admin.begin(async (tx) => {
      const code = "TWIN-" + Math.random().toString(36).slice(2, 8).toUpperCase();
      const [item] = await tx`
        insert into public.items (item_code, description, uom, reorder_level)
        values (${code}, 'search_path probe', 'NOS', 5) returning id`;
      const [op] = await tx`
        insert into public.operators (emp_code, full_name, role)
        values (${code}, 'search_path probe', 'ADMIN') returning id`;
      await tx.unsafe(
        `insert into ${TWIN}.items select * from public.items where id = '${item.id}'`,
      );
      await tx.unsafe(
        `insert into ${TWIN}.item_stock select * from public.item_stock where item_id = '${item.id}'`,
      );

      // The mistake the pin defends against: a session — psql, a script, the
      // Rust CLI — whose path names another schema first.
      await tx.unsafe(`set local search_path = ${TWIN}, public`);
      await tx`
        insert into public.stock_ledger (item_id, delta_qty, txn_type, operator_id)
        values (${item.id}, 7, 'OPENING', ${op.id})`;
      await tx.unsafe(`set local search_path = public`);

      const [mine] = await tx`
        select on_hand::text as on_hand from public.item_stock where item_id = ${item.id}`;
      const [theirs] = await tx.unsafe(
        `select on_hand::text as on_hand from ${TWIN}.item_stock where item_id = '${item.id}'`,
      );
      landed = { mine: mine?.on_hand, theirs: theirs?.on_hand };
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }

  if (landed?.mine === "7.000" && landed?.theirs === "0.000") {
    ok("public.item_stock 7.000, the other schema untouched");
  } else {
    bad(
      `the trigger followed the caller: public ${landed?.mine}, ` +
      `${TWIN} ${landed?.theirs} — a ledger and a read model in different schemas`,
    );
  }
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  try {
    await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`);
    await admin.unsafe(`drop schema if exists dbschema_twin cascade`);
    await admin.unsafe(`drop table if exists public.schema_probe`);
  } catch { /* nothing to clean */ }
  await admin.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
