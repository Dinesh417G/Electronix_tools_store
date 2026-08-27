// `npm run seed` — load a catalog into the cloud database.
//
// `store-cli seed` (crates/store-cli/src/seed.rs) cannot do this job: it needs a
// Rust toolchain and a direct Postgres connection on the machine doing the
// seeding, and the database this deployment talks to is Supabase behind a
// pooler. So this is that seed again, in TypeScript — but reading the *same*
// CSV rather than a copy of it, because two catalogs that drift apart is how a
// demo starts disagreeing with the reference implementation.
//
//   node --experimental-strip-types scripts/seed.ts --sql    prints SQL, touches nothing
//   node --experimental-strip-types scripts/seed.ts          applies it, needs DATABASE_URL
//
// The SQL is emitted either way, and all of it is idempotent: categories,
// machines and items upsert on their natural keys, barcodes do nothing on
// conflict, and an opening balance is booked only for an item with no ledger
// history at all. Re-running it on a live store does not re-open balances that
// have since been issued against.
//
// Opening stock is an OPENING ledger row (§7), never a written quantity. There
// is no path in this file that updates item_stock, because there is no such
// path anywhere.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Column order, checked against the file's header at parse time. Changing one
// without the other is the bug that check exists to catch.
const COLUMNS = [
  "item_code", "description", "category", "uom", "iso_code", "grade",
  "manufacturer", "mfr_part_no", "diameter_mm", "flutes", "reorder_level",
  "reorder_qty", "bin_location", "unit_cost", "opening_qty", "barcode",
] as const;

// §6 allows these. A typo in the file should be refused, not stored.
const UOMS = ["NOS", "SET", "BOX", "LTR", "KG"];

const MACHINES: [string, string][] = [
  ["VMC-01", "Vertical machining centre 1 - Haas VF2"],
  ["VMC-02", "Vertical machining centre 2 - Haas VF3"],
  ["VMC-03", "Vertical machining centre 3 - Jyoti VMC640"],
  ["CNC-L1", "CNC turning centre 1 - Ace Jobber XL"],
  ["CNC-L2", "CNC turning centre 2 - Ace Super Jobber"],
  ["HMC-01", "Horizontal machining centre - Makino a51"],
  ["SG-01", "Surface grinder"],
  ["EDM-01", "Wire EDM"],
  ["DRL-01", "Radial drilling machine"],
];

// The four demo logins from `store-cli seed`. Four-digit PINs printed in a
// README are fine on a laptop and are not fine on a deployment the public
// internet can reach, so they are behind a flag and off by default.
const DEMO_OPERATORS: [string, string, string, string, string][] = [
  ["E9001", "S. Rao", "9001", "ADMIN", "1111"],
  ["E5001", "M. Iyer", "5001", "STOREKEEPER", "2222"],
  ["E1042", "R. Kumar", "1042", "OPERATOR", "3333"],
  ["E2077", "A. Singh", "2077", "OPERATOR", "4444"],
];

interface CatalogRow {
  item_code: string;
  description: string;
  category: string;
  uom: string;
  iso_code: string | null;
  grade: string | null;
  manufacturer: string | null;
  mfr_part_no: string | null;
  diameter_mm: string | null;
  flutes: string | null;
  reorder_level: string;
  reorder_qty: string | null;
  bin_location: string;
  unit_cost: string | null;
  /** Zero means "in the catalog, none in the bin" and books no row: §7 forbids
   *  a zero delta, and nothing arriving is not a movement. */
  opening_qty: string;
  barcode: string | null;
}

// ── Parsing ────────────────────────────────────────────────────────────────
//
// Deliberately not a general CSV reader, for the same reason the Rust one is
// not: a parser that silently mis-splits a row is how an item ends up with the
// wrong reorder level and nobody notices until the bin is empty.

