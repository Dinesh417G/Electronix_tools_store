// The M3 acceptance gate (CLAUDE.md §13), on the cloud side.
//
//   > Exhaustive transition tests: tailgating (2 unclaimed, 2 claims), expiry,
//   > double-claim rejection, post-close submit → 410
//
// §14 named this as the second gate the cloud implementation did not meet.
// `crates/store-core/src/session.rs` carries the sweep in its test module,
// where the compiler is already refusing a non-exhaustive `match` — the test
// there is a second opinion. Here it is the *only* opinion, which §10 says in
// as many words:
//
//   > The TypeScript port owes the same exhaustiveness; without a compiler
//   > that demands it, a missing pair is a silent `undefined` rather than a
//   > build failure.
//
// So this file checks two different things, and the second is the one with no
// Rust counterpart at all:
//
//   1. every (state, event) pair has an explicit outcome, with the same
//      12 legal / 8 refused split the Rust sweep asserts;
//   2. `effectiveState` — the derive-on-read rule that replaced the two
//      background reapers when the system moved to Vercel (§10). A stored row
//      may lag the truth; no read of it may.
//
// No database: the machine is pure, and keeping it that way is what lets this
// run in CI before Postgres is even up.
//
//   node --experimental-strip-types tests/session-transitions.mjs

import {
  CLAIM_WINDOW_MS,
  IDLE_TIMEOUT_MS,
  effectiveState,
  isTerminal,
  statusFor,
  transition,
} from "../src/lib/session.ts";

const pass = [];
const fail = [];
const ok = (m) => { pass.push(m); console.log("  PASS  " + m); };
const bad = (m) => { fail.push(m); console.log("  FAIL  " + m); };
const step = (n) => console.log("\n" + n);

const show = (x) => JSON.stringify(x);

function expectOk(label, result, predicate) {
  if (!result.ok) return bad(`${label}: refused with ${show(result.error)}`);
  if (predicate && !predicate(result.next)) {
    return bad(`${label}: allowed, but landed on ${show(result.next)}`);
  }
  ok(label);
}

function expectErr(label, result, kind) {
  if (result.ok) return bad(`${label}: allowed, landing on ${show(result.next)}`);
  if (result.error.kind !== kind) {
    return bad(`${label}: refused with ${result.error.kind}, expected ${kind}`);
  }
  ok(label);
}

// ── The four states and five events, written out ─────────────────────
const UNCLAIMED = { state: "UNCLAIMED" };
const ACTIVE = { state: "ACTIVE", tabletId: "TAB-1" };
const CLOSED = { state: "CLOSED", tabletId: "TAB-1", reason: "SUBMITTED" };
const EXPIRED = { state: "EXPIRED" };
const STATES = [UNCLAIMED, ACTIVE, CLOSED, EXPIRED];

const EVENTS = [
  { event: "CLAIM", tabletId: "TAB-1" },
  { event: "SUBMIT" },
  { event: "DONE" },
  { event: "IDLE_TIMEOUT" },
  { event: "CLAIM_WINDOW_ELAPSED" },
];

// ── 1. Exhaustiveness ────────────────────────────────────────────────
step("1. every (state, event) pair has an explicit outcome");
{
  let legal = 0;
  let refused = 0;
  let broken = 0;

  for (const state of STATES) {
    for (const event of EVENTS) {
      let result;
      try {
        result = transition(state, event);
      } catch (e) {
        broken++;
        bad(`${state.state} + ${event.event} threw: ${e.message}`);
        continue;
      }

      if (result === undefined || typeof result?.ok !== "boolean") {
        broken++;
        bad(`${state.state} + ${event.event} returned ${show(result)} — the silent undefined §10 warns about`);
        continue;
      }

      if (result.ok) {
        legal++;
        // A refusal is the only way out of a terminal state.
        if (isTerminal(state) && show(result.next) !== show(state)) {
          bad(`terminal ${state.state} changed to ${show(result.next)} on ${event.event}`);
        }
      } else {
        refused++;
      }
    }
  }

  const total = STATES.length * EVENTS.length;
  if (broken === 0 && legal + refused === total) {
    ok(`all ${total} pairs resolved explicitly`);
  } else {
    bad(`${broken} pairs produced no usable outcome`);
  }

  // The same split the Rust sweep asserts. If a transition's legality changes,
  // both tests must be updated together — which is the point of pinning it.
  if (legal === 12) ok("12 pairs are legal, matching the Rust sweep");
  else bad(`${legal} pairs are legal, the Rust sweep says 12`);

  if (refused === 8) ok("8 pairs are refused, matching the Rust sweep");
  else bad(`${refused} pairs are refused, the Rust sweep says 8`);
}

