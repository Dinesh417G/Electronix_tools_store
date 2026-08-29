// Why a request failed, when it failed before the server ever answered.
//
// On 2026-08-29 the admin console showed "The store server is not reachable."
// while the terminal beside it sat on "Checking…", and the deployment was
// healthy the whole time: 5/5 manual sign-ins at ~190 ms and 60/60 lookups at
// a p95 of 179 ms, from the same machine and the same minute. The screenshot
// could not settle what had happened, because one sentence covered three
// different faults:
//
//   - the device had no network at all;
//   - the server was reachable but did not answer inside our budget;
//   - the connection failed part-way through.
//
// The first is the operator's problem and clears itself. The second is ours
// and shows up in the platform's logs. The third is usually a radio changing
// cell. They need different responses and they were indistinguishable on
// screen, so every occurrence arrived as another screenshot with no evidence
// in it.
//
// `OfflineError` therefore carries the reason and the wait, and says both in
// its message — a photograph of the screen is the only diagnostic that
// reliably reaches us from a shop floor, so the number has to be *on* the
// screen.

/** What went wrong before any HTTP status existed. */
export type OfflineReason =
  /** `navigator.onLine` was false: the device itself has no network. */
  | "device-offline"
  /** Our own deadline fired. The server may still be working on it. */
  | "timeout"
  /** `fetch` threw for some other reason — DNS, TLS, a dropped socket. */
  | "network";

// A read is cheap to repeat and an operator is waiting on it. A write gets
// longer because it is doing more and because giving up on it is the more
// expensive mistake. Both sit far below the platform's 300 s cap, which is the
// point: the terminal decides when it has waited long enough rather than
// inheriting a number chosen by a cloud.
export const READ_TIMEOUT_MS = 8_000;
export const WRITE_TIMEOUT_MS = 20_000;

/** Reads are retried; writes are not — see `fetchOrThrow`. */
export function isRetryable(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

export function timeoutFor(method: string): number {
  return isRetryable(method) ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
}

/**
 * Classify a thrown `fetch` rejection.
 *
 * `online` is passed in rather than read here so this stays a pure function
 * with no browser in it, and so the tests can drive all three branches.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError`; an explicit
 * `AbortController` gives `AbortError`. Both mean the same thing to an
 * operator — we stopped waiting — and neither says whether the server
 * committed anything, which is why a timed-out write goes to the outbox (§12)
 * under the `client_txn_uuid` it already minted rather than being retried
 * blind (§7).
 */
export function classifyOffline(cause: unknown, online: boolean): OfflineReason {
  if (!online) return "device-offline";

  const name =
    cause && typeof cause === "object" && "name" in cause
      ? String((cause as { name: unknown }).name)
      : "";

  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

/**
 * The sentence the operator reads.
 *
 * Short enough for a shop-floor screen, specific enough that a photograph of
 * it is evidence. The seconds are there so nobody has to guess afterwards
 * whether the wait was a blink or the full budget.
 */
export function offlineMessage(reason: OfflineReason, waitedMs: number): string {
  const secs = (waitedMs / 1000).toFixed(1);
  switch (reason) {
    case "device-offline":
      return "This device has no network.";
    case "timeout":
      return `The store server did not answer within ${secs}s.`;
    case "network":
      return `The connection to the store server failed after ${secs}s.`;
  }
}

/** Thrown when the request never got an answer from the server at all. */
export class OfflineError extends Error {
  readonly reason: OfflineReason;
  readonly waitedMs: number;
  readonly attempts: number;

  constructor(
    cause?: unknown,
    detail: { waitedMs?: number; attempts?: number; online?: boolean } = {},
  ) {
    const online =
      detail.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);
    const waitedMs = detail.waitedMs ?? 0;
    const reason = classifyOffline(cause, online);

    super(offlineMessage(reason, waitedMs));
    this.name = "OfflineError";
    this.reason = reason;
    this.waitedMs = waitedMs;
    this.attempts = detail.attempts ?? 1;
    this.cause = cause;
  }

  /** True when nothing we can do here will help — the device is off the air. */
  get isDeviceOffline() {
    return this.reason === "device-offline";
  }

  /** True when we stopped waiting. The server may still have committed it. */
  get isTimeout() {
    return this.reason === "timeout";
  }
}

/** Somewhere to wait between retries without pulling in a scheduler. */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` with a deadline, a retry policy and a classified failure.
 *
 * Every call the browser makes to our API goes through here — the terminal,
 * the admin console and the passkey ceremony alike. Before this, only the
 * terminal was bounded: `admin.ts` and `passkey.ts` called bare `fetch`, which
 * waits forever, so the console had the exact hang that PR #14 removed from
 * the terminal on 2026-08-28. A screen that never fails also never explains
 * itself.
 *
 * A fetch that throws usually means nothing on a phone: the tab was
 * backgrounded for the print dialogue, the radio changed cell, the screen
 * locked for a moment. So reads are retried three times with a short backoff.
 *
 * Writes are not retried, ever. A POST that threw may still have been received
 * and committed, and §7 does not allow a second ledger row on a guess — that
 * is what the outbox and `client_txn_uuid` are for.
 */
export async function fetchOrThrow(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const allowed = isRetryable(method) ? 3 : 1;
  const timeoutMs = timeoutFor(method);

  const startedAt = Date.now();
  let lastCause: unknown;
  let attempt = 0;

  while (attempt < allowed) {
    attempt += 1;
    try {
      return await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      lastCause = cause;
      // Offline outright: no point burning the battery on a retry loop.
      if (typeof navigator !== "undefined" && navigator.onLine === false) break;
      if (attempt < allowed) await delay(attempt * 400);
    }
  }

  throw new OfflineError(lastCause, { waitedMs: Date.now() - startedAt, attempts: attempt });
}