export function parse(source: string): CatalogRow[] {
  const rows: CatalogRow[] = [];
  let headerSeen = false;

  source.split(/\r?\n/).forEach((raw, index) => {
    const lineNo = index + 1; // 1-based, counting comments, so it matches an editor
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) return;

    if (line.includes('"')) {
      throw new Error(
        `line ${lineNo}: quoted fields are not supported — remove the quotes and any commas inside a field`,
      );
    }

    const fields = line.split(",").map((f) => f.trim());

    if (!headerSeen) {
      if (fields.join(",") !== COLUMNS.join(",")) {
        throw new Error(
          `line ${lineNo}: the header does not match the expected columns.\n` +
            `  expected: ${COLUMNS.join(",")}\n  found:    ${fields.join(",")}`,
        );
      }
      headerSeen = true;
      return;
    }

    if (fields.length !== COLUMNS.length) {
      throw new Error(
        `line ${lineNo}: expected ${COLUMNS.length} fields but found ${fields.length}. ` +
          `A comma inside a description is the usual cause — use a dash.`,
      );
    }

    rows.push(row(fields, lineNo));
  });

  if (!headerSeen) throw new Error("the catalog has no header row");
  if (rows.length === 0) throw new Error("the catalog has a header but no items");

  return rows;
}

function row(f: string[], lineNo: number): CatalogRow {
  const at = (i: number): string => {
    const v = f[i];
    if (v === "") throw new Error(`line ${lineNo}: ${COLUMNS[i]} must not be empty`);
    return v;
  };
  const opt = (i: number): string | null => (f[i] === "" ? null : f[i]);
  // Kept as strings the whole way down. Quantities are numeric(12,3) and money
  // numeric(12,2); routing either through a JS number would put rounding error
  // into a ledger whose entire purpose is that it adds up.
  const dec = (i: number): string | null => {
    const v = opt(i);
    if (v === null) return null;
    if (!/^-?\d+(\.\d+)?$/.test(v)) {
      throw new Error(`line ${lineNo}: ${COLUMNS[i]} is not a number: ${v}`);
    }
    return v;
  };

  const uom = at(3).toUpperCase();
  if (!UOMS.includes(uom)) {
    throw new Error(`line ${lineNo}: uom must be one of ${UOMS.join(", ")} (found ${uom})`);
  }

  const flutes = opt(9);
  if (flutes !== null && !/^\d+$/.test(flutes)) {
    throw new Error(`line ${lineNo}: flutes is not a whole number: ${flutes}`);
  }

  const reorderLevel = dec(10) ?? "0";
  const openingQty = dec(14) ?? "0";

  // Negative anything here is a typo, and a negative opening balance would seed
  // the store below zero before anybody had touched it.
  if (reorderLevel.startsWith("-")) {
    throw new Error(`line ${lineNo}: reorder_level cannot be negative`);
  }
  if (openingQty.startsWith("-")) {
    throw new Error(`line ${lineNo}: opening_qty cannot be negative`);
  }

  return {
    item_code: at(0),
    description: at(1),
    category: at(2),
    uom,
    iso_code: opt(4),
    grade: opt(5),
    manufacturer: opt(6),
    mfr_part_no: opt(7),
    diameter_mm: dec(8),
    flutes,
    reorder_level: reorderLevel,
    reorder_qty: dec(11),
    bin_location: at(12),
    unit_cost: dec(13),
    opening_qty: openingQty,
    barcode: opt(15),
  };
}

/** Categories in first-appearance order, derived from the file rather than
 *  listed separately, so adding a section cannot leave a category missing. */
export function categories(rows: CatalogRow[]): string[] {
  const seen: string[] = [];
  for (const r of rows) if (!seen.includes(r.category)) seen.push(r.category);
  return seen;
}

// ── SQL ────────────────────────────────────────────────────────────────────
//
// Literals rather than bind parameters, so the whole seed is one auditable
// script somebody can read before it touches their database — which is what
// makes `--sql` worth having. Every value has been through the parser above;
// strings are escaped here and numbers re-checked.

function str(v: string | null): string {
  if (v === null) return "null";
  if (/\p{Cc}/u.test(v)) {
    throw new Error(`illegal character in value: ${JSON.stringify(v)}`);
  }
  return `'${v.replace(/'/g, "''")}'`;
}

