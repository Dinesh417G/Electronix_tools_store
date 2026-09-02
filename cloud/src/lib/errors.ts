// Turning an error into an HTTP response. The error type itself, and the
// Postgres codes the §7 triggers raise, live in api-error.ts — that half must
// stay importable by `node --experimental-strip-types`, which cannot resolve
// `next/server`. Everything that needs Next is on this side of the line.

import { NextResponse } from "next/server";
import { ApiError, toApiError } from "./api-error.ts";
import { withDbDeadline } from "./db.ts";

export { ApiError, toApiError } from "./api-error.ts";

export function errorResponse(e: unknown) {
  const api: ApiError = toApiError(e);
  if (api.status >= 500) {
    console.error("[api]", api.code, api.message, api.detail ?? "");
  }
  return NextResponse.json(
    { error: api.code, message: api.message, detail: api.detail },
    {
      status: api.status,
      // A 429 that does not say when to come back makes every client guess,
      // and the ones that guess wrong retry immediately.
      headers:
        api.retryAfterSecs === undefined
          ? undefined
          : { "Retry-After": String(api.retryAfterSecs) },
    },
  );
}

/**
 * Wraps a route handler so thrown ApiErrors become responses — and so no route
 * can wait on the database forever.
 *
 * The deadline is here, on the whole request, rather than on each query. It
 * was tried on the query first and broke composition: postgres.js's query
 * object doubles as a SQL fragment, and `items.ts` builds its selects out of
 * them, so returning a plain promise turned a fragment into a bound parameter
 * (`syntax error at or near "$1"`). A request is the honest unit anyway — the
 * failure it exists for is an instance whose only connection has stopped
 * answering, and that kills the request whichever query notices first.
 *
 * `withDbDeadline` discards the connection when it fires, so the next request
 * on this instance builds a fresh one. Without that the instance stays
 * poisoned for its whole life, which is what made the Door screen's Refresh
 * button useless on 2026-08-31.
 */
export function handler<T extends unknown[]>(
  fn: (...args: T) => Promise<Response>,
) {
  return async (...args: T): Promise<Response> => {
    try {
      return await withDbDeadline(fn(...args), "request");
    } catch (e) {
      return errorResponse(e);
    }
  };
}
