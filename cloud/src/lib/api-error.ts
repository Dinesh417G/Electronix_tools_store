// The error type and the Postgres codes it translates — everything about API
// errors that does not need Next.
//
// Split out of errors.ts for one reason: scripts/ and tests/ load this through
// `node --experimental-strip-types`, and `next/server` does not resolve outside
// the bundler. Keeping NextResponse on the other side of this line is what lets
// the seed and the end-to-end test import the domain without dragging a web
// framework in behind it. Same split, and the same reason, as report-format.ts.
//
// The status codes here are not decoration — CLAUDE.md §11 pins three of them
// to specific terminal behaviour, and the UI branches on them:
//
//   409  ISSUE past zero        → "Only 3 left in system — count the bin"
//   410  submit after close     → re-open the claim screen, keep the typing
//   409  second tablet claims   → show which tablet holds it

/**
 * Our own deadline fired on a query the database never reported on.
 *
 * Lives here rather than in db.ts so `toApiError` can recognise it without
 * importing the database into the error module — the same split, and the same
 * reason, as everything else in this file.
 *
 * It means something narrower than "slow". `statement_timeout` (15 s) covers a
 * query Postgres is *executing*; a backend parked on `ClientRead` is not
 * executing anything, so no database-side bound can ever fire on it. That is
 * the state the 2026-08-31 outage sat in — see db.ts.
 */
export class QueryDeadlineError extends Error {
  readonly waitedMs: number;

  constructor(what: string, waitedMs: number) {
    super(`the database did not answer a ${what} within ${(waitedMs / 1000).toFixed(1)}s`);
    this.name = "QueryDeadlineError";
    this.waitedMs = waitedMs;
  }
}

export class ApiError extends Error {
  // Declared and assigned rather than written as constructor parameter
  // properties: strip-only type erasure emits no code, so it cannot synthesise
  // the assignments a parameter property implies. It refuses the file outright
  // rather than getting it subtly wrong.
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.name = "ApiError";
  }

  static badRequest(message: string, detail?: unknown) {
    return new ApiError(400, "BAD_REQUEST", message, detail);
  }
  static unauthorized(message = "authentication required") {
    return new ApiError(401, "UNAUTHORIZED", message);
  }
  static forbidden(message = "not permitted") {
    return new ApiError(403, "FORBIDDEN", message);
  }
  static notFound(message = "not found") {
    return new ApiError(404, "NOT_FOUND", message);
  }
  static conflict(code: string, message: string, detail?: unknown) {
    return new ApiError(409, code, message, detail);
  }
  static gone(message: string) {
    return new ApiError(410, "SESSION_GONE", message);
  }
}

/**
 * Postgres error codes raised by the §7 triggers. These are the ledger's own
 * guards speaking, so they are translated rather than swallowed: a refused
 * ISSUE must reach the operator as "count the bin", not as a 500.
 */
const PG_CODES: Record<string, (message: string) => ApiError> = {
  // stock_ledger_after_insert(): would drive on_hand below zero
  EL001: (m) => ApiError.conflict("INSUFFICIENT_STOCK", m),
  // stock_ledger_is_append_only(): someone tried to UPDATE or DELETE
  EL003: (m) => new ApiError(500, "LEDGER_APPEND_ONLY", m),
  // stock_ledger row referenced an unknown item
  EL404: (m) => ApiError.notFound(m),
  // unique_violation — a duplicate client_txn_uuid or serial number
  "23505": (m) => ApiError.conflict("DUPLICATE", m),
  // foreign_key_violation
  "23503": (m) => ApiError.badRequest(m),
  // check_violation — a constraint the state machine should have prevented
  "23514": (m) => ApiError.badRequest(m),
  // numeric_value_out_of_range — a quantity or cost the column cannot hold.
  // lib/quantity.ts refuses these at the edge with a sentence an operator can
  // act on; this is the backstop for any path that does not go through it,
  // and it exists because the alternative is a 500 for what is plainly a bad
  // request. `store_core::ledger::validate_qty_domain` is the Rust side of the
  // same rule.
  "22003": (m) => ApiError.badRequest(m),
  // The bounds `db.ts` puts on every query, arriving as errors. None of them
  // means the request was wrong, so none of them is a 4xx: the statement was
  // cancelled, which in a transaction means nothing was committed and the
  // caller may safely try again. 503 says that, and it is what the terminal
  // needs to hear to keep the transaction in its outbox rather than drop it
  // as a refusal (§12).
  //
  // query_canceled — statement_timeout
  "57014": () =>
    new ApiError(503, "DB_TIMEOUT", "The database took too long. Nothing was saved — try again."),
  // lock_not_available — lock_timeout, i.e. another transaction holds the row
  "55P03": () =>
    new ApiError(503, "DB_BUSY", "That item is being updated by someone else. Try again."),
  // idle_in_transaction_session_timeout
  "25P03": () =>
    new ApiError(503, "DB_TIMEOUT", "The database connection was reset. Nothing was saved — try again."),
};

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;

  // Same class of answer as 57014 and for the same reason: the statement was
  // abandoned, so nothing was committed and a retry is safe. The difference is
  // only who noticed — us, because the database could not.
  if (e instanceof QueryDeadlineError) {
    return new ApiError(
      503,
      "DB_UNRESPONSIVE",
      "The database connection stopped answering. Nothing was saved — try again.",
    );
  }

  const pg = e as { code?: string; message?: string };
  if (pg?.code && PG_CODES[pg.code]) {
    return PG_CODES[pg.code](pg.message ?? "database rejected the write");
  }

  return new ApiError(
    500,
    "INTERNAL",
    e instanceof Error ? e.message : "unexpected error",
  );
}
