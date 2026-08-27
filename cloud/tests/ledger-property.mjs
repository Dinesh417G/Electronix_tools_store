// The M1 acceptance gate (CLAUDE.md §13), on the cloud side.
//
//   > Property test: 10 000 random ledger ops — `item_stock.on_hand` equals
//   > `SUM(delta_qty)` after every single one. Negative-stock guard holds.
//
// §14 named this as one of the two gates the cloud implementation did not
// meet: `crates/store-core/tests/ledger_invariants.rs` proves the *Rust* fold
// is the sum of its deltas, and `store-db/tests/ledger_trigger.rs` proves the
// trigger agrees — but neither runs a single line of `cloud/src/lib/ledger.ts`.
//
// So this is deliberately not a port of the Rust test. The pure arithmetic has
// no TypeScript counterpart to check: there is no fold on this side, because
// `on_hand` is the trigger's business and the service only ever reads it back.
// What is unproven here, and provable nowhere else, is that the TypeScript
// service drives that trigger correctly — that `record()` appends one row per
// movement, never updates a quantity, rolls back cleanly when the guard fires,
// and reports the balance the ledger actually implies.
//
// Hence: real Postgres, real trigger, and after **every** operation a single
// query asking the database itself whether the cached read model still equals
// the sum of the ledger. Postgres does the numeric comparison, so a rounding
// difference cannot hide inside JavaScript's floats.
//
//   DATABASE_URL=… node --experimental-strip-types tests/ledger-property.mjs
//
// Knobs, both printed at startup so a CI failure is reproducible:
//   LEDGER_OPS   how many operations        (default 10000, the gate as written)
//   LEDGER_SEED  PRNG seed                  (default: random, and printed)

import { randomUUID } from "node:crypto";
import { record } from "../src/lib/ledger.ts";
import { toApiError } from "../src/lib/api-error.ts";
import { sql } from "../src/lib/db.ts";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const OPS = Number(process.env.LEDGER_OPS ?? 10_000);
const SEED = Number(process.env.LEDGER_SEED ?? (Math.random() * 2 ** 32) >>> 0);

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (n) => console.log("\n" + n);

/**
 * A seeded PRNG, because a property test that cannot reproduce its own failure
 * is half a test. The seed is printed; re-run with LEDGER_SEED=<it>.
 */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TXN_TYPES = ["ISSUE", "RECEIPT", "ADJUST", "OPENING", "SCRAP"];

/**
 * One generated movement.
 *
 * Magnitudes stay well under the `numeric(12,3)` ceiling: a long run of
 * receipts that hit the column's range would fail for a reason that has
 * nothing to do with drift, and would mask the bug this is looking for.
 *
 * ISSUE and SCRAP take stock out, RECEIPT and OPENING put it in, and ADJUST is
 * the one signed case — its direction alternates on parity so a run exercises
 * both without a second generator.
 */
function generate(rand) {
  const txnType = TXN_TYPES[Math.floor(rand() * TXN_TYPES.length)];
  const milli = 1 + Math.floor(rand() * 500_000); // 0.001 … 500.000
  const magnitude = (milli / 1000).toFixed(3);

  switch (txnType) {
    case "ISSUE":
    case "SCRAP":
      return { txnType, deltaQty: "-" + magnitude };
    case "RECEIPT":
    case "OPENING":
      return { txnType, deltaQty: magnitude };
    case "ADJUST":
      return { txnType, deltaQty: (milli % 2 === 0 ? "" : "-") + magnitude };
    default:
      throw new Error("unreachable txn type " + txnType);
  }
}

/**
 * The invariant, asked of the database rather than of JavaScript.
 *
 * `sum(delta_qty) = on_hand` is compared by Postgres in `numeric`, so this
 * cannot pass because two values happened to agree once converted to a float.
 */
async function agrees(itemId) {
  const [row] = await sql`
    select coalesce(sum(l.delta_qty), 0)::text as ledger_sum,
           s.on_hand::text                     as on_hand,
           (coalesce(sum(l.delta_qty), 0) = s.on_hand) as agree,
           count(l.id)::int                    as rows
      from item_stock s
      left join stock_ledger l on l.item_id = s.item_id
     where s.item_id = ${itemId}
     group by s.on_hand`;
  return row;
}

const created = { items: [], operator: null };