// ── 2. A punch offers a session; it does not become one ──────────────
step("2. an unclaimed session accepts no work");
expectErr("UNCLAIMED + SUBMIT is NOT_CLAIMED", transition(UNCLAIMED, { event: "SUBMIT" }), "NOT_CLAIMED");
expectErr("UNCLAIMED + DONE is NOT_CLAIMED", transition(UNCLAIMED, { event: "DONE" }), "NOT_CLAIMED");
// The idle timer only starts once a tablet has claimed, so this pair firing
// means a sweep selected the wrong rows.
expectErr(
  "UNCLAIMED + IDLE_TIMEOUT is NOT_CLAIMED",
  transition(UNCLAIMED, { event: "IDLE_TIMEOUT" }),
  "NOT_CLAIMED",
);

// ── 3. Tailgating ────────────────────────────────────────────────────
//
// §10 solves two people entering on one punch socially: each punch offers its
// own session and each person taps their own card. The machine's part is that
// the two claims are independent — one must not disturb the other.
step("3. tailgating: two unclaimed sessions, two independent claims");
{
  const first = transition(UNCLAIMED, { event: "CLAIM", tabletId: "TAB-1" });
  const second = transition(UNCLAIMED, { event: "CLAIM", tabletId: "TAB-2" });

  expectOk("first claim binds TAB-1", first, (s) => s.state === "ACTIVE" && s.tabletId === "TAB-1");
  expectOk("second claim binds TAB-2", second, (s) => s.state === "ACTIVE" && s.tabletId === "TAB-2");

  if (first.ok && second.ok && first.next.tabletId !== second.next.tabletId) {
    ok("the two sessions are bound to different tablets");
  } else {
    bad("the two claims did not stay independent");
  }
}

// ── 4. Double claim ──────────────────────────────────────────────────
step("4. a claimed session belongs to one tablet");
{
  const stolen = transition(ACTIVE, { event: "CLAIM", tabletId: "TAB-2" });
  expectErr("a second tablet is refused", stolen, "ALREADY_CLAIMED");
  if (!stolen.ok && stolen.error.claimedBy === "TAB-1") {
    // §11: the tablet shows *which* tablet holds it, so the error must carry it.
    ok("the refusal names the holding tablet, which the terminal displays");
  } else if (!stolen.ok) {
    bad(`the refusal named ${show(stolen.error.claimedBy)} instead of TAB-1`);
  }

  // A tablet that reconnects re-claims what it already holds. Making that an
  // error would turn a flaky network into a lost session.
  expectOk(
    "the holding tablet may re-claim after a reconnect",
    transition(ACTIVE, { event: "CLAIM", tabletId: "TAB-1" }),
    (s) => s.state === "ACTIVE" && s.tabletId === "TAB-1",
  );
}

// ── 5. Expiry ────────────────────────────────────────────────────────
step("5. an unclaimed punch expires, and expiry is terminal");
expectOk(
  "UNCLAIMED + CLAIM_WINDOW_ELAPSED expires",
  transition(UNCLAIMED, { event: "CLAIM_WINDOW_ELAPSED" }),
  (s) => s.state === "EXPIRED",
);
expectErr("EXPIRED refuses a late claim", transition(EXPIRED, { event: "CLAIM", tabletId: "TAB-1" }), "SESSION_EXPIRED");
expectErr("EXPIRED refuses work", transition(EXPIRED, { event: "SUBMIT" }), "SESSION_EXPIRED");
expectErr(
  "an ACTIVE session is past the claim window's business",
  transition(ACTIVE, { event: "CLAIM_WINDOW_ELAPSED" }),
  "CLAIM_WINDOW_NOT_APPLICABLE",
);

