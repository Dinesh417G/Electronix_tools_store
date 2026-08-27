// The parts of consumption reporting that touch neither the database nor the
// framework: the groupings, the row shape, and the CSV renderer.
//
// Split out from `reports.ts` for one practical reason — a test can import this
// under plain `node` and check the rendering against a fixture, which is the
// half of M8 that does not need a Postgres to be worth checking.

export const GROUP_BY = ["item", "machine", "operator", "category", "month"] as const;
export type GroupBy = (typeof GROUP_BY)[number];

/** The grouping, or null if it is not one we have. Defaults to `item`. */
export function normaliseGroupBy(value: string | null | undefined): GroupBy | null {
  const v = (value ?? "item").trim().toLowerCase();
  return (GROUP_BY as readonly string[]).includes(v) ? (v as GroupBy) : null;
}

export interface ConsumptionRow {
  /** Stable key for the bucket — an id, or a month as `YYYY-MM`. */
  bucket_key: string;
  /** What a human reads. */
  bucket_label: string;
  /** Positive magnitude of stock consumed. A string: `numeric(12,3)`. */
  qty: string;
  /** Value at the cost snapshot taken when each movement was booked. */
  value: string;
  txn_count: number;
}

/**
 * Render a report as CSV (§11: `/reports/consumption.csv`).
 *
 * Hand-rolled rather than a dependency, because the shape is four known
 * columns. Fields are quoted and inner quotes doubled, which is all RFC 4180
 * asks for — item descriptions contain commas often enough that skipping this
 * would corrupt the file within a week, and it would still open in Excel while
 * being wrong by one column.
 */
export function toCsv(groupBy: GroupBy, rows: ConsumptionRow[]): string {
  const escape = (field: string) => `"${field.replace(/"/g, '""')}"`;

  let out = `${groupBy},qty,value,txn_count\n`;
  for (const row of rows) {
    out += `${escape(row.bucket_label)},${row.qty},${row.value},${row.txn_count}\n`;
  }
  return out;
}