async function makeOperator() {
  const empCode = "PROP-" + randomUUID().slice(0, 8);
  const [op] = await sql`
    insert into operators (emp_code, full_name, role, active)
    values (${empCode}, 'Ledger Property Test', 'STOREKEEPER', true)
    returning id`;
  created.operator = op.id;
  return op.id;
}

async function makeItem({ allowNegative }) {
  // The trigger on `items` gives every new item an `item_stock` row at zero,
  // so the run starts from an empty bin rather than from seeded stock.
  const [item] = await sql`
    insert into items (item_code, description, uom, reorder_level, allow_negative, active)
    values (${"PROP-" + randomUUID().slice(0, 8)},
            'Ledger property test item', 'NOS', 10, ${allowNegative}, true)
    returning id`;
  created.items.push(item.id);
  return item.id;
}

/**
 * Replay a sequence against a real item, checking the invariant after every
 * operation. `next(i)` supplies each movement, so the same replay drives both
 * the random run and the deterministic one. Returns how many §7 refused.
 */
async function replay(label, { allowNegative, ops, next, seed }) {
  const itemId = await makeItem({ allowNegative });
  const operatorId = created.operator;

  let refused = 0;
  let applied = 0;

  for (let i = 0; i < ops; i++) {
    const movement = next(i);

    try {
      await record({ ...movement, itemId, operatorId, note: "property op " + i });
      applied++;
    } catch (e) {
      const api = toApiError(e);
      if (api.status === 409 && api.code === "INSUFFICIENT_STOCK") {
        // §7: the guard rolled the insert back. That is a legal outcome, and
        // the invariant must hold across it — a partially applied refusal is
        // exactly the drift this test exists to catch.
        refused++;
      } else {
        bad(`${label}: op ${i} (${movement.txnType} ${movement.deltaQty}) failed unexpectedly: ${api.code} ${api.message}`);
        return { refused, applied, itemId };
      }
    }

    const state = await agrees(itemId);
    if (!state.agree) {
      bad(`${label}: drift after op ${i} (${movement.txnType} ${movement.deltaQty}): ` +
          `ledger sum ${state.ledger_sum}, on_hand ${state.on_hand}` +
          (seed === undefined ? "" : ` — reproduce with LEDGER_SEED=${seed}`));
      return { refused, applied, itemId };
    }

    if (ops >= 1000 && (i + 1) % 1000 === 0) {
      console.log(`        ${label}: ${i + 1}/${ops} ops, ${refused} refused`);
    }
  }

  const final = await agrees(itemId);
  if (final.agree && Number(final.rows) === applied) {
    ok(`${label}: ${ops} ops, ${applied} applied, ${refused} refused — on_hand equals sum(delta_qty) after every one`);
  } else if (!final.agree) {
    bad(`${label}: final balance disagrees: sum ${final.ledger_sum} vs on_hand ${final.on_hand}`);
  } else {
    bad(`${label}: ledger holds ${final.rows} rows but ${applied} movements were accepted — a refusal left a trace`);
  }

  return { refused, applied, itemId };
}

