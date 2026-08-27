// Turning an error into an HTTP response. The error type itself, and the
// Postgres codes the §7 triggers raise, live in api-error.ts — that half must
// stay importable by `node --experimental-strip-types`, which cannot resolve
// `next/server`. Everything that needs Next is on this side of the line.

import { NextResponse } from "next/server";
import { ApiError, toApiError } from "./api-error.ts";

export { ApiError, toApiError } from "./api-error.ts";

export function errorResponse(e: unknown) {
  const api: ApiError = toApiError(e);
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