// ── 6. Close, and work after it ──────────────────────────────────────
step("6. submitting closes the session, and work after that is refused");
expectOk(
  "ACTIVE + SUBMIT closes as SUBMITTED",
  transition(ACTIVE, { event: "SUBMIT" }),
  (s) => s.state === "CLOSED" && s.reason === "SUBMITTED" && s.tabletId === "TAB-1",
);
expectOk(
  "ACTIVE + DONE closes as DONE",
  transition(ACTIVE, { event: "DONE" }),
  (s) => s.state === "CLOSED" && s.reason === "DONE",
);
expectOk(
  "ACTIVE + IDLE_TIMEOUT closes as IDLE_TIMEOUT",
  transition(ACTIVE, { event: "IDLE_TIMEOUT" }),
  (s) => s.state === "CLOSED" && s.reason === "IDLE_TIMEOUT",
);
expectErr("CLOSED refuses a submit", transition(CLOSED, { event: "SUBMIT" }), "SESSION_CLOSED");
expectErr("CLOSED refuses a claim", transition(CLOSED, { event: "CLAIM", tabletId: "TAB-1" }), "SESSION_CLOSED");

// ── 7. Terminal states absorb, but never resurrect ───────────────────
step("7. terminal states absorb terminal events without changing");
for (const terminal of [CLOSED, EXPIRED]) {
  for (const event of ["DONE", "IDLE_TIMEOUT", "CLAIM_WINDOW_ELAPSED"]) {
    const result = transition(terminal, { event });
    if (result.ok && show(result.next) === show(terminal)) {
      ok(`${terminal.state} absorbs ${event} unchanged`);
    } else {
      bad(`${terminal.state} + ${event} gave ${show(result)}`);
    }
  }
}

// ── 8. The status codes §11 hangs terminal behaviour on ──────────────
step("8. statusFor is total, and pins §11's codes");
{
  const kinds = [
    ["ALREADY_CLAIMED", 409, "the tablet shows which tablet holds it"],
    ["SESSION_CLOSED", 410, "the tablet re-opens the claim screen, keeping the typing"],
    ["SESSION_EXPIRED", 410, "the tablet re-opens the claim screen"],
    ["NOT_CLAIMED", 409, ""],
    ["CLAIM_WINDOW_NOT_APPLICABLE", 409, ""],
  ];
  for (const [kind, expected, why] of kinds) {
    const got = statusFor({ kind, claimedBy: "TAB-1", state: "ACTIVE" });
    if (got === expected) ok(`${kind} → ${expected}${why ? " — " + why : ""}`);
    else bad(`${kind} → ${got}, expected ${expected}`);
  }
}

// ── 9. The silent undefined §10 warns about ──────────────────────────
//
// The Rust machine cannot compile with a missing arm. TypeScript can, and the
// failure mode is not an exception but `undefined` flowing onward — a session
// that is neither allowed nor refused. `assertNever` is what converts that
// into a loud failure, so it is worth proving it actually throws.
step("9. an unknown event is a loud failure, not a silent undefined");
{
  let threw = false;
  try {
    transition(ACTIVE, { event: "NOT_A_REAL_EVENT" });
  } catch {
    threw = true;
  }
  if (threw) ok("assertNever threw on an unhandled event rather than returning undefined");
  else bad("an unhandled event produced no error — a missing arm would pass silently");
}