async function main() {
  console.log(`ledger property test — ${OPS} ops, seed ${SEED}`);
  console.log(`reproduce this exact run with LEDGER_OPS=${OPS} LEDGER_SEED=${SEED}\n`);

  await makeOperator();

  // ── The gate as written ────────────────────────────────────────────
  step(`1. ${OPS} random ledger ops, guard on`);
  const randGuarded = mulberry32(SEED);
  const guarded = await replay("guarded", {
    allowNegative: false,
    ops: OPS,
    seed: SEED,
    next: () => generate(randGuarded),
  });

  // ── The guard changes what is accepted, never what an accepted row does ──
  step("2. the same sequence on an allow_negative item");
  {
    const rand = mulberry32(SEED);
    const permitted = await replay("allow_negative", {
      allowNegative: true,
      ops: OPS,
      seed: SEED,
      next: () => generate(rand),
    });
    if (permitted.refused === 0) {
      ok("nothing was refused, and the invariant still held after every op");
    } else {
      bad(`allow_negative item refused ${permitted.refused} ops — the guard ignored the opt-in`);
    }
    if (permitted.applied === OPS) {
      ok(`every one of the ${OPS} movements was appended`);
    } else {
      bad(`${permitted.applied} of ${OPS} movements were appended`);
    }
  }

  // ── Non-vacuity ────────────────────────────────────────────────────
  //
  // The random run above must NOT be the thing that proves the guard fires,
  // and finding that out was worth the detour: with a reflecting barrier at
  // zero the walk is conditioned to stay non-negative, so it drifts upward and
  // refusals bunch into the first few dozen ops. Seed 1 happened to open with
  // enough receipts to build a buffer and never dipped again — 200 ops, zero
  // refusals, and an assertion that would have been reported as a failure of
  // the guard rather than of the generator.
  //
  // So non-vacuity gets its own deterministic sequence, exactly as
  // `crates/store-core/tests/ledger_invariants.rs` does: issue-heavy, from an
  // empty bin, where hitting zero is arithmetic rather than luck.
  step("3. the negative-stock guard actually fires");
  {
    const issueHeavy = (i) => {
      const magnitude = (1 + ((i % 97) * 13) / 1000).toFixed(3);
      return i % 4 === 0
        ? { txnType: "RECEIPT", deltaQty: magnitude }
        : { txnType: "ISSUE", deltaQty: "-" + magnitude };
    };

    const hit = await replay("issue-heavy", {
      allowNegative: false,
      ops: 1000,
      next: issueHeavy,
    });
    if (hit.refused > 0) {
      ok(`the guard refused ${hit.refused} of 1000 issue-heavy ops — not vacuous`);
    } else {
      bad("an issue-heavy run from an empty bin refused nothing — the guard is not firing");
    }

    const opted = await replay("issue-heavy, allow_negative", {
      allowNegative: true,
      ops: 1000,
      next: issueHeavy,
    });
    if (opted.refused === 0 && opted.applied === 1000) {
      ok("the same sequence on an allow_negative item refuses nothing and still never drifts");
    } else {
      bad(`allow_negative refused ${opted.refused} of the same 1000 ops`);
    }
  }

  console.log(`\n(the random run refused ${guarded.refused} of ${OPS} — informational, not asserted)`);

  // ── §7 is a rule about the table, not about this service ───────────
  //
  // The e2e test pins UPDATE and DELETE at the HTTP edge. Here the point is
  // narrower and worth its own line: the guard's rollback is what keeps
  // "the ledger is what happened" true, so a refused ISSUE must leave the
  // balance untouched, not merely leave a row out.
  step("4. a refused ISSUE moves nothing");
  const emptyItem = await makeItem({ allowNegative: false });
  const before = await agrees(emptyItem);
  try {
    await record({
      itemId: emptyItem,
      deltaQty: "-1.000",
      txnType: "ISSUE",
      operatorId: created.operator,
      note: "must be refused",
    });
    bad("issuing from an empty bin was accepted");
  } catch (e) {
    const api = toApiError(e);
    if (api.status === 409 && api.code === "INSUFFICIENT_STOCK") {
      const after = await agrees(emptyItem);
      if (after.on_hand === before.on_hand && Number(after.rows) === 0) {
        ok("refused with 409 INSUFFICIENT_STOCK, and left no row and no balance change");
      } else {
        bad(`refused, but the item moved: ${before.on_hand} → ${after.on_hand}, ${after.rows} rows`);
      }
    } else {
      bad(`expected 409 INSUFFICIENT_STOCK, got ${api.status} ${api.code}`);
    }
  }

  console.log(`\n${pass.length} passed, ${fail.length} failed`);
}

try {
  await main();
} finally {
  // This test cannot tidy up after itself, and that is §7 working rather than
  // §7 being inconvenient: `stock_ledger_is_append_only` refuses DELETE, and
  // the ledger's foreign key then pins the item and the operator in place.
  // Anything that could erase these rows could erase a real issue.
  //
  // So they are retired instead of removed — the same verb the console uses
  // (§11: deactivate, never delete). They keep reconciling to zero drift,
  // which is what the e2e test's ninth step will ask of them, and they stay
  // out of the terminal's search. In CI the database is thrown away anyway.
  for (const itemId of created.items) {
    await sql`update items set active = false where id = ${itemId}`;
  }
  if (created.operator) {
    await sql`update operators set active = false where id = ${created.operator}`;
  }
  if (fail.length > 0) {
    console.log("\nleft in place for inspection (retired, not removed):");
    for (const itemId of created.items) console.log("  item " + itemId);
  }
  await sql.end({ timeout: 5 });
}

process.exit(fail.length === 0 ? 0 : 1);
