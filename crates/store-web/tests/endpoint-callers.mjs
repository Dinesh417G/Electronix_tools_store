// §11's dead-wiring rule, enforced on the Rust side of the workspace.
//
//   > An endpoint with no screen is this project's known failure mode — built
//   > at both ends, never connected — so a new endpoint is not finished until
//   > something can call it.
//
// `cloud/tests/endpoint-callers.mjs` has enforced this for the deployed app
// since the cloud port. Nothing enforced it here, and it showed: ten console
// routes were added to `store-server` and `store-web` called none of them, so
// the reference implementation could serve a machine list that no screen asked
// for and no storekeeper could reach. `store-cli` — a Rust toolchain and the
// database password — was the only way to add a person.
//
// This reads the router and the client, and fails when they disagree in either
// direction:
//
//   * a route the server serves that nothing in `src/` names, and
//   * a path the client asks for that the router does not serve, which is the
//     typo you otherwise find at runtime as a 404 on a screen.
//
// What it proves is reachability, not correctness. A path found in `admin.ts`
// says the wiring exists; it does not say a screen calls that function, and
// §11 records exactly that limit — the passkey path spent the whole cloud port
// wired and unreachable behind a role gate. It is still the cheapest check that
// would have caught this one.
//
//   node tests/endpoint-callers.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = "../../store-server/src";
const CLIENT_DIR = "../src";

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };

/**
 * Every `.route("…", …)` the server declares, wherever it declares it.
 *
 * Reading one router file is not enough, and the first version of this check
 * did exactly that: `/api/v1/version` is registered in `web.rs`, not in
 * `api/mod.rs`, so the client's perfectly good call to it was reported as a
 * 404 waiting to happen. A check that cries wolf gets switched off.
 *
 * A path already starting `/api/` is absolute; anything else is relative to
 * the `.nest("/api/v1", …)` its own file declares. Taking the prefix from the
 * file rather than assuming one means moving the mount point fails here loudly
 * instead of passing everything silently.
 */
function routes() {
  const found = new Set();
  for (const file of sources(fileURLToPath(new URL(SERVER_DIR, import.meta.url)), [], /\.rs$/)) {
    const src = readFileSync(file, "utf8");
    const prefix = /\.nest\(\s*"([^"]+)"/.exec(src)?.[1] ?? "";
    for (const m of src.matchAll(/\.route\(\s*"([^"]+)"/g)) {
      found.add(m[1].startsWith("/api/") ? m[1] : prefix + m[1]);
    }
  }
  return [...found];
}

/** Every source file under `src/`, excluding the screens' own test doubles. */
function sources(dir, acc = [], match = /\.(ts|tsx)$/) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, acc, match);
    else if (match.test(entry)) acc.push(path);
  }
  return acc;
}

const files = sources(fileURLToPath(new URL(CLIENT_DIR, import.meta.url)));
const client = files.map((f) => readFileSync(f, "utf8")).join("\n");

/**
 * A route path with its parameters blanked, so `/items/{id}` and the client's
 * `/items/${id}` compare equal. Axum writes `{id}`; a template literal writes
 * `${…}`; both become `*`.
 */
const shape = (path) =>
  // ${…} first: blanking {…} first would leave the dollar behind and every
  // parameterised path would compare as "/items/$*".
  path.replace(/\$\{[^}]*\}/g, "*").replace(/\{[^}]*\}/g, "*").replace(/\/+$/, "");

/**
 * Endpoints this client is not expected to call, each with the reason.
 *
 * An allowlist is how a tripwire like this stays useful: without one it is red
 * from the day it lands and somebody deletes it. Every entry has to be a
 * decision, not a shrug — adding a line here is the moment to ask whether the
 * endpoint has a screen it should have had, which is what put the Setup and
 * Reports tabs beside this file.
 */
const NOT_A_SCREEN = new Map([
  ["/api/v1/health", "the liveness probe an installer curls, not a screen"],
  [
    "/api/v1/items/*",
    "read one item by id. The terminal reaches items by scan and by search, and the console holds the row it is editing already",
  ],
  [
    "/api/v1/sessions/*",
    "read one session. The claim response carries it, and the terminal follows the SSE stream from there",
  ],
]);

const served = new Set(
  routes()
    .map(shape)
    // The SPA fallback (`""`, `"/*"`) serves the bundle this file lives in.
    .filter((r) => r.startsWith("/api/")),
);
if (served.size === 0) {
  bad("no routes parsed out of the router — this check would pass vacuously");
}

// Every path literal the client asks for. Template literals included, since
// that is how every parameterised call is written.
const asked = new Set();
for (const m of client.matchAll(/["'`](\/api\/v1\/[^"'`]*)["'`]/g)) {
  asked.add(shape(m[1].split("?")[0]));
}

const unreachable = [...served]
  .filter((r) => !asked.has(r) && !NOT_A_SCREEN.has(r))
  .sort();

// An allowlist that outlives the route it excuses is a lie the next reader
// inherits, so it is checked in both directions.
const stale = [...NOT_A_SCREEN.keys()].filter((r) => !served.has(r)).sort();
if (stale.length === 0) {
  ok(`the ${NOT_A_SCREEN.size} allowlisted endpoints all still exist`);
} else {
  bad(`allowlisted routes the server no longer serves: ${stale.join(", ")}`);
}
const unserved = [...asked].filter((a) => !served.has(a)).sort();

if (served.size > 0) {
  ok(`${served.size} routes on the server, ${asked.size} paths in the client`);
}

if (unreachable.length === 0) {
  ok("every route the server serves is named somewhere in src/");
} else {
  bad(
    "routes nothing in src/ asks for — built at both ends, connected at " +
      `neither:\n          ${unreachable.join("\n          ")}`,
  );
}

if (unserved.length === 0) {
  ok("every path the client asks for is served");
} else {
  bad(
    "the client asks for paths the router does not serve — a 404 waiting on a " +
      `screen:\n          ${unserved.join("\n          ")}`,
  );
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
