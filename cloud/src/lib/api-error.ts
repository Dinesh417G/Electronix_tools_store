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
};

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;

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
