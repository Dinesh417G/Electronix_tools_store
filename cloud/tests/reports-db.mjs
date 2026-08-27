// M8's aggregation half, against a real database (CLAUDE.md §13, §14).
//
// §13 admits what this closes:
//
//   > M8 is met in the cloud on the rendering half only. The report endpoints
//   > and the CSV are there, and the CSV is checked in CI against a fixture
//   > computed by hand. The aggregation itself is SQL, and no automated test
//   > runs it against a database on this side — it was verified once, by hand,
//   > over a synthetic ledger.
//
// `tests/reports-csv.mjs` covers the rendering: given rows, does the CSV come
// out right. This covers the other half: given a ledger, are those rows right.
// The two properties `src/lib/reports.ts` claims for itself are the ones worth
// pinning, because both are invisible until a number is wrong in a report
// somebody is using to place an order:
//
//   * every query reads `created_at`, never `device_ts` (§9.3) — a terminal
//     whose clock drifted off +05:30 must not move a transaction into the
//     wrong month;
//   * "consumption" means stock that left — ISSUE and SCRAP — and a reversal
//     nets itself out with no special case, because it is a real row with the
//     opposite sign.
//
// PRECONDITION: an empty `stock_ledger`. The report queries aggregate the
// whole table with no item filter, so a seeded catalog's opening balances
// would land in the same buckets. Migrations alone leave the ledger empty
// (0004 seeds only reason codes), so in CI this runs after `migrate` and
// before `npm run seed`. That ordering is asserted below rather than assumed —
// a reordered workflow should fail loudly here, not quietly report the wrong
// numbers.
//
//   DATABASE_URL=… node --experimental-strip-types tests/reports-db.mjs

import { randomUUID } from "node:crypto";
import { consumption, toCsv } from "../src/lib/reports.ts";
import { record, reverse } from "../src/lib/ledger.ts";
import { sql } from "../src/lib/db.ts";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (n) => console.log("\n" + n);

/** numeric(12,3) and numeric(14,2) arrive as strings; compare them as numbers. */
const num = (s) => Number(s);
const eq = (a, b) => Math.abs(num(a) - num(b)) < 0.0005;

function expect(label, actual, expected) {
  if (eq(actual, expected)) ok(`${label} = ${expected}`);
  else bad(`${label} = ${actual}, expected ${expected}`);
}

const find = (rows, key) => rows.find((r) => r.bucket_key === key);

