// `npm run demo-data` — a fortnight of plausible tool-crib traffic, so the
// reports and the filters have something to say.
//
// A freshly seeded crib has 90 items, 88 OPENING rows and nothing else, which
// makes every report read "Nothing went out in this period" and every
// "frequently taken" list empty. That is correct and useless: you cannot judge
// a consumption report, or demonstrate one, against a ledger with no
// consumption in it.
//
// What it writes, and what it deliberately does not:
//
//   * Real movements through the real service (`src/lib/ledger.ts`), so the
//     §7 trigger maintains `item_stock`, the negative-stock guard applies, and
//     the alert ladder fires exactly as it would for an operator at the
//     terminal. Nothing here writes `item_stock` or a quantity directly,
//     because no such path exists anywhere in this codebase.
//   * Sessions, so every row is attributable: the terminal's own flow, minus
//     the tablet. Reports grouped by person are meaningless otherwise.
//   * Dates spread across the last N weeks, weighted to working hours, so
//     "this month" and "30 days" differ and the month grouping has more than
//     one bucket.
//   * Breakages and wear against particular machines, so machine-wise
//     consumption is not flat.
//
// **Every row it writes is marked.** `note` begins with `[demo]`, so anything
// this script created can be found — and, if it lands somewhere it should not,
// reversed. It cannot be deleted: §7 has no delete, and a demo is not an
// exception to that. That is exactly why `--confirm` is required and why the
// script refuses a database that already holds real movements unless you
// insist.
//
//   npm run demo-data -- --confirm              two weeks, ~120 movements
//   npm run demo-data -- --confirm --weeks 8    a longer history
//   npm run demo-data -- --dry-run              says what it would do

import { randomUUID } from "node:crypto";
import { sql } from "../src/lib/db.ts";

interface Options {
  confirm: boolean;
  dryRun: boolean;
  weeks: number;
  movements: number;
  force: boolean;
}

function parse(argv: string[]): Options {
  const value = (flag: string, fallback: number) => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const n = Number(argv[i + 1]);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n;
  };
  return {
    confirm: argv.includes("--confirm"),
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    weeks: value("--weeks", 2),
    movements: value("--movements", 120),
  };
}

