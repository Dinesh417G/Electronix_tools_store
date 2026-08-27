// M8's CSV, checked against a fixture computed by hand.
//
// The aggregation itself is SQL and needs a database; this covers the half that
// does not — the rendering, where a comma inside an item description quietly
// corrupts a file that still opens fine in Excel and is wrong by one column.
//
// The fixture numbers are the same ones the by-machine query returns for a
// ledger of six rows, one of which is a reversal that nets out and one of which
// is a RECEIPT that is not consumption at all:
//
//   VMC-01   -5, -3, +5 @ 120.50  →  qty 3,  value 361.50, 3 transactions
//   CNC-L1   -10        @  32.00  →  qty 10, value 320.00, 1
//   (none)   -2 SCRAP   @  18.00  →  qty 2,  value  36.00, 1

import assert from "node:assert/strict";
import { normaliseGroupBy, toCsv } from "../src/lib/report-format.ts";

const rows = [
  { bucket_key: "cnc-l1", bucket_label: "CNC-L1", qty: "10.000", value: "320.00", txn_count: 1 },
  { bucket_key: "vmc-01", bucket_label: "VMC-01", qty: "3.000", value: "361.50", txn_count: 3 },
  {
    bucket_key: "unassigned",
    bucket_label: "(no machine recorded)",
    qty: "2.000",
    value: "36.00",
    txn_count: 1,
  },
];

const expected =
  "machine,qty,value,txn_count\n" +
  '"CNC-L1",10.000,320.00,1\n' +
  '"VMC-01",3.000,361.50,3\n' +
  '"(no machine recorded)",2.000,36.00,1\n';

assert.equal(toCsv("machine", rows), expected, "by-machine CSV does not match the fixture");

// The reason the fields are quoted at all. An item description with a comma in
// it would otherwise shift every following column by one.
const awkward = [
  {
    bucket_key: "1",
    bucket_label: 'CNMG120408, grade "TN2000"',
    qty: "40.000",
    value: "4820.00",
    txn_count: 7,
  },
];
assert.equal(
  toCsv("item", awkward),
  'item,qty,value,txn_count\n"CNMG120408, grade ""TN2000""",40.000,4820.00,7\n',
  "a comma or a quote in a label is not escaped",
);

// An empty report is a header and nothing else, not an empty file: opening it
// should say "no consumption in this range", not look like a failed download.
assert.equal(toCsv("operator", []), "operator,qty,value,txn_count\n");

assert.equal(normaliseGroupBy(null), "item", "group_by defaults to item");
assert.equal(normaliseGroupBy("MONTH"), "month", "group_by is case-insensitive");
assert.equal(normaliseGroupBy("supplier"), null, "an unknown grouping is refused, not guessed");

console.log("reports: CSV fixture, escaping, empty report and group_by parsing all pass");
