// Measure the deployed system against the budgets CLAUDE.md sets for it.
//
// §13 names this as what remains: the e2e test proves the code and the schema,
// but runs against a local `next start`. Cold starts, Supavisor and the
// internet are all absent there — which is exactly where §9's ~200 ms ADMS
// budget is at risk, because a device that does not get `OK: <n>` fast enough
// retries and duplicates the batch.
//
//   §9.2   the ADMS handler must answer in ~200 ms
//   §11    /items/lookup must answer in under 100 ms
//   §4     the live view polls every 2 s, so /sessions/unclaimed is on a
//          hot path whenever a claim screen is open
//
// Two modes, and the difference matters because the target is production:
//
//   default    READ ONLY. Nothing is written. Every request is a GET, and the
//              ADMS handshake is the device's own read-only boot call.
//   --write    Adds one real ATTLOG push, which is the request §9's budget is
//              actually about, and checks the acknowledgement is exactly
//              `OK: 1`. It leaves a punch row and an offered session behind;
//              that session expires unclaimed after 90 s (§10). It does not
//              claim or issue — the e2e test covers that path, and driving it
//              here would put ledger rows in production that §7 makes
//              permanent.
//
// What this does NOT answer: whether a real ZK terminal can reach the
// deployment at all (§3's outbound route), or whether its firmware agrees with
// §9's parameter names. Only the capture against real hardware settles those.
//
// Usage — DATABASE_URL is needed to mint a tablet token, because enrolment
// needs STORE_ENROLMENT_SECRET and that is stored Sensitive on Vercel and
// cannot be read back:
//
//   DATABASE_URL=… npm run probe -- --base https://electronix-tool-crib.vercel.app
//   DATABASE_URL=… npm run probe -- --base https://…  --write
//
// The connection string is a credential. Pass it in the environment, never as
// an argument — an argument lands in the process list and in shell history.

import { createHash, randomBytes, randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? undefined : argv[i + 1];
};

const BASE = (arg("base") ?? process.env.STORE_BASE ?? "").replace(/\/$/, "");
const WRITE = argv.includes("--write");
const ROUNDS = Number(arg("rounds") ?? 5);

if (!BASE) {
  console.error("--base https://… is required (or set STORE_BASE)");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required — it is how a tablet token is minted.");
  process.exit(1);
}

const { sql } = await import("../src/lib/db.ts");

/** §9, §11, §4. A budget of null means "no budget stated, report only". */
const BUDGETS: Record<string, number | null> = {
  "GET /api/v1/version": null,
  "GET /iclock/cdata (handshake)": 200,
  "POST /iclock/cdata (ATTLOG)": 200,
  "GET /api/v1/items/lookup": 100,
  "GET /api/v1/items/search": null,
  "GET /api/v1/sessions/unclaimed": null,
  "GET /api/v1/alerts/summary": null,
};

interface Sample {
  label: string;
  ms: number;
  status: number;
  cold: boolean;
}

const samples: Sample[] = [];
let firstRequestDone = false;

async function timed(label: string, path: string, init: RequestInit = {}) {
  const started = Date.now();
  let status = 0;
  let body: unknown = null;
  try {
    const res = await fetch(BASE + path, init);
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } catch (e) {
    status = -1;
    body = e instanceof Error ? e.message : String(e);
  }
  const ms = Date.now() - started;

  // The first request of the run is the one most likely to have paid for a
  // cold function start, and it is reported separately rather than averaged
  // in — averaging it away is how a cold-start problem stays invisible.
  const cold = !firstRequestDone;
  firstRequestDone = true;

  samples.push({ label, ms, status, cold });
  return { status, body, ms };
}

