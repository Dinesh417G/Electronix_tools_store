// The live wire.
//
// §4 said: "Tablets subscribe to `GET /api/v1/sessions/stream` (SSE). When a
// punch arrives the server emits `session.opened` and the tablet foregrounds
// the IN/OUT panel. **No polling.**"
//
// That endpoint does not exist in this deployment, and the reason is
// structural rather than lazy. SSE needs a process that stays alive holding the
// socket; Vercel gives request-scoped functions with a duration cap, so an open
// stream is a countdown to a reconnect rather than a subscription. Paying a
// function invocation to sit idle is also the most expensive way to learn that
// nothing has happened.
//
// So this polls, and says so. The cost is honest and small: one cheap indexed
// query every two seconds while the terminal is on the claim screen, which is
// the only moment freshness matters. A punch shows up within two seconds of the
// finger leaving the reader — below what anyone walking from a door to a tablet
// would notice.
//
// The upgrade path is Supabase Realtime: it holds the socket outside our
// functions, and this module is the only place that would change. `ServerEvent`
// keeps its original shape for exactly that reason.

import { api, getToken } from "./api";

export type ServerEvent =
  | {
      type: "session.opened";
      session_id: string;
      operator_id: string;
      emp_code: string;
      full_name: string;
      opened_at: string;
      expires_in_secs: number;
    }
  | { type: "session.claimed"; session_id: string; tablet_id: string }
  | { type: "session.closed"; session_id: string; reason: string }
  | {
      type: "alert.raised";
      item_id: string;
      item_code: string;
      description: string;
      level: string;
      on_hand: string;
    }
  | {
      type: "punch.unknown_user";
      zk_user_id: string;
      device_serial: string;
      received_at: string;
    }
  | { type: "heartbeat"; at: string };

export type ConnectionState = "connecting" | "live" | "offline";

interface Options {
  onEvent: (event: ServerEvent) => void;
  onStateChange?: (state: ConnectionState) => void;
  /** Kept short: this is what "a card appeared" latency actually is. */
  intervalMs?: number;
}

/**
 * Watch for new session offers, reconnecting on its own. Returns a teardown.
 *
 * A stale claim screen is worse than one that admits it is stale, so the
 * connection state is surfaced rather than swallowed: two consecutive failures
 * flip the pill to "offline", and any success flips it back.
 */
export function subscribeToEvents({
  onEvent,
  onStateChange,
  intervalMs = 2000,
}: Options): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let state: ConnectionState = "connecting";

  // Sessions already reported, so a card that stays on screen for its whole
  // 90 s window fires `session.opened` once rather than forty-five times.
  const seen = new Set<string>();
  const seenPunches = new Set<string>();

  // Only punches from after the terminal came up. Replaying yesterday's
  // unknown-user notices at every reload would train people to ignore them.
  const startedAt = new Date().toISOString();

  const setState = (next: ConnectionState) => {
    if (next === state) return;
    state = next;
    onStateChange?.(next);
  };

  const tick = async () => {
    if (stopped) return;

    try {
      if (!getToken()) {
        // Not enrolled yet. Not an error, and not a reason to look offline.
        setState("connecting");
        return;
      }

      const cards = await api.unclaimed();
      consecutiveFailures = 0;
      setState("live");

      const live = new Set<string>();
      for (const card of cards) {
        live.add(card.session_id);
        if (!seen.has(card.session_id)) {
          seen.add(card.session_id);
          onEvent({
            type: "session.opened",
            session_id: card.session_id,
            operator_id: card.operator_id,
            emp_code: card.emp_code,
            full_name: card.full_name,
            opened_at: card.opened_at,
            expires_in_secs: card.expires_in_secs,
          });
        }
      }

      // A card that has left the list either expired or was claimed. Either way
      // the terminal should stop offering it.
      for (const id of seen) {
        if (!live.has(id)) {
          seen.delete(id);
          onEvent({ type: "session.closed", session_id: id, reason: "GONE" });
        }
      }

      // §9.4: a finger the door accepted that we cannot put a name to. Polled
      // on the same tick rather than its own, because it is only interesting
      // to the live view and never urgent.
      for (const punch of await api.unknownPunches(startedAt)) {
        if (seenPunches.has(punch.id)) continue;
        seenPunches.add(punch.id);
        onEvent({
          type: "punch.unknown_user",
          zk_user_id: punch.zk_user_id,
          device_serial: punch.device_serial,
          received_at: punch.received_at,
        });
      }
    } catch {
      consecutiveFailures += 1;
      // One failed poll on a flaky link is noise; two in a row is a state the
      // operator should see.
      if (consecutiveFailures >= 2) setState("offline");
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
