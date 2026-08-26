// API errors and the database error codes they come from.
//
// The status codes here are not decoration — CLAUDE.md §11 pins three of them
// to specific terminal behaviour, and the UI branches on them:
//
//   409  ISSUE past zero        → "Only 3 left in system — count the bin"
//   410  submit after close     → re-open the claim screen, keep the typing
//   409  second tablet claims   → show which tablet holds it

import { NextResponse } from "next/server";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
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

export function errorResponse(e: unknown) {
  const api = toApiError(e);
  if (api.status >= 500) {
    console.error("[api]", api.code, api.message, api.detail ?? "");
  }
  return NextResponse.json(
    { error: api.code, message: api.message, detail: api.detail },
    { status: api.status },
  );
}

/** Wraps a route handler so thrown ApiErrors become responses. */
export function handler<T extends unknown[]>(
  fn: (...args: T) => Promise<Response>,
) {
  return async (...args: T): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}