// ── 10. Derive-on-read: the half with no Rust counterpart ────────────
//
// §10: the two background reapers do not exist on Vercel, so a stored row is
// never trusted to still mean what it says. This is the rule that replaced
// them, and the one a new query bypasses by filtering on `state` directly.
step("10. effectiveState derives expiry and idle close on read");
{
  const now = new Date("2026-08-27T12:00:00.000Z");
  const ago = (ms) => new Date(now.getTime() - ms);

  const row = (over) => ({
    state: "UNCLAIMED",
    tablet_id: null,
    close_reason: null,
    opened_at: ago(over),
    last_activity_at: ago(over),
  });

  const justInside = effectiveState(row(CLAIM_WINDOW_MS - 1), now);
  if (justInside.state === "UNCLAIMED") ok("an unclaimed punch 89.999 s old is still offerable");
  else bad(`89.999 s old read as ${justInside.state}`);

  const onTheLine = effectiveState(row(CLAIM_WINDOW_MS), now);
  if (onTheLine.state === "EXPIRED") ok("at exactly 90 s it has expired — the boundary is inclusive");
  else bad(`exactly 90 s read as ${onTheLine.state}`);

  const wellPast = effectiveState(row(CLAIM_WINDOW_MS * 10), now);
  if (wellPast.state === "EXPIRED") ok("a stored UNCLAIMED row 15 min old reads as EXPIRED, with no reaper involved");
  else bad(`15 min old read as ${wellPast.state}`);

  const active = (idleFor, openedFor) => ({
    state: "ACTIVE",
    tablet_id: "TAB-1",
    close_reason: null,
    opened_at: ago(openedFor ?? idleFor),
    last_activity_at: ago(idleFor),
  });

  const working = effectiveState(active(IDLE_TIMEOUT_MS - 1), now);
  if (working.state === "ACTIVE") ok("179.999 s since the last touch is still ACTIVE");
  else bad(`179.999 s idle read as ${working.state}`);

  const idled = effectiveState(active(IDLE_TIMEOUT_MS), now);
  if (idled.state === "CLOSED" && idled.reason === "IDLE_TIMEOUT") {
    ok("at exactly 180 s idle it reads CLOSED / IDLE_TIMEOUT");
  } else {
    bad(`exactly 180 s idle read as ${show(idled)}`);
  }

  // §10: "Idle means idle." The timeout is measured from last_activity_at, not
  // from opened_at — otherwise 180 s becomes a deadline on the whole
  // transaction rather than a timeout on abandonment, and sessions die under
  // operators who are actively working.
  const busyForAnHour = effectiveState(active(5_000, 3_600_000), now);
  if (busyForAnHour.state === "ACTIVE") {
    ok("an hour-old session touched 5 s ago is ACTIVE — idle is measured from the touch, not the punch");
  } else {
    bad(`an actively-worked session read as ${show(busyForAnHour)}`);
  }

  const closed = effectiveState(
    { state: "CLOSED", tablet_id: "TAB-1", close_reason: "SUBMITTED", opened_at: ago(0), last_activity_at: ago(0) },
    now,
  );
  if (closed.state === "CLOSED" && closed.reason === "SUBMITTED") ok("a stored CLOSED row keeps its reason");
  else bad(`stored CLOSED read as ${show(closed)}`);

  const expired = effectiveState(
    { state: "EXPIRED", tablet_id: null, close_reason: null, opened_at: ago(0), last_activity_at: ago(0) },
    now,
  );
  if (expired.state === "EXPIRED") ok("a stored EXPIRED row stays EXPIRED");
  else bad(`stored EXPIRED read as ${show(expired)}`);

  let threw = false;
  try {
    effectiveState(
      { state: "HALF_CLAIMED", tablet_id: null, close_reason: null, opened_at: ago(0), last_activity_at: ago(0) },
      now,
    );
  } catch {
    threw = true;
  }
  if (threw) ok("a state the machine cannot produce throws rather than being guessed at");
  else bad("an unknown stored state was silently accepted");
}

// ── 11. The two views agree ──────────────────────────────────────────
//
// A session that has aged out must be refused by the same error the machine
// would have produced had a reaper closed it. §10: "a write against a session
// that has aged out is refused exactly as if a reaper had closed it."
step("11. an aged-out session refuses work the same way a reaped one does");
{
  const now = new Date("2026-08-27T12:00:00.000Z");
  const aged = effectiveState(
    {
      state: "ACTIVE",
      tablet_id: "TAB-1",
      close_reason: null,
      opened_at: new Date(now.getTime() - IDLE_TIMEOUT_MS * 2),
      last_activity_at: new Date(now.getTime() - IDLE_TIMEOUT_MS * 2),
    },
    now,
  );
  const result = transition(aged, { event: "SUBMIT" });
  if (!result.ok && statusFor(result.error) === 410) {
    ok("submitting to an idled-out session is refused 410, as §11's table requires");
  } else {
    bad(`aged-out submit gave ${show(result)}`);
  }

  const staleUnclaimed = effectiveState(
    {
      state: "UNCLAIMED",
      tablet_id: null,
      close_reason: null,
      opened_at: new Date(now.getTime() - CLAIM_WINDOW_MS * 2),
      last_activity_at: new Date(now.getTime() - CLAIM_WINDOW_MS * 2),
    },
    now,
  );
  const late = transition(staleUnclaimed, { event: "CLAIM", tabletId: "TAB-9" });
  if (!late.ok && late.error.kind === "SESSION_EXPIRED" && statusFor(late.error) === 410) {
    ok("claiming a punch that aged out is refused 410, not silently accepted");
  } else {
    bad(`late claim gave ${show(late)}`);
  }
}

console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length === 0 ? 0 : 1);
