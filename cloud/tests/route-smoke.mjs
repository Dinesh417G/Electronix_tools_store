// Every GET route, asked once, against a real database.
//
// §14 names the gap this closes: "`typecheck` cannot see the database, so a
// column rename passes CI and fails at runtime anywhere these paths do not
// go." The other tests here drive the *loop* — punch, claim, issue, report —
// and that loop is a handful of the twenty-six reads this API serves. Rename a
// column that only `/reports/machines` selects and every test stays green
// until somebody opens that screen.
//
// So this test is deliberately shallow and total. It asks nothing about what a
// route returns; it asserts that asking does not raise a 500, which is what a
// missing column, a renamed one, a broken join or a bad cast all look like from
// outside. Postgres says `42703 column … does not exist`, our handler turns
// anything unrecognised into a 500, and this is the only test that would see
// it.
//
// The second half is a tripwire: **every GET route must be listed here.** A new
// one that nobody added fails this test by name. That is aimed straight at this
// project's known failure mode — an endpoint built at both ends and never
// connected to anything (CLAUDE.md §11: "an endpoint with no screen is this
// project's known failure mode").
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/route-smoke.mjs

import { createHash, randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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

const INSIGHT_VIEWS = ["newest", "high", "low", "stale", "frequent", "recent"];
const GROUP_BY = ["item", "machine", "operator", "category", "month"];

const TAG = randomBytes(3).toString("hex").toUpperCase();
const TABLET = `smoke-${TAG.toLowerCase()}`;

const tokenHashes = [];
const createdSerials = [];
const createdSessions = [];

async function mint(kind, { operatorId = null, tabletId = null } = {}) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, operator_id, tablet_id, expires_at)
    values (${hash}, ${kind}, ${operatorId}, ${tabletId}, now() + interval '1 hour')`;
  tokenHashes.push(hash);
  return token;
}

/**
 * Walks the route tree and returns every path that exports a GET.
 *
 * The point of reading the filesystem rather than a hand-written list is that
 * the list cannot then be quietly incomplete.
 */
async function discoverGetRoutes(dir = "src/app/api", prefix = "/api") {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await discoverGetRoutes(full, `${prefix}/${entry.name}`)));
    } else if (entry.name === "route.ts") {
      const src = await readFile(full, "utf8");
      if (/export const GET\b/.test(src) || /export async function GET\b/.test(src)) {
        found.push(prefix);
      }
    }
  }
  return found;
}

try {
  step("0. fixtures — a token per identity, and one row of everything asked for by id");

  const [admin] = await sql`
    select id from operators where role = 'ADMIN' and active and pin_hash is not null
     order by emp_code limit 1`;
  if (!admin) throw new Error("no active ADMIN — run the operator bootstrap first");
  const adminToken = await mint("OPERATOR", { operatorId: admin.id });

  await sql`
    insert into tablets (tablet_id, name) values (${TABLET}, 'route smoke')
    on conflict (tablet_id) do nothing`;
  const tabletToken = await mint("TABLET", { tabletId: TABLET });
  ok("minted an ADMIN token and a tablet token");

  const [item] = await sql`select id, item_code from items where active order by item_code limit 1`;
  if (!item) throw new Error("no active items — seed the catalog first");

  // A serial and a session, because five routes take one in the path and a 404
  // would prove nothing about the SQL behind them. Both are removed in
  // `finally`; neither is a ledger row, so §7 does not make them permanent.
  const [serial] = await sql`
    insert into tool_serials (item_id, serial_no, status)
    values (${item.id}, ${"SMOKE-" + TAG}, 'ACTIVE')
    returning id`;
  createdSerials.push(serial.id);

  const [session] = await sql`
    insert into sessions (operator_id, punch_id, state, manual_identity,
                          identity_source, tablet_id, claimed_at, last_activity_at)
    values (${admin.id}, null, 'ACTIVE', true, 'PIN', ${TABLET}, now(), now())
    returning id`;
  createdSessions.push(session.id);
  ok(`item ${item.item_code}, one serial, one session`);

  // ── The list. Every GET route, with parameters real enough to reach SQL ──
  //
  // A 400 from a missing parameter is a route that never touched the database,
  // and that is exactly the false green this test exists to avoid — so each
  // entry carries whatever the route needs to get past its own validation.
  const requests = [
    ["/api/v1/version", null],
    ["/api/v1/admin/categories", "admin"],
    ["/api/v1/admin/devices", "admin"],
    ["/api/v1/admin/health", "admin"],
    ["/api/v1/admin/items?q=&limit=5", "admin"],
    ["/api/v1/admin/machines", "admin"],
    ["/api/v1/admin/operators", "admin"],
    ["/api/v1/admin/printer", "admin"],
    ["/api/v1/admin/reason-codes", "admin"],
    ["/api/v1/alerts", "tablet"],
    ["/api/v1/alerts/summary", "tablet"],
    ["/api/v1/auth/webauthn/credentials", "admin"],
    [`/api/v1/items/${item.id}`, "tablet"],
    [`/api/v1/items/${item.id}/serials`, "admin"],
    ["/api/v1/items/browse?offset=0&limit=5", "tablet"],
    ...INSIGHT_VIEWS.map((v) => [`/api/v1/items/insights?view=${v}&limit=5`, "tablet"]),
    [`/api/v1/items/lookup?barcode=${encodeURIComponent(item.item_code)}`, "tablet"],
    ["/api/v1/items/search?q=a", "tablet"],
    [`/api/v1/labels/sheet?item_ids=${item.id}&copies=1`, "admin"],
    ["/api/v1/ledger?limit=5", "tablet"],
    ["/api/v1/machines", "tablet"],
    ["/api/v1/punches/unknown", "admin"],
    ["/api/v1/reason-codes", "tablet"],
    ...GROUP_BY.map((g) => [`/api/v1/reports/consumption?group_by=${g}`, "admin"]),
    ...GROUP_BY.map((g) => [`/api/v1/reports/consumption.csv?group_by=${g}`, "admin"]),
    ["/api/v1/reports/machines?days=30", "admin"],
    ["/api/v1/reports/operators?days=30", "admin"],
    [`/api/v1/serials/${serial.id}`, "admin"],
    [`/api/v1/sessions/${session.id}`, "tablet"],
    ["/api/v1/sessions/unclaimed", "tablet"],
    ["/api/v1/stock?limit=5", "tablet"],
    // The idle screen's own read. `since` is the tablet's local midnight; the
    // route clamps anything older than 48 h, so a fixed literal here would
    // silently fall back to its default and stop testing the parameter.
    [`/api/v1/terminal/status?since=${encodeURIComponent(new Date(Date.now() - 3600e3).toISOString())}`, "tablet"],
  ];

  const headers = {
    admin: { Authorization: "Bearer " + adminToken },
    tablet: { Authorization: "Bearer " + tabletToken },
  };

  step(`1. ${requests.length} GET requests, none of which may answer 5xx`);
  const serverErrors = [];
  const slow = [];
  for (const [path, who] of requests) {
    const started = Date.now();
    let status;
    let body;
    try {
      const res = await fetch(BASE + path, { headers: who ? headers[who] : {} });
      status = res.status;
      body = (await res.text()).slice(0, 300);
    } catch (e) {
      status = 0;
      body = String(e);
    }
    const ms = Date.now() - started;
    if (status >= 500 || status === 0) serverErrors.push(`${path} → ${status} ${body}`);
    // Not asserted: one slow read on a laptop proves nothing. Reported,
    // because a route that got 40× slower is worth a human look.
    if (ms > 2000) slow.push(`${path} → ${ms} ms`);
  }
  if (serverErrors.length === 0) {
    ok(`all ${requests.length} answered below 500 — no route is sitting on broken SQL`);
  } else {
    for (const e of serverErrors) bad(e);
  }
  if (slow.length > 0) console.log("  (slow, not asserted) " + slow.join("; "));

  step("2. and no GET route is missing from the list above");
  // Path params are written as [id] on disk; the list holds real ids, so the
  // comparison is done on the shape.
  const asked = new Set(
    requests.map(([p]) =>
      p
        .split("?")[0]
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "/[id]"),
    ),
  );
  const onDisk = await discoverGetRoutes();
  const missing = onDisk.filter((p) => !asked.has(p));
  const stale = [...asked].filter((p) => !onDisk.includes(p));

  if (missing.length === 0) {
    ok(`every one of the ${onDisk.length} GET routes on disk is exercised`);
  } else {
    bad(
      `${missing.length} GET route(s) exist and are asked by nothing here: ` +
      missing.join(", ") +
      " — add them, or say in a comment why they cannot be asked",
    );
  }
  if (stale.length === 0) {
    ok("and nothing in the list points at a route that no longer exists");
  } else {
    bad("the list asks for routes that are not on disk: " + stale.join(", "));
  }

  step("3. an unauthenticated read is still refused, so the above proved something");
  const naked = await fetch(BASE + "/api/v1/stock?limit=1");
  if (naked.status === 401) ok("GET /stock without a token → 401");
  else bad(`GET /stock without a token → ${naked.status}, expected 401`);
} catch (e) {
  bad("threw: " + (e?.stack ?? e));
} finally {
  if (createdSessions.length) {
    await sql`delete from sessions where id = any(${createdSessions}::uuid[])`;
  }
  if (createdSerials.length) {
    await sql`delete from print_jobs where serial_id = any(${createdSerials}::uuid[])`;
    await sql`delete from tool_serials where id = any(${createdSerials}::uuid[])`;
  }
  if (tokenHashes.length) await sql`delete from api_tokens where token_hash = any(${tokenHashes})`;
  await sql`delete from tablets where tablet_id = ${TABLET}`;
  await sql.end();

  console.log("\n" + "=".repeat(56));
  console.log(`${pass.length} passed, ${fail.length} failed`);
  if (fail.length) {
    for (const f of fail) console.log("  FAIL  " + f);
    process.exit(1);
  }
}