const pct = (values: number[], p: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function mintTabletToken(tabletId: string) {
  // api_tokens.tablet_id references tablets.tablet_id, so the device has to
  // exist before a token can name it. Marked inactive: this is a probe, not a
  // terminal anybody should be able to use.
  await sql`
    insert into tablets (tablet_id, name, location, registered_at, active)
    values (${tabletId}, 'latency probe', 'probe-live.mts', now(), false)
    on conflict (tablet_id) do nothing`;

  // The same scheme as src/lib/auth.ts: 32 random bytes base64url, stored as
  // its sha256. Short-lived, so an abandoned probe does not leave a usable
  // credential on a public deployment.
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, expires_at)
    values (${hash}, 'TABLET', ${tabletId}, now() + interval '30 minutes')`;
  return { token, hash };
}

async function main() {
  console.log(`probing ${BASE}`);
  console.log(`mode: ${WRITE ? "READ + WRITE (this will leave ledger rows)" : "read only"}`);
  console.log(`rounds: ${ROUNDS}\n`);

  const serial = "PROBE-" + randomUUID().slice(0, 8);
  const tabletId = "probe-" + randomUUID().slice(0, 8);
  const { token, hash } = await mintTabletToken(tabletId);
  const auth = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

  // Something to look up. A real item code is better than a synthetic one,
  // because the index behaviour is what is being measured.
  const [anyItem] = await sql<{ item_code: string }[]>`
    select item_code from items where active order by item_code limit 1`;
  if (!anyItem) {
    console.error("no active items — seed the catalog before probing lookup latency");
    process.exit(1);
  }

  for (let round = 1; round <= ROUNDS; round++) {
    process.stdout.write(`  round ${round}/${ROUNDS}\r`);

    await timed("GET /api/v1/version", "/api/v1/version");

    // The device's boot call. Read-only: it asks for its option block.
    await timed(
      "GET /iclock/cdata (handshake)",
      `/iclock/cdata?SN=${serial}&options=all&pushver=2.4.1`,
    );

    await timed(
      "GET /api/v1/items/lookup",
      `/api/v1/items/lookup?barcode=${encodeURIComponent(anyItem.item_code)}`,
      { headers: auth },
    );
    await timed("GET /api/v1/items/search", "/api/v1/items/search?q=carbide", { headers: auth });
    await timed("GET /api/v1/sessions/unclaimed", "/api/v1/sessions/unclaimed", { headers: auth });
    await timed("GET /api/v1/alerts/summary", "/api/v1/alerts/summary", { headers: auth });
  }
  process.stdout.write("           \r");

  if (WRITE) {
    console.log("\n── write path ──────────────────────────────────────────");
    const ts = new Date().toISOString().slice(0, 19).replace("T", " ");

    // §9: the device is the client. A punch is one tab-separated line, and the
    // response must be exactly `OK: <n>` or the device retries the batch.
    const [operator] = await sql<{ zk_user_id: string }[]>`
      select zk_user_id from operators
       where zk_user_id is not null and active limit 1`;
    if (!operator) {
      console.log("  no operator has a zk_user_id — skipping the punch");
    } else {
      const line = `${operator.zk_user_id}\t${ts}\t0\t1\t\t\n`;
      const push = await timed(
        "POST /iclock/cdata (ATTLOG)",
        `/iclock/cdata?SN=${serial}&table=ATTLOG`,
        { method: "POST", headers: { "Content-Type": "text/plain" }, body: line },
      );
      const acknowledged = typeof push.body === "string" && push.body.trim() === "OK: 1";
      console.log(
        `  ADMS push → ${push.status} ${JSON.stringify(push.body)} in ${push.ms} ms` +
        (acknowledged ? "" : "   ⚠ NOT the exact `OK: 1` §9 requires — the device would retry"),
      );
    }
  }

  // ── Report ─────────────────────────────────────────────────────────
  console.log("\n── latency ─────────────────────────────────────────────");
  console.log("  endpoint                              n   p50    p95    max   budget");

  const labels = [...new Set(samples.map((s) => s.label))];
  let breached = 0;

  for (const label of labels) {
    const rows = samples.filter((s) => s.label === label && !s.cold);
    const ms = rows.map((r) => r.ms);
    const budget = BUDGETS[label] ?? null;
    const p95 = pct(ms, 95);
    const over = budget !== null && p95 > budget;
    if (over) breached++;

    console.log(
      "  " + label.padEnd(36) +
      String(ms.length).padStart(3) +
      String(pct(ms, 50)).padStart(6) +
      String(p95).padStart(7) +
      String(Math.max(0, ...ms)).padStart(7) +
      (budget === null ? "        —" : String(budget).padStart(9)) +
      (over ? "   ⚠ OVER" : ""),
    );
  }

  const cold = samples.find((s) => s.cold);
  if (cold) {
    console.log(`\n  first request of the run: ${cold.ms} ms (${cold.label})`);
    console.log("  — that is the cold-start figure, excluded from the percentiles above.");
  }

  const failures = samples.filter((s) => s.status < 200 || s.status >= 400);
  if (failures.length > 0) {
    console.log(`\n  ${failures.length} request(s) did not succeed:`);
    for (const f of [...new Set(failures.map((f) => `${f.label} → ${f.status}`))]) {
      console.log("    " + f);
    }
  }

  console.log("\n── verdict ─────────────────────────────────────────────");
  if (breached === 0 && failures.length === 0) {
    console.log("  every stated budget met, every request answered.");
  } else {
    if (breached > 0) {
      console.log(`  ${breached} endpoint(s) over budget.`);
      console.log("  For the ADMS ones this is the §9.5 risk in the flesh: a slow");
      console.log("  acknowledgement makes the device retry, and a retried batch is a");
      console.log("  duplicate punch unless the dedup index catches it.");
    }
    if (failures.length > 0) console.log(`  ${failures.length} request(s) failed outright.`);
    process.exitCode = 1;
  }

  // The token is revoked rather than left to expire: this ran against a
  // publicly reachable deployment.
  await sql`update api_tokens set revoked_at = now() where token_hash = ${hash}`;
  console.log("\n  probe token revoked.");
}

try {
  await main();
} finally {
  await sql.end({ timeout: 5 });
}
