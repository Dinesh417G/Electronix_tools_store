// Paging, which two lists claimed to do and one of them did not.
//
// `/api/v1/stock` accepted `offset` in the sense that it did not complain: it
// read `limit`, ignored `offset`, and answered the first page every time. The
// terminal's browse-all had been sending one since the day it was written, so
// every "Load more" appended the same forty rows again — duplicated items, and
// a button that could never retire, because a full page always came back and
// `page.length < PAGE` was never true.
//
// Nothing caught it. `route-smoke.mjs` asks each GET route once and checks it
// is not 5xx, which a wrong-but-cheerful answer passes. `endpoint-callers.mjs`
// proves `/items/browse` has a caller — `api.browse` names the path — and that
// is true; no screen called it, which is the half that check says out loud it
// cannot see. A parameter the server silently drops is invisible from both
// ends.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/list-paging.mjs

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

let tokenHash = null;

try {
  const [operator] = await sql`select id from operators where active limit 1`;
  if (!operator) throw new Error("no active operator to authenticate as");

  const token = randomBytes(32).toString("base64url");
  tokenHash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, operator_id, expires_at)
    values (${tokenHash}, 'OPERATOR', ${operator.id}, now() + interval '1 hour')`;

  const codes = async (path) => {
    const res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error(path + " answered " + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error(path + " did not answer a list");
    return rows.map((r) => r.item_code);
  };

  const [{ n: active }] = await sql`
    select count(*)::int as n from items where active`;
  if (active < 12) {
    bad("needs at least 12 active items to page through, found " + active);
    throw new Error("catalog too small to test paging");
  }

  // Both list endpoints, held to the same rule. `/stock` is what the console
  // and the live view read; `/items/browse` is what the terminal reads.
  for (const [name, path] of [
    ["/api/v1/stock", "/api/v1/stock?limit="],
    ["/api/v1/items/browse", "/api/v1/items/browse?limit="],
  ]) {
    step(name + " pages, rather than answering page one to every question");

    const first = await codes(path + "5&offset=0");
    const second = await codes(path + "5&offset=5");
    const both = await codes(path + "10&offset=0");

    if (first.length === 5 && second.length === 5) ok("two full pages of 5");
    else bad("got " + first.length + " and " + second.length + " rows");

    if (first.join() !== second.join()) ok("the second page is not the first again");
    else bad("offset was ignored — both pages are " + first.join(" "));

    const overlap = first.filter((c) => second.includes(c));
    if (overlap.length === 0) ok("no item appears on both pages");
    else bad("repeated across pages: " + overlap.join(" "));

    // The one that pins it to the *order*, not merely to being different: page
    // two must be rows 6–10 of the same ordering, or "offset" means something
    // of its own invention.
    if (both.join() === first.concat(second).join()) {
      ok("page 1 + page 2 is exactly the first 10 in order");
    } else {
      bad("limit=10 gave [" + both.join(" ") + "], the two pages gave [" +
        first.concat(second).join(" ") + "]");
    }

    // Past the end is an empty list, not the first page — this is what stops
    // the terminal's "Load more" running forever.
    const past = await codes(path + "5&offset=" + (active + 50));
    if (past.length === 0) ok("an offset past the end is empty, so paging terminates");
    else bad("offset past the end answered " + past.length + " rows: " + past.join(" "));
  }
} catch (err) {
  bad("threw: " + (err?.message ?? err));
} finally {
  if (tokenHash) await sql`delete from api_tokens where token_hash = ${tokenHash}`;
  await sql.end({ timeout: 5 });
}

console.log("\n" + "=".repeat(56));
console.log(pass.length + " passed, " + fail.length + " failed");
process.exit(fail.length ? 1 : 0);
