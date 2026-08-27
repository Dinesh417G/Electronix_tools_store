// Session reads and writes (CLAUDE.md §10). The rules live in `session.ts`;
// this file only persists what the machine decides.

import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";
import { verifyPin, DUMMY_PIN_HASH, type Auth } from "./auth.ts";
import {
  effectiveState,
  statusFor,
  transition,
  type CloseReason,
  type SessionEvent,
  type SessionState,
} from "./session.ts";

export interface SessionRow {
  id: string;
  operator_id: string;
  punch_id: string | null;
  state: string;
  manual_identity: boolean;
  opened_at: Date;
  claimed_at: Date | null;
  closed_at: Date | null;
  last_activity_at: Date;
  tablet_id: string | null;
  close_reason: string | null;
  emp_code: string;
  full_name: string;
  department: string | null;
}

export async function getSession(id: string): Promise<SessionRow> {
  const rows = await sql<SessionRow[]>`
    select s.*, o.emp_code, o.full_name, o.department
      from sessions s
      join operators o on o.id = s.operator_id
     where s.id = ${id}
     limit 1
  `;
  const row = rows[0];
  if (!row) throw ApiError.notFound("no such session");
  return row;
}

function raise(error: ReturnType<typeof transition>): never {
  if (error.ok) throw new Error("raise called on a successful transition");
  const status = statusFor(error.error);
  const message =
    error.error.kind === "ALREADY_CLAIMED"
      ? `That session is already open on ${error.error.claimedBy}.`
      : error.error.kind === "SESSION_CLOSED" || error.error.kind === "SESSION_EXPIRED"
        ? "That session has closed."
        : "That session cannot accept this right now.";
  throw new ApiError(status, error.error.kind, message);
}

/**
 * Check that the session is live, belongs to this tablet, and yield the
 * operator to bill the movement to.
 *
 * §11: a ledger write from a tablet takes its operator from the *session*,
 * never from the token — the tablet acts for whoever claimed the card. That is
 * why this returns an operator id rather than the caller trusting `auth`.
 */
export async function authoriseSession(auth: Auth, sessionId: string): Promise<string> {
  const row = await getSession(sessionId);
  const state = effectiveState(row);

  if (auth.kind === "TABLET") {
    // Re-using the claim arm means one definition of "this tablet may work
    // here" rather than two that drift apart.
    const result = transition(state, { event: "CLAIM", tabletId: auth.tabletId });
    if (!result.ok) raise(result);
  } else if (state.state === "CLOSED" || state.state === "EXPIRED") {
    // The admin console may post against a session too, but it must be live.
    throw ApiError.gone("That session has closed.");
  }

  return row.operator_id;
}

/**
 * Apply an event and persist the result.
 *
 * Every write is guarded on the state it expects, so two racing requests
 * cannot both win: the loser's UPDATE matches no rows and it re-reads.
 */
export async function applyEvent(
  sessionId: string,
  event: SessionEvent,
): Promise<SessionState> {
  const row = await getSession(sessionId);
  const current = effectiveState(row);
  const result = transition(current, event);
  if (!result.ok) raise(result);

  const next = result.next;

  switch (next.state) {
    case "ACTIVE":
      await sql`
        update sessions
           set state = 'ACTIVE',
               tablet_id = ${next.tabletId},
               claimed_at = coalesce(claimed_at, now()),
               last_activity_at = now()
         where id = ${sessionId} and state in ('UNCLAIMED', 'ACTIVE')
      `;
      break;
    case "CLOSED":
      // Terminal states absorb their own events, so a second close is a no-op
      // rather than an error — which is what a tablet on a flaky LAN needs.
      await sql`
        update sessions
           set state = 'CLOSED', close_reason = ${next.reason}, closed_at = now()
         where id = ${sessionId} and state = 'ACTIVE'
      `;
      break;
    case "EXPIRED":
      await sql`
        update sessions
           set state = 'EXPIRED', closed_at = now()
         where id = ${sessionId} and state = 'UNCLAIMED'
      `;
      break;
    case "UNCLAIMED":
      break;
  }

  return next;
}

