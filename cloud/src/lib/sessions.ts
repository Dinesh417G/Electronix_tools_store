// Session reads and writes (CLAUDE.md §10). The rules live in `session.ts`;
// this file only persists what the machine decides.

import { sql } from "./db.ts";
import { ApiError } from "./api-error.ts";
import { verifyPin, DUMMY_PIN_HASH, type Auth } from "./auth.ts";
import {
  effectiveState,
  IDLE_TIMEOUT_MS,
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
 *
 * The claim was the exception, and it is the one that mattered. Its guard read
 * `state in ('UNCLAIMED', 'ACTIVE')`, which admits exactly the row it exists to
 * exclude: two tablets claiming the same card both read UNCLAIMED, both pass
 * the pure machine, and the second UPDATE then matches the row the first had
 * just made ACTIVE — overwriting `tablet_id`. Both tablets were answered 200,
 * and the loser was handed the winner's id in its own response. Measured six
 * times out of six against the running app, so this was not a narrow race; two
 * claims arriving together is §10's tailgating case, the exact scenario the
 * claim screen exists for.
 *
 * `crates/store-db/src/sessions.rs` had it right all along — the guard below is
 * that one, and the zero-rows branch reports the holder the way it does. Parity
 * rather than a new rule, like the `reverse()` machine_id defect before it.
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
    case "ACTIVE": {
      // `state = 'ACTIVE' and tablet_id = …` is what keeps a re-claim by the
      // *same* tablet idempotent — a retry after a reconnect is not a conflict
      // — without letting a *different* one take the session off it.
      const claimed = await sql`
        update sessions
           set state = 'ACTIVE',
               tablet_id = ${next.tabletId},
               claimed_at = coalesce(claimed_at, now()),
               last_activity_at = now()
         where id = ${sessionId}
           and (state = 'UNCLAIMED' or (state = 'ACTIVE' and tablet_id = ${next.tabletId}))
        returning id
      `;

      if (claimed.length === 0) {
        // Somebody else got there between our read and our write. Re-read, so
        // the answer names whoever actually holds it rather than guessing.
        const winner = await getSession(sessionId);
        const holder = winner.tablet_id;
        if (holder && holder !== next.tabletId) {
          raise({ ok: false, error: { kind: "ALREADY_CLAIMED", claimedBy: holder } });
        }
        raise({ ok: false, error: { kind: "SESSION_CLOSED" } });
      }
      break;
    }
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
 * idle timeout measures idleness rather than elapsed time.
 *
 * The window is in the WHERE clause, and that is the whole point. `state` is
 * the *stored* column, and §10's reapers do not exist here — a session idle for
 * an hour is still stored ACTIVE, because nothing sweeps it and nothing will.
 * Guarding on `state = 'ACTIVE'` alone therefore matched exactly the rows this
 * was written to protect, and pushed `last_activity_at` to now(): one keepalive
 * revived a session the API had already refused an issue against, and the next
 * issue wrote a ledger row. The terminal fires this every 60 s and on every
 * step, so the 180 s idle close could not close anything.
 *
 * `IDLE_TIMEOUT_MS` is the same constant `effectiveState` reads, so the two
 * cannot drift.
 */
export async function touchSession(sessionId: string): Promise<void> {
  await sql`
    update sessions set last_activity_at = now()
     where id = ${sessionId}
       and state = 'ACTIVE'
       and last_activity_at > now() - make_interval(secs => ${IDLE_TIMEOUT_MS / 1000})
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
