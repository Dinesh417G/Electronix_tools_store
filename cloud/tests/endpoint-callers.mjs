// Does anything actually call it?
//
// CLAUDE.md §11: "An endpoint with no screen is this project's known failure
// mode — built at both ends, never connected — so a new endpoint is not
// finished until something can call it." That sentence has been in the spec
// for weeks with nothing enforcing it, and the project has already paid for it
// twice: `seed --demo-operators` was dead on every machine, and §10's manual
// sign-in was refused by a constraint for as long as it existed, because
// nothing drove either.
//
// So: every route file's path, for every method it exports, must appear in
// something that is not itself a route — the browser client (`src/lib`), a
// screen, a script, or a test. This proves *reachability*, not correctness: a
// path found in `api.ts` says the wiring exists, not that a screen calls that
// function. It is the cheapest check that would have caught the two above.
//
// No database and no server: this reads the repository.
//
//   node tests/endpoint-callers.mjs

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (n) => console.log("\n" + n);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/**
 * Route paths carry `[id]`; callers carry `${sessionId}` or `${item.id}`.
 * Both collapse to the same placeholder so they can be compared at all.
 */
const normalise = (p) =>
  p
    .replace(/\$\{[^}]*\}/g, "*")
    .replace(/\[[^\]]+\]/g, "*")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");

async function routes(dir, prefix, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await routes(full, `${prefix}/${entry.name}`, found);
    } else if (entry.name === "route.ts") {
      const src = await readFile(full, "utf8");
      const methods = METHODS.filter((m) =>
        new RegExp(`export (const|async function) ${m}\\b`).test(src),
      );
      found.push({ path: prefix, methods, file: full });
    }
  }
  return found;
}

/** Every file that could plausibly call the API, which is everything but the API. */
async function callerFiles(dir, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const posix = full.split("\\").join("/");
    if (posix.includes("src/app/api") || posix.includes("src/app/iclock")) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      await callerFiles(full, found);
    } else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry.name)) {
      // Not this file. It quotes paths in order to reason about them, and a
      // check that counts its own prose as a caller cannot fail.
      if (entry.name === "endpoint-callers.mjs") continue;
      found.push(full);
    }
  }
  return found;
}

try {
  step("0. what exists, and what could be calling it");
  const api = await routes("src/app/api", "/api");
  const iclock = await routes("src/app/iclock", "/iclock");
  const all = [...api, ...iclock];

  const files = [
    ...(await callerFiles("src")),
    ...(await callerFiles("tests")),
    ...(await callerFiles("scripts")),
  ];
  ok(`${all.length} route files, ${files.length} files that might call them`);

  // Every API-looking path mentioned anywhere outside the routes themselves.
  const mentioned = new Map();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const m of text.matchAll(/["'`](\/(?:api\/v1|iclock)[^"'`\s]*)["'`]/g)) {
      // A literal `*` in the source is a glob naming a family, not a call:
      // `adms.ts` documents itself as serving `/iclock/*`.
      if (m[1].includes("*")) continue;
      const key = normalise(m[1]);
      if (!mentioned.has(key)) mentioned.set(key, new Set());
      mentioned.get(key).add(file.split("\\").join("/"));
    }
  }
  ok(`${mentioned.size} distinct API paths are referenced outside the route files`);

  step("1. no route has a method it exports and nobody reaches");
  const orphans = [];
  for (const route of all) {
    if (route.methods.length === 0) {
      // /iclock's handlers are written as plain exported functions in some
      // files; if the regex found none, say so rather than passing silently.
      orphans.push(`${route.path} — no exported method found in ${route.file}`);
      continue;
    }
    const key = normalise(route.path);
    if (!mentioned.has(key)) {
      orphans.push(`${route.path} (${route.methods.join(", ")}) — referenced nowhere`);
    }
  }
  if (orphans.length === 0) {
    ok(`all ${all.length} routes are referenced by a client, a script or a test`);
  } else {
    for (const o of orphans) bad(o);
  }

  step("2. and nothing references a path that is not served");
  const served = new Set(all.map((r) => normalise(r.path)));
  const dangling = [...mentioned.keys()].filter((p) => {
    if (served.has(p)) return false;
    // A caller may hold a prefix it appends to — `/api/v1/items` + `/${id}`.
    return ![...served].some((s) => s.startsWith(p + "/") || p.startsWith(s + "/"));
  });
  if (dangling.length === 0) {
    ok("every path referenced in the client, the scripts and the tests is served");
  } else {
    for (const d of dangling) {
      bad(`${d} is called from ${[...mentioned.get(d)].join(", ")} but no route serves it`);
    }
  }

  step("3. the check can tell the difference, on a path that does not exist");
  // Non-vacuity: if the matcher answered "referenced" for anything, the two
  // assertions above would pass on an empty repository.
  // Built by concatenation so the literal never appears in this file, which
  // would otherwise make it "referenced" by the scan above.
  const bogus = normalise(["/api", "v1", "definitely", "not", "a", "route"].join("/"));
  if (!mentioned.has(bogus) && !served.has(bogus)) {
    ok("a made-up path is neither served nor referenced, so the sets are real");
  } else {
    bad("the matcher claims a made-up path exists — the comparison is broken");
  }
} catch (e) {
  bad("threw: " + (e?.stack ?? e));
} finally {
  console.log("\n" + "=".repeat(56));
  console.log(`${pass.length} passed, ${fail.length} failed`);
  if (fail.length) {
    for (const f of fail) console.log("  FAIL  " + f);
    process.exit(1);
  }
}