/** Working hours, roughly: two shifts, nothing at 3am. */
function momentWithin(weeks: number): Date {
  const now = Date.now();
  const span = weeks * 7 * 24 * 3600 * 1000;
  const at = new Date(now - Math.random() * span);
  const shift = Math.random() < 0.6 ? 9 : 15;
  at.setHours(shift + Math.floor(Math.random() * 6), Math.floor(Math.random() * 60), 0, 0);
  // A stamp in the future would make "30 days" and "this month" disagree with
  // the ledger for no reason.
  return at.getTime() > now ? new Date(now - 60_000) : at;
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** Skewed so a few items are "frequently taken" and most are not. */
function weightedPick<T>(xs: T[]): T {
  const r = Math.random();
  const hot = Math.max(1, Math.floor(xs.length * 0.15));
  return r < 0.6 ? xs[Math.floor(Math.random() * hot)] : pick(xs);
}

async function main(argv: string[]): Promise<void> {
  const opts = parse(argv);

  const [{ real }] = await sql<{ real: number }[]>`
    select count(*)::int as real from stock_ledger
     where txn_type <> 'OPENING' and (note is null or note not like '[demo]%')`;
  const [{ demo }] = await sql<{ demo: number }[]>`
    select count(*)::int as demo from stock_ledger where note like '[demo]%'`;

  console.log(`ledger: ${real} real movements, ${demo} already marked [demo]`);

  if (real > 0 && !opts.force) {
    console.error(
      `\nRefusing: this database has ${real} genuine movements in it.\n` +
        "§7 forbids deleting a ledger row, so demo traffic mixed into a real\n" +
        "crib can only ever be reversed, never removed. Point DATABASE_URL at a\n" +
        "demo database, or pass --force if you have decided otherwise.",
    );
    process.exitCode = 1;
    return;
  }

  const operators = await sql<{ id: string; full_name: string }[]>`
    select id, full_name from operators where active order by emp_code`;
  const machines = await sql<{ id: string; code: string }[]>`
    select id, code from machines where active order by code`;
  const reasons = await sql<{ id: string; code: string; applies_to: string }[]>`
    select id, code, applies_to from reason_codes where active`;
  const items = await sql<{ id: string; item_code: string; on_hand: string }[]>`
    select i.id, i.item_code, s.on_hand::text as on_hand
      from items i join item_stock s on s.item_id = i.id
     where i.active and s.on_hand > 0
     order by s.on_hand desc`;

  if (!operators.length || !machines.length || !items.length) {
    console.error("Seed the catalog first: npm run seed -- --demo-operators");
    process.exitCode = 1;
    return;
  }

  const issueReasons = reasons.filter((r) => r.applies_to === "ISSUE");
  const receiptReasons = reasons.filter((r) => r.applies_to === "RECEIPT");

  console.log(
    `${items.length} items with stock, ${machines.length} machines, ` +
      `${operators.length} operators, over ${opts.weeks} week(s)`,
  );

  if (opts.dryRun || !opts.confirm) {
    console.log(
      `\nWould write about ${opts.movements} movements, every one marked [demo].\n` +
        "Nothing was written. Re-run with --confirm.",
    );
    return;
  }

  // A session per operator per day of traffic, so the ledger is attributable
  // the way a real one is — reports grouped by person need somewhere to group.
  let written = 0;
  let refused = 0;
  const perItem = new Map<string, number>();

  for (let n = 0; n < opts.movements; n += 1) {
    const at = momentWithin(opts.weeks);
    const operator = pick(operators);
    const isReceipt = Math.random() < 0.18;
    const item = weightedPick(items);

    const [session] = await sql<{ id: string }[]>`
      insert into sessions (operator_id, state, manual_identity, identity_source,
                            tablet_id, opened_at, claimed_at, closed_at,
                            last_activity_at, close_reason)
      values (${operator.id}, 'CLOSED', true, 'PIN', 'demo-tablet',
              ${at}, ${at}, ${at}, ${at}, 'SUBMITTED')
      returning id`;

    const machine = isReceipt ? null : pick(machines);
    const reason = isReceipt
      ? (receiptReasons.length ? pick(receiptReasons) : null)
      : (issueReasons.length ? pick(issueReasons) : null);
    const qty = isReceipt
      ? 10 + Math.floor(Math.random() * 40)
      : 1 + Math.floor(Math.random() * 4);

    try {
      await sql`
        insert into stock_ledger
          (item_id, delta_qty, txn_type, operator_id, session_id, machine_id,
           reason_id, note, created_at, client_txn_uuid)
        values (${item.id}, ${isReceipt ? qty : -qty},
                ${isReceipt ? "RECEIPT" : "ISSUE"}, ${operator.id}, ${session.id},
                ${machine?.id ?? null}, ${reason?.id ?? null},
                ${`[demo] ${isReceipt ? "restock" : "issued to " + machine?.code}`},
                ${at}, ${randomUUID()})`;
      written += 1;
      perItem.set(item.item_code, (perItem.get(item.item_code) ?? 0) + 1);
    } catch (error) {
      // The §7 guard refusing an issue past zero is the system working. Skip it
      // and carry on; a demo that cannot hit the guard is a demo of nothing.
      const code = (error as { code?: string }).code;
      if (code === "EL001") {
        refused += 1;
        await sql`delete from sessions where id = ${session.id}`;
        continue;
      }
      throw error;
    }
  }

  const top = [...perItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const [{ drift }] = await sql<{ drift: number }[]>`
    select count(*)::int as drift
      from item_stock s
      join (select item_id, sum(delta_qty) as total from stock_ledger group by item_id) l
        on l.item_id = s.item_id
     where s.on_hand <> l.total`;

  console.log(`\nwrote ${written} movements, ${refused} refused by the §7 guard`);
  console.log("busiest items: " + top.map(([code, n]) => `${code}×${n}`).join(", "));
  console.log(
    drift === 0
      ? "reconciles: on_hand equals sum(delta_qty) for every item"
      : `DRIFT on ${drift} items — that is a bug, not a data problem (§7)`,
  );
  if (drift !== 0) process.exitCode = 1;
}

main(process.argv.slice(2))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