async function main() {
  // ── Precondition ───────────────────────────────────────────────────
  step("0. the ledger is empty, so every bucket below is this test's own");
  const [{ count }] = await sql`select count(*)::int as count from stock_ledger`;
  if (count === 0) {
    ok("stock_ledger is empty");
  } else {
    bad(
      `stock_ledger already holds ${count} rows — this test aggregates the whole ` +
      `table, so its numbers would include them. Run it after 'migrate' and ` +
      `before the catalog seed.`,
    );
    console.log(`\n${pass.length} passed, ${fail.length} failed`);
    process.exit(1);
  }

  // ── Fixtures ───────────────────────────────────────────────────────
  const tag = randomUUID().slice(0, 8);

  const [category] = await sql`
    insert into item_categories (name, sort_order)
    values (${"Reports Test Carbide " + tag}, 900) returning id`;

  const [operator] = await sql`
    insert into operators (emp_code, full_name, role, active)
    values (${"RT-" + tag}, 'Reports Test Operator', 'STOREKEEPER', true)
    returning id`;

  const [admin] = await sql`
    insert into operators (emp_code, full_name, role, active)
    values (${"RTADM-" + tag}, 'Reports Test Admin', 'ADMIN', true)
    returning id`;

  const [machine] = await sql`
    insert into machines (code, name, active)
    values (${"RT-VMC-" + tag}, 'Reports Test VMC', true) returning id`;

  // Seeded by 0004, not by this test: the precondition above is about the
  // ledger, and reference data is exactly what a migration is allowed to leave
  // behind. Used to prove a reversal carries the original's reason as well as
  // its machine.
  const [reason] = await sql`
    select id from reason_codes where code = 'BREAKAGE'`;
  if (!reason) {
    bad("reason code BREAKAGE is missing — 0004 should have seeded it");
    process.exit(1);
  }

  const makeItem = async (code, description, cost) => {
    const [item] = await sql`
      insert into items (item_code, description, category_id, uom,
                         reorder_level, unit_cost, active)
      values (${code + "-" + tag}, ${description}, ${category.id}, 'NOS', 0, ${cost}, true)
      returning id`;
    return item.id;
  };

  // A comma in the description on purpose: it is the case that silently shifts
  // every following CSV column, and it must survive the round trip from the
  // database through the renderer.
  const itemA = await makeItem("RT-A", "CNMG 12 04 08, PVD coated", "100.00");
  const itemB = await makeItem("RT-B", "End mill 10 mm, 4 flute", "50.00");
  const itemC = await makeItem("RT-C", "Tap M8, spiral flute", "25.00");

  const book = (m) => record({ operatorId: operator.id, ...m });

  // ── The ledger this test reasons about ─────────────────────────────
  //
  //  A: receipt +100, issue -10 (machine), issue -4 (no machine), scrap -1
  //     → consumed 15, at 100.00 = 1500.00
  //  B: receipt +50,  issue -6 (machine), issue -8 (no machine) then reversed
  //     → consumed 6, at 50.00 = 300.00
  //  C: receipt +20,  issue -5 (machine) then reversed
  //     → consumed 0, so C must not appear at all
  //
  await book({ itemId: itemA, deltaQty: "100.000", txnType: "RECEIPT", unitCost: "100.00" });
  await book({ itemId: itemA, deltaQty: "-10.000", txnType: "ISSUE", unitCost: "100.00", machineId: machine.id });
  await book({ itemId: itemA, deltaQty: "-4.000", txnType: "ISSUE", unitCost: "100.00" });
  await book({ itemId: itemA, deltaQty: "-1.000", txnType: "SCRAP", unitCost: "100.00", machineId: machine.id });

  await book({ itemId: itemB, deltaQty: "50.000", txnType: "RECEIPT", unitCost: "50.00" });
  await book({ itemId: itemB, deltaQty: "-6.000", txnType: "ISSUE", unitCost: "50.00", machineId: machine.id });
  const bReversed = await book({
    itemId: itemB, deltaQty: "-8.000", txnType: "ISSUE", unitCost: "50.00",
  });
  await reverse(bReversed.ledger_id, admin.id, "reports test: netted out");

  await book({ itemId: itemC, deltaQty: "20.000", txnType: "RECEIPT", unitCost: "25.00" });
  const cReversed = await book({
    itemId: itemC, deltaQty: "-5.000", txnType: "ISSUE", unitCost: "25.00",
    machineId: machine.id, reasonId: reason.id,
  });
  await reverse(cReversed.ledger_id, admin.id, "reports test: fully reversed");

  // ── 1. By item ─────────────────────────────────────────────────────
  step("1. group_by=item — consumption is what left, and a reversal nets out");
  {
    const rows = await consumption("item");

    const a = find(rows, itemA);
    if (a) {
      expect("item A qty", a.qty, 15);
      expect("item A value", a.value, 1500);
      expect("item A txn_count", a.txn_count, 3);
    } else {
      bad("item A is missing from the report");
    }

    const b = find(rows, itemB);
    if (b) {
      // 6 issued, plus an 8 that was reversed: the pair contributes nothing.
      expect("item B qty (8 issued then reversed nets out)", b.qty, 6);
      expect("item B value", b.value, 300);
      // The reversal is a real row and is counted as one, which is the honest
      // answer: three movements touched this item's consumption.
      expect("item B txn_count", b.txn_count, 3);
    } else {
      bad("item B is missing from the report");
    }

    if (!find(rows, itemC)) {
      ok("item C, whose only issue was fully reversed, is absent — `having sum <> 0`");
    } else {
      bad("item C appears despite netting to zero");
    }

    // The receipts are the control: 170 units came in and none of it is
    // consumption. If RECEIPT ever leaked into these queries, item A would
    // read 115 rather than 15.
    const total = rows.reduce((sum, r) => sum + num(r.qty), 0);
    expect("total consumption across every bucket (receipts excluded)", total, 21);
  }

  // ── 2. By machine ──────────────────────────────────────────────────
  //
  // This section found a real defect when it was written, and now guards the
  // fix. `reverse()` used to copy the item, the magnitude, the txn type and
  // the unit cost of the row it corrects — but not its `machine_id`. So a
  // reversal of an issue booked to a machine was filed under "no machine
  // recorded", which left the machine charged for stock that came back (22
  // here, where the truth is 17) and drove the unassigned bucket NEGATIVE
  // (-1), a quantity nothing consumed.
  //
  // The totals reconciled throughout, which is exactly why nothing caught it:
  // the stock was all accounted for, just against the wrong machine. §11 says
  // a multi-machine issue writes one row per machine "so consumption-by-machine
  // stays attributable", and reports.ts says reversals "net themselves out
  // with no special case"; both were true by item, by category and in total,
  // and neither was true per machine.
  //
  // The reference implementation had it right all along —
  // `crates/store-db/src/ledger.rs` passes `machine_id` and `reason_id` from
  // the original — so the fix was parity, not a new rule.
  step("2. group_by=machine — a correction lands where the original was filed");
  {
    const rows = await consumption("machine");
    const m = find(rows, machine.id);
    const unassigned = find(rows, "unassigned");

    if (m) {
      // Booked to the machine: A -10, A scrap -1, B -6, C -5, and C's reversal
      // +5 now comes back to the same bucket rather than to "unassigned".
      expect("machine qty (17 issued and kept; the reversed 5 credits back here)", m.qty, 17);
      expect("machine value", m.value, 1400);
    } else {
      bad("the machine bucket is missing");
    }

    // A -4 and B -8, and B's reversal +8 nets against it: 4 remain. The point
    // is the sign as much as the number — consumption is stock that left, so a
    // negative bucket is nonsense on its face.
    if (unassigned) {
      expect("the unassigned bucket", unassigned.qty, 4);
      if (num(unassigned.qty) > 0) ok("and it is positive — no bucket claims negative consumption");
      else bad("the unassigned bucket is negative, which is the old defect's fingerprint");
    } else {
      bad("the unassigned bucket is missing, though two issues recorded no machine");
    }

    // Whatever the split, the buckets must add up to what the item report
    // says. A grouping that loses or invents stock would be a far worse bug
    // than misfiling it, and this is what rules it out.
    const total = rows.reduce((sum, r) => sum + num(r.qty), 0);
    expect("machine grouping still totals the same as the item grouping", total, 21);
  }

  // ── 2b. The reversing row itself ───────────────────────────────────
  //
  // The arithmetic above would also come out right if the report compensated
  // for a missing machine_id somewhere in SQL. This asserts the row, so the
  // fix cannot quietly move into the query.
  step("2b. a reversal carries the original's machine and reason");
  {
    const [row] = await sql`
      select machine_id, reason_id, txn_type, delta_qty::text as delta_qty, note
        from stock_ledger where reverses_id = ${cReversed.ledger_id}`;

    if (!row) {
      bad("no reversing row points at the machine-booked issue");
    } else {
      if (row.machine_id === machine.id) ok("the reversing row carries the original's machine_id");
      else bad(`the reversing row's machine_id is ${row.machine_id}, expected ${machine.id}`);

      if (row.reason_id === reason.id) ok("and the original's reason_id");
      else bad(`the reversing row's reason_id is ${row.reason_id}, expected ${reason.id}`);

      // Same item, same type, opposite sign — §7's mirror image.
      expect("the reversing row's delta_qty", row.delta_qty, 5);
      if (row.txn_type === "ISSUE") ok("and the same txn_type as the row it corrects");
      else bad(`the reversing row's txn_type is ${row.txn_type}, expected ISSUE`);
    }
  }

  // ── 2c. A reversal is not itself reversible ────────────────────────
  //
  // A chain would double-count: the pair already nets to nothing, so a third
  // row moves stock nobody took. `crates/store-db/src/ledger.rs` refuses this
  // and so must this side.
  step("2c. reversing a reversal is refused");
  {
    const [reversal] = await sql`
      select id from stock_ledger where reverses_id = ${cReversed.ledger_id}`;
    try {
      await reverse(Number(reversal.id), admin.id, "should not be allowed");
      bad("reversing a reversal was accepted — that chain double-counts");
    } catch (e) {
      if (e?.status === 409 && e?.code === "NOT_REVERSIBLE") {
        ok("reversing a reversal → 409 NOT_REVERSIBLE");
      } else {
        bad(`reversing a reversal threw ${e?.status} ${e?.code ?? e?.message}`);
      }
    }
  }

  // ── 3. By operator and category ────────────────────────────────────
  step("3. group_by=operator and group_by=category");
  {
    const operators = await consumption("operator");

    // The same attribution rule, and here it is arguably right: `reverse()`
    // takes the operator id of whoever performed the correction, so the
    // admin's bucket carries the credits. That is a defensible reading of
    // "who moved this stock" in a way the machine case is not — a machine
    // does not perform a reversal.
    const booker = find(operators, operator.id);
    if (booker) expect("the booking operator's gross consumption", booker.qty, 34);
    else bad("the booking operator is missing from the report");

    const reverser = find(operators, admin.id);
    if (reverser) expect("the reversing admin carries the credits", reverser.qty, -13);
    else bad("the reversing admin is missing from the report");

    const total = operators.reduce((sum, r) => sum + num(r.qty), 0);
    expect("operator grouping totals the same", total, 21);

    const categories = await consumption("category");
    const cat = find(categories, category.id);
    if (cat) {
      expect("category qty", cat.qty, 21);
      expect("category value", cat.value, 1800);
    } else {
      bad("the category is missing from the report");
    }
  }

  // ── 4. created_at, never device_ts ─────────────────────────────────
  //
  // Inserted directly rather than through `record()`, because the point is a
  // controlled `created_at` and the service — correctly — does not offer one.
  // The trigger still fires, so the row is a real ledger row in every other
  // respect. `device_ts` claims a date six months later: §9.3 says the device
  // clock is diagnostic only, and a drifted terminal must not be able to move
  // a transaction into another month's report.
  step("4. the month a movement lands in comes from created_at, not device_ts");
  {
    await sql`
      insert into stock_ledger (item_id, delta_qty, txn_type, operator_id,
                                unit_cost, device_ts, created_at)
      values (${itemA}, -2.000, 'ISSUE', ${operator.id}, 100.00,
              '2020-09-15 10:00:00+05:30', '2020-03-15 10:00:00+05:30')`;

    const months = await consumption("month");
    const march = find(months, "2020-03");
    const september = find(months, "2020-09");

    if (march) expect("the 2020-03 bucket (what the server observed)", march.qty, 2);
    else bad("no 2020-03 bucket — the row was filed under the device's clock");

    if (!september) ok("there is no 2020-09 bucket — device_ts moved nothing");
    else bad(`a 2020-09 bucket exists with qty ${september.qty} — device_ts is being read`);
  }

  // ── 5. Date bounds ─────────────────────────────────────────────────
  step("5. from/to bound the report");
  {
    const since2021 = await consumption("item", { from: "2021-01-01T00:00:00Z" });
    if (!find(since2021, itemA) || num(find(since2021, itemA).qty) === 15) {
      ok("from=2021-01-01 excludes the backdated 2020 row (item A back to 15)");
    } else {
      bad(`from=2021-01-01 gave item A qty ${find(since2021, itemA).qty}, expected 15`);
    }

    const before2021 = await consumption("item", { to: "2021-01-01T00:00:00Z" });
    const onlyOld = find(before2021, itemA);
    if (onlyOld) expect("to=2021-01-01 leaves only the backdated row", onlyOld.qty, 2);
    else bad("to=2021-01-01 dropped the backdated row as well");

    const empty = await consumption("item", {
      from: "2019-01-01T00:00:00Z",
      to: "2019-12-31T00:00:00Z",
    });
    if (empty.length === 0) ok("a window with no movements returns no rows");
    else bad(`an empty window returned ${empty.length} rows`);
  }

  // ── 6. CSV over real rows ──────────────────────────────────────────
  //
  // reports-csv.mjs renders a hand-written fixture. This renders what the
  // database actually produced, which is the only version that proves a
  // description containing a comma survives the whole path.
  step("6. the CSV renders the rows the database produced");
  {
    const rows = await consumption("item", { from: "2021-01-01T00:00:00Z" });
    const csv = toCsv("item", rows);
    const lines = csv.trim().split("\n");

    if (lines[0] === "item,qty,value,txn_count") ok("the header names the grouping");
    else bad(`header was ${JSON.stringify(lines[0])}`);

    const aLine = lines.find((l) => l.includes("CNMG 12 04 08"));
    if (aLine && aLine.startsWith('"') && aLine.includes('"RT-A-')) {
      ok("a description containing a comma is quoted, not split across columns");
    } else {
      bad(`item A rendered as ${JSON.stringify(aLine)}`);
    }

    // Four fields on every data row: the comma inside the quoted label must
    // not have added one. The header is unquoted, so it is checked above and
    // skipped here.
    const stray = lines.slice(1).find((l) => l.split('",')[1]?.split(",").length !== 3);
    if (!stray) ok("every row carries exactly four fields");
    else bad(`a row has the wrong column count: ${JSON.stringify(stray)}`);
  }

  console.log(`\n${pass.length} passed, ${fail.length} failed`);
}

try {
  await main();
} finally {
  // §7 refuses DELETE on stock_ledger, and its foreign keys pin everything
  // this test created. Retire rather than remove — the same verb §11 gives the
  // console. In CI the database is thrown away regardless.
  await sql`update items set active = false where item_code like ${"RT-%"}`;
  await sql`update operators set active = false where emp_code like ${"RT%-%"}`;
  await sql`update machines set active = false where code like ${"RT-VMC-%"}`;
  await sql.end({ timeout: 5 });
}

process.exit(fail.length === 0 ? 0 : 1);
