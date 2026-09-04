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
// It also covers the two things paging made possible, both of which are only
// honest if the server does them: `X-Total-Count`, so a capped list can say
// what it is a cap *of*, and `sort`/`dir`, so a column header orders the whole
// table rather than reordering the page that happened to arrive. A header that
// sorted sixty of four thousand rows while looking like a ranking of all of
// them is the reason the console went without one for so long.
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

  const page = async (path) => {
    const res = await fetch(BASE + path, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error(path + " answered " + res.status);
    const rows = await res.json();
    const header = res.headers.get("X-Total-Count");
    return { rows, total: header === null ? null : Number.parseInt(header, 10) };
  };

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

  step("the count is of what matched, not of what came back");
  {
    const [{ items }] = await sql`select count(*)::int as items from items where active`;
    const [{ movements }] = await sql`select count(*)::int as movements from stock_ledger`;

    const stock = await page("/api/v1/stock?limit=3");
    if (stock.total === items) ok("/stock counts every active item (" + items + ")");
    else bad("/stock said " + stock.total + ", the database says " + items);
    if (stock.rows.length === 3) ok("and still returns only the page asked for");
    else bad("returned " + stock.rows.length + " rows");

    const ledger = await page("/api/v1/ledger?limit=3");
    if (ledger.total === movements) ok("/ledger counts every movement (" + movements + ")");
    else bad("/ledger said " + ledger.total + ", the database says " + movements);

    const browse = await page("/api/v1/items/browse?limit=3");
    if (browse.total === items) ok("/items/browse counts the same catalog");
    else bad("/items/browse said " + browse.total + ", expected " + items);

    // The count has to answer the *filtered* question. A total that ignores the
    // filter turns "12 of 90" into a sentence about a list nobody is looking at.
    const [{ empties }] = await sql`
      select count(*)::int as empties
        from items i left join item_stock s on s.item_id = i.id
       where i.active and coalesce(s.alert_state, 'OK') = 'EMPTY'`;
    const filtered = await page("/api/v1/stock?empty=true&limit=1");
    if (filtered.total === empties) ok("a filtered list counts the filtered set (" + empties + ")");
    else bad("empty=true counted " + filtered.total + ", the database says " + empties);
  }

  step("sorting is done by the server, over the whole table");
  {
    // Both ends compared against the *database*, not against another call to
    // the same endpoint. The first version asked `/stock` for the whole list
    // and checked its own first row against it, which a build that ignored
    // `sort` altogether satisfied trivially — both sides came back in the
    // default order. Checked by mutation: with `sort` hardcoded to the default,
    // that assertion passed and only the descending one failed.
    //
    // A single row is enough to prove the ordering is the server's: the answer
    // has to be the extreme of the whole catalog, and no client-side sort of
    // one row can produce it.
    const [{ lowest, highest }] = await sql`
      select min(item_code) as lowest, max(item_code) as highest
        from items where active`;
    const firstAsc = await codes("/api/v1/stock?limit=1&sort=code&dir=asc");
    const firstDesc = await codes("/api/v1/stock?limit=1&sort=code&dir=desc");

    if (firstAsc[0] === lowest) ok("ascending starts at the catalog's first code, " + lowest);
    else bad("asc gave " + firstAsc[0] + ", the database's lowest is " + lowest);

    if (firstDesc[0] === highest) ok("descending starts at its last, " + highest);
    else bad("desc gave " + firstDesc[0] + ", the database's highest is " + highest);

    const byQty = await page("/api/v1/stock?limit=5&sort=on_hand&dir=desc");
    const quantities = byQty.rows.map((r) => Number(r.on_hand));
    const ordered = quantities.every((q, i) => i === 0 || quantities[i - 1] >= q);
    if (ordered) ok("on_hand descending is actually descending: " + quantities.join(" ≥ "));
    else bad("on_hand desc came back " + quantities.join(" "));

    // An unknown column falls back to the default rather than 400: a bookmarked
    // URL from an older build should still answer, in a defined order.
    const nonsense = await codes("/api/v1/stock?limit=5&sort=' or 1=1 --");
    const fallback = await codes("/api/v1/stock?limit=5");
    if (nonsense.join() === fallback.join()) ok("an unknown sort falls back to the default");
    else bad("sort=nonsense reordered the list: " + nonsense.join(" "));

    const ledgerAsc = await page("/api/v1/ledger?limit=1&sort=time&dir=asc");
    const ledgerDesc = await page("/api/v1/ledger?limit=1&sort=time&dir=desc");
    const [{ oldest, newest }] = await sql`
      select min(id)::text as oldest, max(id)::text as newest from stock_ledger`;
    if (ledgerAsc.rows[0]?.id === oldest) ok("the ledger's oldest movement is row 1 ascending");
    else bad("asc gave id " + ledgerAsc.rows[0]?.id + ", the oldest is " + oldest);
    if (ledgerDesc.rows[0]?.id === newest) ok("and the newest is row 1 descending, the default");
    else bad("desc gave id " + ledgerDesc.rows[0]?.id + ", the newest is " + newest);
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