function num(v: string | null): string {
  if (v === null) return "null";
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new Error(`not a number: ${v}`);
  return v;
}

interface Options {
  withStock: boolean;
  /** emp_code, full_name, zk_user_id, role, pin, pin_hash */
  operators: [string, string, string, string, string, string][];
}

export function buildSql(rows: CatalogRow[], source: string, options: Options): string {
  const cats = categories(rows);
  const out: string[] = [];

  out.push(
    `-- Generated by cloud/scripts/seed.ts from ${source}`,
    `-- ${rows.length} items, ${cats.length} categories, ${MACHINES.length} machines.`,
    `-- Idempotent. Safe to run twice, and safe on a store that already has stock.`,
    ``,
    `begin;`,
    ``,
  );

  // Ten apart, so a category can be slipped between two later without
  // renumbering the rest.
  out.push(
    `insert into item_categories (name, sort_order) values`,
    cats.map((c, i) => `  (${str(c)}, ${(i + 1) * 10})`).join(",\n"),
    `on conflict (name) do update set sort_order = excluded.sort_order;`,
    ``,
  );

  out.push(
    `insert into machines (code, name) values`,
    MACHINES.map(([code, name]) => `  (${str(code)}, ${str(name)})`).join(",\n"),
    `on conflict (code) do update set name = excluded.name;`,
    ``,
  );

  if (options.operators.length > 0) {
    out.push(
      `insert into operators (emp_code, full_name, zk_user_id, role, pin_hash) values`,
      options.operators
        .map(
          ([emp, name, zk, role, , hash]) =>
            `  (${str(emp)}, ${str(name)}, ${str(zk)}, ${str(role)}, ${str(hash)})`,
        )
        .join(",\n"),
      `on conflict (emp_code) do update set`,
      `  full_name = excluded.full_name, role = excluded.role, pin_hash = excluded.pin_hash;`,
      ``,
    );
  }

  out.push(
    `insert into items (`,
    `  item_code, description, category_id, uom, iso_code, grade, manufacturer,`,
    `  mfr_part_no, diameter_mm, flutes, reorder_level, reorder_qty, bin_location, unit_cost`,
    `) values`,
    rows
      .map(
        (r) =>
          `  (${str(r.item_code)}, ${str(r.description)},` +
          ` (select id from item_categories where name = ${str(r.category)}),` +
          ` ${str(r.uom)}, ${str(r.iso_code)}, ${str(r.grade)}, ${str(r.manufacturer)},` +
          ` ${str(r.mfr_part_no)}, ${num(r.diameter_mm)}, ${num(r.flutes)},` +
          ` ${num(r.reorder_level)}, ${num(r.reorder_qty)}, ${str(r.bin_location)},` +
          ` ${num(r.unit_cost)})`,
      )
      .join(",\n"),
    `on conflict (item_code) do update set`,
    `  description = excluded.description, category_id = excluded.category_id,`,
    `  uom = excluded.uom, iso_code = excluded.iso_code, grade = excluded.grade,`,
    `  manufacturer = excluded.manufacturer, mfr_part_no = excluded.mfr_part_no,`,
    `  diameter_mm = excluded.diameter_mm, flutes = excluded.flutes,`,
    `  reorder_level = excluded.reorder_level, reorder_qty = excluded.reorder_qty,`,
    `  bin_location = excluded.bin_location, unit_cost = excluded.unit_cost;`,
    ``,
  );

  // The vendor's own printed barcode, so scanning the box the inserts arrived
  // in resolves to our item without relabelling it (§6, item_barcodes).
  const barcoded = rows.filter((r) => r.barcode !== null);
  if (barcoded.length > 0) {
    out.push(
      `insert into item_barcodes (item_id, code, kind) values`,
      barcoded
        .map(
          (r) =>
            `  ((select id from items where item_code = ${str(r.item_code)}), ${str(r.barcode)}, 'MFR_EAN')`,
        )
        .join(",\n"),
      `on conflict (code) do nothing;`,
      ``,
    );
  }

  const opening = rows.filter((r) => Number(r.opening_qty) > 0);
  if (options.withStock && opening.length > 0) {
    // Every ledger row carries an operator — there are no anonymous rows (§11).
    // Fail with a sentence rather than a not-null violation if the database has
    // nobody who could plausibly have counted the bins.
    out.push(
      `do $$`,
      `begin`,
      `  if not exists (select 1 from operators where active and role in ('STOREKEEPER', 'ADMIN')) then`,
      `    raise exception 'seed: no active STOREKEEPER or ADMIN operator to attribute opening stock to — run store-cli operator add, or seed with --demo-operators';`,
      `  end if;`,
      `end $$;`,
      ``,
      `insert into stock_ledger (item_id, delta_qty, txn_type, operator_id, note)`,
      `select i.id, v.qty, 'OPENING',`,
      `       (select id from operators where active and role in ('STOREKEEPER', 'ADMIN')`,
      `         order by case role when 'STOREKEEPER' then 0 else 1 end, emp_code limit 1),`,
      `       'seeded opening balance'`,
      `  from (values`,
      opening.map((r) => `    (${str(r.item_code)}, ${num(r.opening_qty)}::numeric)`).join(",\n"),
      `  ) as v(item_code, qty)`,
      `  join items i on i.item_code = v.item_code`,
      // Only genuinely new items. Re-running must not keep adding balance.
      ` where not exists (select 1 from stock_ledger l where l.item_id = i.id);`,
      ``,
    );
  }

  out.push(`commit;`, ``);
  return out.join("\n");
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const printOnly = argv.includes("--sql");
  const withStock = !argv.includes("--no-stock");
  const withDemoOperators = argv.includes("--demo-operators");

  const flag = argv.indexOf("--catalog");
  const source =
    flag >= 0 && argv[flag + 1]
      ? resolve(argv[flag + 1])
      : resolve(HERE, "../../crates/store-cli/catalog/demo-catalog.csv");

  const rows = parse(readFileSync(source, "utf8"));

  let operators: Options["operators"] = [];
  if (withDemoOperators) {
    const { hashPin } = await import("../src/lib/auth.ts");
    operators = await Promise.all(
      DEMO_OPERATORS.map(
        async ([emp, name, zk, role, pin]) =>
          [emp, name, zk, role, pin, await hashPin(pin)] as Options["operators"][number],
      ),
    );
  }

  const script = buildSql(rows, source, { withStock, operators });

  if (printOnly) {
    process.stdout.write(script);
    return;
  }

  const { sql } = await import("../src/lib/db.ts");
  await sql.unsafe(script).simple();
  await report(sql, rows.length, categories(rows).length);
  await sql.end();

  if (withDemoOperators) {
    console.log("");
    console.log("Demo logins (emp code / PIN):  E9001/1111 ADMIN, E5001/2222 STOREKEEPER,");
    console.log("                              E1042/3333 and E2077/4444 OPERATOR.");
    console.log("Those PINs are published in this repo. Do not leave them on a reachable deployment.");
  }
}

// The demo is only useful if the alert console has something in it, so say what
// state the store is actually in rather than leaving it to be found.
async function report(
  sql: (typeof import("../src/lib/db.ts"))["sql"],
  items: number,
  cats: number,
): Promise<void> {
  const [stock] = await sql<{ ok: string; low: string; empty: string; ledger: string }[]>`
    select count(*) filter (where alert_state = 'OK')    as ok,
           count(*) filter (where alert_state = 'LOW')   as low,
           count(*) filter (where alert_state = 'EMPTY') as empty,
           (select count(*) from stock_ledger)           as ledger
      from item_stock
  `;

  console.log(`Seeded: ${items} items across ${cats} categories, ${MACHINES.length} machines.`);
  console.log(`Stock:  ${stock.ok} OK, ${stock.low} LOW, ${stock.empty} EMPTY`);
  console.log(`Ledger: ${stock.ledger} row(s).`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
