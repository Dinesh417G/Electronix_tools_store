// §12's outbox dedup, when the replay *races* the attempt it is replaying.
//
// M9's gate is "zero duplicates — including the case where the request commits
// and the acknowledgement is lost". That case was covered: the retry finds the
// row by `client_txn_uuid` and answers from the ledger. What was not covered is
// the retry arriving while the first attempt is still running, which is the
// ordinary shape of it rather than an exotic one — `fetchOrThrow` aborts on its
// own deadline while the request may still be in flight server-side, and the
// terminal then re-sends.
//
// The stock was never wrong: the unique index held and exactly one row was
// written. What was wrong is what the *caller* was told. The second request got
// `409 DUPLICATE`, and `outbox.ts` drops a 409 from the queue as **rejected**
// and shows it to the operator as a movement that failed. It did not fail — it
// committed on the attempt this one raced. An operator who believes that banner
// re-enters the issue by hand, and that is the double deduction the dedup
// exists to prevent, arriving through the front door.
//
// Measured three times out of three before the fix.
//
//   DATABASE_URL=…  STORE_BASE=http://localhost:3100 node tests/outbox-replay.mjs

import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

const BASE = process.env.STORE_BASE ?? "http://localhost:3100";
const TABLET = "replay-tablet";

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
  step("0. a claimed session on a tablet, and something to take");
  const [operator] = await sql`select id from operators where active limit 1`;
  const [item] = await sql`
    select i.id, i.item_code, s.on_hand from items i
      join item_stock s on s.item_id = i.id
     where i.active and s.on_hand >= 20 order by i.item_code limit 1`;
  if (!operator || !item) throw new Error("no operator, or no item with stock to issue");

  await sql`insert into tablets (tablet_id, name) values (${TABLET}, 'replay test')
            on conflict (tablet_id) do nothing`;
  const token = randomBytes(32).toString("base64url");
  tokenHash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, expires_at)
    values (${tokenHash}, 'TABLET', ${TABLET}, now() + interval '1 hour')`;

  const [device] = await sql`
    insert into devices (serial_no, name)
    values (${"REPLAY-" + randomBytes(4).toString("hex")}, 'replay test') returning id`;

  // A fresh claimed session per case: §10 closes one on submit, so reusing it
  // would answer 410 and mask what is being measured.
  const session = async () => {
    const [punch] = await sql`
      insert into punches (device_id, zk_user_id, device_ts, raw)
      values (${device.id}, 'replay', now(), 'replay') returning id`;
    const [row] = await sql`
      insert into sessions
        (operator_id, punch_id, state, tablet_id, claimed_at,
         last_activity_at, opened_at, identity_source)
      values (${operator.id}, ${punch.id}, 'ACTIVE', ${TABLET}, now(),
              now(), now(), 'PUNCH')
      returning id`;
    return row.id;
  };

  const post = (path, payload) =>
    fetch(BASE + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  const onHand = async () => {
    const [row] = await sql`select on_hand from item_stock where item_id = ${item.id}`;
    return Number(row.on_hand);
  };
  const rowsFor = async (uuid) => {
    const [row] = await sql`
      select count(*)::int as n from stock_ledger where client_txn_uuid = ${uuid}`;
    return row.n;
  };
  ok("item " + item.item_code + " with " + item.on_hand + " on hand");

  step("1. a replay sent after the first attempt answers from the ledger");
  {
    const uuid = randomUUID();
    const id = await session();
    const before = await onHand();
    const first = await post("/api/v1/txn/issue",
      { session_id: id, item_id: item.id, qty: "2", client_txn_uuid: uuid });
    const replay = await post("/api/v1/txn/issue",
      { session_id: id, item_id: item.id, qty: "2", client_txn_uuid: uuid });

    if (first.status === 200 && replay.status === 200) ok("both answered 200");
    else bad("answers were " + first.status + " and " + replay.status);
    const n = await rowsFor(uuid);
    if (n === 1) ok("one ledger row");
    else bad(n + " ledger rows for one client_txn_uuid");
    const after = await onHand();
    if (after === before - 2) ok("stock moved once, by 2");
    else bad("stock went " + before + " -> " + after);
  }

  step("2. a replay that races the first attempt does the same");
  {
    const uuid = randomUUID();
    const id = await session();
    const before = await onHand();
    const payload = { session_id: id, item_id: item.id, qty: "2", client_txn_uuid: uuid };
    const [a, b] = await Promise.all([
      post("/api/v1/txn/issue", payload),
      post("/api/v1/txn/issue", payload),
    ]);

    // The stock half was never broken — the unique index saw to that. Asserted
    // anyway, because a "fix" that answered 200 twice by writing twice would be
    // very much worse than the bug.
    const n = await rowsFor(uuid);
    if (n === 1) ok("exactly one ledger row was written");
    else bad(n + " ledger rows — the dedup index did not hold");
    const after = await onHand();
    if (after === before - 2) ok("stock moved exactly once");
    else bad("stock went " + before + " -> " + after);

    // The half that was broken.
    if (a.status === 200 && b.status === 200) {
      ok("both callers were told it succeeded, because it did");
    } else {
      bad(
        "a committed movement was answered " + a.status + "/" + b.status +
          " — outbox.ts drops a 409 as rejected and tells the operator it failed",
      );
    }
    if (a.body?.ledger_id && a.body.ledger_id === b.body?.ledger_id) {
      ok("both receipts name the same ledger row, " + a.body.ledger_id);
    } else {
      bad("receipts disagree: " + a.body?.ledger_id + " vs " + b.body?.ledger_id);
    }
  }

  step("3. and a raced replay of a split issue, which is several rows at once (§11)");
  {
    const machines = await sql`select id from machines where active limit 2`;
    if (machines.length < 2) {
      bad("need two active machines to split across");
    } else {
      // One key *per row*, which is what the terminal mints and re-sends
      // verbatim: a split batch resolves row by row rather than all-or-nothing,
      // so a batch acknowledged halfway still replays correctly.
      //
      // The first version of this step sent only a request-level
      // `client_txn_uuid` and watched stock move twice — which looked like a
      // defect and was a badly built payload. Worth the lines: the split form
      // ignored the top-level key, so a caller that sent one got no dedup and
      // no complaint. That silent ignore is a 400 now (step 4), and this step
      // sends what the terminal sends.
      const id = await session();
      const before = await onHand();
      const payload = {
        session_id: id,
        item_id: item.id,
        splits: [
          { machine_id: machines[0].id, qty: "1", client_txn_uuid: randomUUID() },
          { machine_id: machines[1].id, qty: "2", client_txn_uuid: randomUUID() },
        ],
      };
      const [a, b] = await Promise.all([
        post("/api/v1/txn/issue", payload),
        post("/api/v1/txn/issue", payload),
      ]);

      const after = await onHand();
      if (after === before - 3) ok("the split moved stock once, by 3");
      else bad("stock went " + before + " -> " + after);
      if (a.status === 200 && b.status === 200) ok("both callers were told it succeeded");
      else bad("the split replay answered " + a.status + "/" + b.status);
    }
  }
  step("4. a split that cannot be replayed is refused, not quietly accepted");
  {
    // Splits dedup on their rows' own keys, so a body carrying only a
    // request-level one has no replay protection at all — and used to be
    // accepted anyway, which is #49's class of fault: a parameter the server
    // drops on the floor while the caller believes it did something. Refused
    // now, because a rejection an operator can see beats a duplicate movement
    // nobody can.
    const machines = await sql`select id from machines where active limit 2`;
    const id = await session();
    const before = await onHand();
    const answer = await post("/api/v1/txn/issue", {
      session_id: id,
      item_id: item.id,
      client_txn_uuid: randomUUID(),
      splits: [
        { machine_id: machines[0].id, qty: "1" },
        { machine_id: machines[1].id, qty: "2" },
      ],
    });
    if (answer.status === 400) ok("400, naming the missing per-split keys");
    else bad("a split without per-row keys answered " + answer.status);
    const after = await onHand();
    if (after === before) ok("and wrote nothing");
    else bad("stock moved " + before + " -> " + after + " on a refused request");
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
