// Bearer tokens and PINs (CLAUDE.md §11).
//
// Two kinds of secret, two hashes, on purpose:
//
//   tokens  256 bits of randomness → SHA-256. A slow KDF protects low-entropy
//           secrets; against a value that cannot be guessed it buys latency and
//           nothing else.
//   PINs    four digits, entered by a person → argon2id. Fast hashing here
//           would be a real hole.
//
// Only hashes are stored, so a database dump is not a set of working logins.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
// Explicit .ts extensions: scripts/ reaches this module through
// `node --experimental-strip-types`, which resolves real file paths and will
// not guess an extension. `allowImportingTsExtensions` makes it legal here and
// the bundler resolves it unchanged, so this costs the app nothing.
import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";

export type Role = "OPERATOR" | "STOREKEEPER" | "ADMIN";

/**
 * Who is making this request.
 *
 * §11: *a tablet is not an operator.* It acts for whoever claimed the session,
 * so a ledger write from a tablet must take its `operator_id` from the session
 * row, never from the token. The tablet variant simply has no `operatorId`
 * field — reaching for one is a compile error, which is the same guarantee the
 * Rust extractor gets by returning `None`.
 */
export type Auth =
  | { kind: "TABLET"; tabletId: string }
  | { kind: "OPERATOR"; operatorId: string; role: Role; empCode: string };

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function hashPin(pin: string): Promise<string> {
  return argonHash(pin);
}

/**
 * A well-formed argon2 hash that matches nothing.
 *
 * Verifying against it costs what a real verify costs, so a login for an
 * employee code that does not exist takes the same time as one for a code that
 * does with the wrong PIN. Without it, response time enumerates your staff.
 */
export const DUMMY_PIN_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzYWx0$0000000000000000000000000000000000000000000";

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  try {
    return await argonVerify(stored, pin);
  } catch {
    return false;
  }
}

/**
 * The enrolment secret a device types once during setup.
 *
 * Compared in constant time: it is a shared secret typed by a human, and a
 * naive `===` leaks its length and prefix to anyone who can time the endpoint.
 */
export function enrolmentSecretMatches(supplied: string): boolean {
  const expected = process.env.STORE_ENROLMENT_SECRET;
  if (!expected) {
    throw new ApiError(
      503,
      "NOT_CONFIGURED",
      "STORE_ENROLMENT_SECRET is not set on this deployment",
    );
  }
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/**
 * How coarse "last used" is allowed to be.
 *
 * These two columns are diagnostics — *is this token still in use, is that
 * tablet still on the wall* — and neither is read to the second anywhere. A
 * minute of granularity turns a write on every single authenticated request
 * into roughly one a minute per token, which also takes the row-lock
 * contention with it: the live view polls every 2 s (§4) on the same token the
 * terminal is using.
 */
const TOUCH_INTERVAL = "60 seconds";

/**
 * Resolves the caller, or throws 401.
 *
 * The touch of `api_tokens.last_used_at` and `tablets.last_seen_at` happens
 * **inside this one statement**, and that is not a micro-optimisation.
 *
 * They used to be two `void sql\`…\`.catch(() => {})` calls — fired, never
 * awaited, on every authenticated request. On a serverless platform there is no
 * "after the response": the instance is frozen the moment the response is
 * delivered, so an unawaited query can be suspended part-way through writing
 * its protocol exchange. The backend is then left `active` on `ClientRead`
 * holding an open transaction, waiting for the rest of a message from a process
 * that is not running — and with `max: 1` (db.ts) that is the instance's only
 * connection. Every later request on it queued behind a conversation neither
 * side would ever continue.
 *
 * That is the 2026-08-31 Door outage: `GET /api/v1/admin/devices` hung five
 * times out of five for 40 s at the client, `pg_stat_activity` showed this very
 * SELECT parked on `ClientRead` for 4m55s, and it was reached through
 * `authenticate` — which is to say through the fire-and-forget that had run on
 * the request *before* it.
 *
 * A statement that is awaited cannot be stranded. db.ts's deadline is the
 * backstop for the same failure arriving another way; this is the fix.
 */
export async function authenticate(request: Request): Promise<Auth> {
  const token = bearer(request);
  if (!token) throw ApiError.unauthorized("missing bearer token");

  const rows = await sql<
    {
      id: string;
      kind: "TABLET" | "OPERATOR";
      tablet_id: string | null;
      operator_id: string | null;
      role: Role | null;
      emp_code: string | null;
      active: boolean | null;
    }[]
  >`
    with hit as (
      select t.id, t.kind, t.tablet_id, t.operator_id,
             o.role, o.emp_code, o.active,
             (t.last_used_at is null
               or t.last_used_at < now() - ${TOUCH_INTERVAL}::interval) as stale
        from api_tokens t
        left join operators o on o.id = t.operator_id
       where t.token_hash = ${hashToken(token)}
         and t.revoked_at is null
         and (t.expires_at is null or t.expires_at > now())
       limit 1
    ),
    touched_token as (
      update api_tokens set last_used_at = now()
       where id in (select id from hit where stale)
    ),
    touched_tablet as (
      update tablets set last_seen_at = now()
       where tablet_id in (select tablet_id from hit where stale and kind = 'TABLET')
    )
    select id, kind, tablet_id, operator_id, role, emp_code, active from hit
  `;

  const row = rows[0];
  if (!row) throw ApiError.unauthorized("token is not valid");

  if (row.kind === "TABLET") {
    if (!row.tablet_id) throw ApiError.unauthorized("tablet token has no tablet");
    return { kind: "TABLET", tabletId: row.tablet_id };
  }

  if (!row.operator_id || !row.role || !row.emp_code) {
    throw ApiError.unauthorized("operator token has no operator");
  }
  if (row.active === false) {
    throw ApiError.forbidden("this operator is no longer active");
  }

  return {
    kind: "OPERATOR",
    operatorId: row.operator_id,
    role: row.role,
    empCode: row.emp_code,
  };
}

/** Requires an operator token in one of the given roles. */
export async function requireRole(
  request: Request,
  ...roles: Role[]
): Promise<Extract<Auth, { kind: "OPERATOR" }>> {
  const auth = await authenticate(request);
  if (auth.kind !== "OPERATOR") {
    throw ApiError.forbidden("this endpoint needs an operator login, not a device token");
  }
  if (!roles.includes(auth.role)) {
    throw ApiError.forbidden(`needs one of: ${roles.join(", ")}`);
  }
  return auth;
}

export async function issueToken(
  subject: { kind: "TABLET"; tabletId: string } | { kind: "OPERATOR"; operatorId: string },
  expiresInHours?: number,
): Promise<string> {
  const token = newToken();
  const expires = expiresInHours
    ? new Date(Date.now() + expiresInHours * 3_600_000)
    : null;

  await sql`
    insert into api_tokens (token_hash, kind, tablet_id, operator_id, expires_at)
    values (
      ${hashToken(token)},
      ${subject.kind},
      ${subject.kind === "TABLET" ? subject.tabletId : null},
      ${subject.kind === "OPERATOR" ? subject.operatorId : null},
      ${expires}
    )
  `;

  return token;
}
