// A count in front of the PIN check (CLAUDE.md §11), because argon2 is not the
// control it looks like.
//
// `/api/v1/auth/operator` and `/api/v1/sessions/manual` both take an employee
// code and four digits, both are reachable from the public internet, and until
// this module neither counted how often it had said no. Ten thousand
// combinations is an afternoon of requests. The per-guess cost of an argon2
// verify is real and far too small to matter, and Vercel runs concurrent
// instances that will happily spend it in parallel.
//
// The state lives in Postgres (`auth_attempts`, migration 0010) because there
// is nowhere else for it: an instance's memory does not survive the response,
// and a counter an attacker can reset by making one more request is not a
// counter. See that migration's header for why it is a log rather than a
// number.

import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";

export type AuthRoute = "OPERATOR_LOGIN" | "MANUAL_SESSION";

/** How far back failures are counted. */
export const WINDOW_MINUTES = 15;

/**
 * Failures against one employee code before it stops being asked.
 *
 * Ten is well past a person on a numeric pad with gloves on, and it puts a
 * ten-thousand-guess sweep of one code at roughly ten days rather than an
 * afternoon. It is counted from that code's most recent success, so getting in
 * clears your own near-misses.
 */
export const MAX_FAILURES_PER_CODE = 10;

/**
 * Failures from one address, across every code, before that address stops
 * being asked. Higher than the per-code limit on purpose: a storekeeper and an
 * operator sharing the store's Wi-Fi are one address, and the shape this
 * catches is spraying — one guess against each of forty employee codes, which
 * never trips a per-code count.
 */
export const MAX_FAILURES_PER_IP = 20;

/**
 * Who is asking, as well as we can tell.
 *
 * On Vercel `x-vercel-forwarded-for` is set by the platform and cannot be
 * spoofed by the client; plain `x-forwarded-for` can be, so it is read last
 * and only its first hop is taken. A self-hosted deployment behind something
 * that does not set these headers gets `null`, and the per-address half of the
 * throttle simply does not apply — the per-code half does not depend on it.
 */
export function clientIp(request: Request): string | null {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  if (vercel) return vercel.split(",")[0]!.trim() || null;
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim() || null;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim() || null;
  return null;
}

type Counts = {
  code_failures: number;
  code_oldest: Date | null;
  ip_failures: number;
  ip_oldest: Date | null;
};

/**
 * Throws 429 if this code or this address has been wrong too often.
 *
 * Called **before** the operator row is read and before argon2 runs, which is
 * the whole point: a throttle that still checks the PIN has not slowed
 * anything down.
 *
 * A refused attempt is deliberately **not** recorded. The rows that caused the
 * lock already describe the attack, the retry estimate stays honest — it is
 * measured from the oldest failure still inside the window — and a legitimate
 * operator hammering the button cannot extend their own lockout by doing so.
 */
export async function assertNotLocked(empCode: string, ip: string | null): Promise<void> {
  const [counts] = await sql<Counts[]>`
    with bounds as (
      select now() - make_interval(mins => ${WINDOW_MINUTES}) as since
    ),
    -- Failures for this code are counted from its last success, so a wrong
    -- PIN followed by the right one leaves nothing behind.
    last_ok as (
      select coalesce(max(a.at), (select since from bounds)) as at
        from auth_attempts a, bounds
       where a.emp_code = ${empCode} and a.succeeded and a.at > bounds.since
    ),
    code_fail as (
      select count(*)::int as n, min(a.at) as oldest
        from auth_attempts a, last_ok
       where a.emp_code = ${empCode} and not a.succeeded and a.at > last_ok.at
    ),
    ip_fail as (
      select count(*)::int as n, min(a.at) as oldest
        from auth_attempts a, bounds
       where ${ip}::text is not null and a.client_ip = ${ip}
         and not a.succeeded and a.at > bounds.since
    )
    select code_fail.n as code_failures, code_fail.oldest as code_oldest,
           ip_fail.n   as ip_failures,   ip_fail.oldest   as ip_oldest
      from code_fail, ip_fail
  `;

  const lockedOn =
    counts.code_failures >= MAX_FAILURES_PER_CODE
      ? counts.code_oldest
      : counts.ip_failures >= MAX_FAILURES_PER_IP
        ? counts.ip_oldest
        : null;

  if (!lockedOn) return;

  const freeAt = lockedOn.getTime() + WINDOW_MINUTES * 60_000;
  const retryAfterSecs = Math.max(1, Math.ceil((freeAt - Date.now()) / 1000));

  // Says nothing about whether the employee code exists — the same reason both
  // callers answer "Employee code or PIN is not right." to every failure.
  throw ApiError.tooManyRequests(
    `Too many failed sign-ins. Try again in ${describeWait(retryAfterSecs)}.`,
    retryAfterSecs,
  );
}

function describeWait(secs: number): string {
  if (secs < 90) return `${secs} seconds`;
  return `${Math.ceil(secs / 60)} minutes`;
}

/**
 * Records the outcome of one PIN check.
 *
 * Awaited, never fired and forgotten: §14's rule is that no `void sql` runs
 * anywhere the server does, because a serverless instance is frozen the moment
 * its response is delivered and the suspended query takes the connection with
 * it.
 */
export async function recordAttempt(
  route: AuthRoute,
  empCode: string,
  ip: string | null,
  succeeded: boolean,
): Promise<void> {
  await sql`
    insert into auth_attempts (emp_code, route, client_ip, succeeded)
    values (${empCode}, ${route}, ${ip}, ${succeeded})
  `;
}
