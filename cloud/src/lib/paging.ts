// How many rows matched, and how a caller says which order it wants them in.
//
// Both exist for the same reason: a capped list that cannot say what it is a
// cap *of*, and cannot be reordered, is a page pretending to be a table. The
// console's own note settled for "the 60 most recent" because `shown === limit`
// was the only honest signal available without a count — it means "at least
// this many", never a total. And a column header that sorted what had already
// arrived would reorder sixty rows while implying it had ranked four thousand,
// which is worse than not offering the control.
//
// The count travels in a header rather than in the body. §11 serves these
// routes from both implementations, and the Rust one answers a bare JSON array;
// wrapping the cloud's body in an envelope would put the two out of step in the
// one place a caller cannot miss. A header is additive: every existing reader
// keeps working, and `crates/` can grow the same header later without either
// side changing shape.

/** The header carrying the count of rows that matched before the limit. */
export const TOTAL_HEADER = "X-Total-Count";

/** A page of rows, and how many there were to choose from. */
export interface Page<T> {
  rows: T[];
  /** Matches before `limit` and `offset` — not the number of rows returned. */
  total: number;
}

/**
 * Take `count(*) over()` off the rows and return it beside them.
 *
 * The count rides on each row because a window function is one round trip and
 * a second `count(*)` query is two — and on this platform `db.ts` runs `max: 1`,
 * so the second would queue behind the first rather than run alongside it.
 *
 * An empty result carries no rows to read the count off, and zero is the right
 * answer: no rows matched.
 */
export function splitTotal<T extends object>(
  rows: (T & { total_count?: number })[],
): Page<T> {
  const total = rows.length > 0 ? (rows[0].total_count ?? rows.length) : 0;
  return {
    // Deleted rather than destructured away: the lint rule counts an unused
    // binding as unused however it got there, and a `total_count` left on the
    // row would reach the browser as a column no screen asked for.
    rows: rows.map((row) => {
      const copy = { ...row };
      delete copy.total_count;
      return copy as unknown as T;
    }),
    total,
  };
}

/**
 * Resolve a caller's `sort` against a whitelist of SQL fragments.
 *
 * Nothing the caller sends reaches the query: `sort` selects a key from a map
 * written here, and an unknown one falls back to the default rather than
 * failing — a bookmarked URL from an older build should still answer, in a
 * defined order, rather than 400.
 *
 * `dir` is separate because it applies to the fragment the map returns, and
 * every fragment is written ascending so the two compose.
 *
 * `defaultDescending` is not decoration: the ledger's natural order is newest
 * first, and a caller who names no direction wants that rather than the oldest
 * movement in the crib's history.
 */
export function resolveSort<K extends string>(
  requested: string | null,
  dir: string | null,
  allowed: readonly K[],
  fallback: K,
  defaultDescending = false,
): { key: K; descending: boolean } {
  const key = allowed.includes(requested as K) ? (requested as K) : fallback;
  const descending = dir === "desc" ? true : dir === "asc" ? false : defaultDescending;
  return { key, descending };
}

/**
 * The columns each list can be ordered by, and the only ones.
 *
 * They live in this module — which imports nothing — because both sides need
 * them and they must not drift: the route resolves a caller's `sort` against
 * this array, and the screen renders one header per entry. Two copies would
 * disagree the first time somebody adds a column to one of them, and the
 * failure is silent (an unknown key falls back to the default, so the header
 * highlights a sort the server is not applying).
 *
 * A screen may import this file; it must not import `items.ts`, which pulls
 * `db.ts` and with it `postgres` into the browser bundle.
 */
export const STOCK_SORTS = ["alerts", "code", "description", "on_hand", "bin"] as const;
export type StockSort = (typeof STOCK_SORTS)[number];

export const LEDGER_SORTS = ["time", "item", "qty", "operator", "type"] as const;
export type LedgerSort = (typeof LEDGER_SORTS)[number];

/** Which column a list is sorted by, and which way. */
export interface SortState<K extends string> {
  key: K;
  dir: "asc" | "desc";
}
