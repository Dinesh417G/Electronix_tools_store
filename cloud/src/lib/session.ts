// The session claim state machine (CLAUDE.md §10), ported from
// `crates/store-core/src/session.rs`.
//
// The Rust original is an exhaustive `match` over (state, event) with every
// illegal pair written out, so adding a state or an event breaks the build
// instead of falling into a catch-all. TypeScript has no exhaustive match, so
// the same guarantee is bought with discriminated unions and `assertNever`:
// every arm is still explicit, and an unhandled pair fails `tsc`.

export const CLAIM_WINDOW_MS = 90_000; // §10: unclaimed punches expire at 90 s
export const IDLE_TIMEOUT_MS = 180_000; // §10: measured from last_activity_at

export type CloseReason = "SUBMITTED" | "DONE" | "IDLE_TIMEOUT";

export type SessionState =
  | { state: "UNCLAIMED" }
  | { state: "ACTIVE"; tabletId: string }
  | { state: "CLOSED"; tabletId: string; reason: CloseReason }
  | { state: "EXPIRED" };

export type SessionEvent =
  | { event: "CLAIM"; tabletId: string }
  | { event: "SUBMIT" }
  | { event: "DONE" }
  | { event: "IDLE_TIMEOUT" }
  | { event: "CLAIM_WINDOW_ELAPSED" };

export type TransitionError =
  | { kind: "ALREADY_CLAIMED"; claimedBy: string }
  | { kind: "SESSION_CLOSED" }
  | { kind: "SESSION_EXPIRED" }
  | { kind: "NOT_CLAIMED" }
  | { kind: "CLAIM_WINDOW_NOT_APPLICABLE"; state: string };

export type Transition =
  | { ok: true; next: SessionState }
  | { ok: false; error: TransitionError };

function assertNever(x: never): never {
  throw new Error(`unhandled case: ${JSON.stringify(x)}`);
}

const ok = (next: SessionState): Transition => ({ ok: true, next });
const err = (error: TransitionError): Transition => ({ ok: false, error });

/**
 * Two deliberate idempotencies, both so a flaky network cannot produce a
 * spurious error:
 *
 *  - the *same* tablet re-claiming a session it already holds succeeds, which
 *    is what a tablet does after a reconnect;
 *  - a terminal state absorbs terminal-producing events, so a sweep racing a
 *    normal close is benign.
 *
 * What a terminal state never absorbs is CLAIM or SUBMIT: those would
 * resurrect a finished session or accept work against it.
 */
export function transition(state: SessionState, event: SessionEvent): Transition {
  switch (state.state) {
    // ── UNCLAIMED ──────────────────────────────────────────────────────
    case "UNCLAIMED":
      switch (event.event) {
        case "CLAIM":
          return ok({ state: "ACTIVE", tabletId: event.tabletId });
        case "SUBMIT":
          return err({ kind: "NOT_CLAIMED" });
        case "DONE":
          return err({ kind: "NOT_CLAIMED" });
        // The idle timer only runs once a tablet has claimed the session, so
        // seeing this against an unclaimed row means the sweep picked the
        // wrong rows.
        case "IDLE_TIMEOUT":
          return err({ kind: "NOT_CLAIMED" });
        case "CLAIM_WINDOW_ELAPSED":
          return ok({ state: "EXPIRED" });
        default:
          return assertNever(event);
      }

    // ── ACTIVE ─────────────────────────────────────────────────────────
    case "ACTIVE":
      switch (event.event) {
        case "CLAIM":
          return event.tabletId === state.tabletId
            ? ok({ state: "ACTIVE", tabletId: state.tabletId })
            : err({ kind: "ALREADY_CLAIMED", claimedBy: state.tabletId });
        case "SUBMIT":
          return ok({ state: "CLOSED", tabletId: state.tabletId, reason: "SUBMITTED" });
        case "DONE":
          return ok({ state: "CLOSED", tabletId: state.tabletId, reason: "DONE" });
        case "IDLE_TIMEOUT":
          return ok({ state: "CLOSED", tabletId: state.tabletId, reason: "IDLE_TIMEOUT" });
        case "CLAIM_WINDOW_ELAPSED":
          return err({ kind: "CLAIM_WINDOW_NOT_APPLICABLE", state: "ACTIVE" });
        default:
          return assertNever(event);
      }

    // ── CLOSED (terminal) ──────────────────────────────────────────────
    case "CLOSED":
      switch (event.event) {
        case "CLAIM":
          return err({ kind: "SESSION_CLOSED" });
        case "SUBMIT":
          return err({ kind: "SESSION_CLOSED" });
        case "DONE":
        case "IDLE_TIMEOUT":
        case "CLAIM_WINDOW_ELAPSED":
          return ok(state);
        default:
          return assertNever(event);
      }

    // ── EXPIRED (terminal) ─────────────────────────────────────────────
    case "EXPIRED":
      switch (event.event) {
        case "CLAIM":
          return err({ kind: "SESSION_EXPIRED" });
        case "SUBMIT":
          return err({ kind: "SESSION_EXPIRED" });
        case "DONE":
        case "IDLE_TIMEOUT":
        case "CLAIM_WINDOW_ELAPSED":
          return ok(state);
        default:
          return assertNever(event);
      }

    default:
      return assertNever(state);
  }
}

export function isTerminal(state: SessionState): boolean {
  return state.state === "CLOSED" || state.state === "EXPIRED";
}

/** §10 maps these onto the status codes the terminal UX depends on. */
export function statusFor(error: TransitionError): number {
  switch (error.kind) {
    case "ALREADY_CLAIMED":
      return 409; // the tablet shows which tablet holds it
    case "SESSION_CLOSED":
    case "SESSION_EXPIRED":
      return 410; // the tablet re-opens the claim screen, keeping the typing
    case "NOT_CLAIMED":
    case "CLAIM_WINDOW_NOT_APPLICABLE":
      return 409;
    default:
      return assertNever(error);
  }
}

/**
 * What the stored row *means* right now.
 *
 * The Rust server ran two background reapers for this. Vercel has no
 * persistent process and hobby cron runs daily, which is useless against a
 * 90 s window — so expiry and idle close are derived on read instead, and a
 * cron sweep becomes housekeeping rather than correctness. A row is never
 * trusted to be UNCLAIMED past its window just because nothing has updated it.
 */
export function effectiveState(row: {
  state: string;
  tablet_id: string | null;
  close_reason: string | null;
  opened_at: Date;
  last_activity_at: Date;
}, now: Date = new Date()): SessionState {
  switch (row.state) {
    case "UNCLAIMED":
      return now.getTime() - row.opened_at.getTime() >= CLAIM_WINDOW_MS
        ? { state: "EXPIRED" }
        : { state: "UNCLAIMED" };
    case "ACTIVE": {
      const tabletId = row.tablet_id ?? "";
      return now.getTime() - row.last_activity_at.getTime() >= IDLE_TIMEOUT_MS
        ? { state: "CLOSED", tabletId, reason: "IDLE_TIMEOUT" }
        : { state: "ACTIVE", tabletId };
    }
    case "CLOSED":
      return {
        state: "CLOSED",
        tabletId: row.tablet_id ?? "",
        reason: (row.close_reason as CloseReason) ?? "DONE",
      };
    case "EXPIRED":
      return { state: "EXPIRED" };
    default:
      throw new Error(`unknown session state in database: ${row.state}`);
  }
}