export async function closeSession(sessionId: string, reason: CloseReason) {
  const event: SessionEvent =
    reason === "SUBMITTED"
      ? { event: "SUBMIT" }
      : reason === "DONE"
        ? { event: "DONE" }
        : { event: "IDLE_TIMEOUT" };
  return applyEvent(sessionId, event);
}

/**
 * §10: the terminal posts this as the operator moves between steps, so the
 * idle timeout measures idleness rather than elapsed time. Guarded on ACTIVE so
 * a late keepalive cannot resurrect a closed session.
 */
export async function touchSession(sessionId: string): Promise<void> {
  await sql`
    update sessions set last_activity_at = now()
     where id = ${sessionId} and state = 'ACTIVE'
  `;
}

/**
 * The claim screen: every session still inside its 90 s window (§10).
 *
 * Tailgating is solved socially — two people walk in on one punch, two cards
 * appear, each taps their own. The window is applied in SQL rather than
 * filtered afterwards so a stale row can never reach the screen.
 */
export async function unclaimedSessions(): Promise<
  {
    session_id: string;
    operator_id: string;
    emp_code: string;
    full_name: string;
    department: string | null;
    opened_at: Date;
    expires_in_secs: number;
  }[]
> {
  return sql`
    select s.id as session_id, s.operator_id, o.emp_code, o.full_name,
           o.department, s.opened_at,
           greatest(0, ceil(extract(epoch from (
             s.opened_at + interval '90 seconds' - now()
           ))))::int as expires_in_secs
      from sessions s
      join operators o on o.id = s.operator_id
     where s.state = 'UNCLAIMED'
       and s.opened_at > now() - interval '90 seconds'
     order by s.opened_at desc
  `;
}

/**
 * §10's fallback when no punch arrives — device down, network down, or a reader
 * that will not read this particular finger.
 *
 * The session it opens is ACTIVE immediately: there is no card for anyone to
 * claim. It carries `manual_identity = true`, which is what makes it weaker
 * evidence in reports than a fingerprint at the door, and the check constraint
 * pins that to having no punch.
 */
export async function openManualSession(
  empCode: string,
  pin: string,
  tabletId: string,
): Promise<SessionRow> {
  const rows = await sql<{ id: string; pin_hash: string | null; active: boolean }[]>`
    select id, pin_hash, active from operators where emp_code = ${empCode} limit 1
  `;
  const operator = rows[0];

  // One message for every failure, and the argon2 cost is paid either way, so
  // an unknown employee code is not distinguishable from a wrong PIN.
  const refuse = () => ApiError.unauthorized("Employee code or PIN is not right.");
  if (!operator?.pin_hash || !operator.active) {
    await verifyPin(pin, DUMMY_PIN_HASH);
    throw refuse();
  }
  if (!(await verifyPin(pin, operator.pin_hash))) throw refuse();

  // `identity_source` is not optional here, whatever the column default says.
  // 0007 added `sessions_identity_source_matches_punch`, which requires
  // PUNCH exactly when there is a punch — and this session has none. Leaving it
  // to the default meant every manual sign-in was refused by the constraint,
  // which is §10's fallback for "the reader is down" and, before a reader is
  // installed at all, the only way in. The migration backfilled the rows it
  // found; nothing updated the code that writes new ones.
  //
  // §8: PIN is the weakest of the three identities and `manual_identity` stays
  // true, because both facts are read by the reports.
  const created = await sql<{ id: string }[]>`
    insert into sessions (operator_id, punch_id, state, manual_identity,
                          identity_source, tablet_id, claimed_at)
    values (${operator.id}, null, 'ACTIVE', true, 'PIN', ${tabletId}, now())
    returning id
  `;

  return getSession(created[0].id);
}
