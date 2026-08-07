// The live wire: `GET /api/v1/sessions/stream` (CLAUDE.md §4, §11).
//
// > Tablets subscribe to the stream. When a punch arrives the server emits a
// > `session.opened` event and the tablet foregrounds the IN/OUT panel.
// > **No polling.**
//
// `EventSource` cannot send an Authorization header, so the token rides as a
// query parameter on this one endpoint. That is a real trade-off — a token in a
// URL can end up in a proxy log — and it is why `store-server` accepts it only
// on the SSE route, over a plant LAN, for a token that can be revoked by
// re-enrolling the device.

import { getToken } from "./api";

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
}

/**
 * Subscribe to the server's event stream, reconnecting on its own.
 *
 * Returns a teardown function.
 *
 * `EventSource` already retries, but it does not tell the UI that it has
 * stopped being live — and a claim screen that has silently gone stale is worse
 * than one that says so. We watch the readyState and surface it, so the
 * operator can see at a glance whether the terminal is talking to the server.
 */
export function subscribeToEvents({ onEvent, onStateChange }: Options): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: number | undefined;
  let closed = false;
  let attempt = 0;

  const setState = (state: ConnectionState) => onStateChange?.(state);

  const connect = () => {
    if (closed) return;

    const token = getToken();
    if (!token) {
      setState("offline");
      return;
    }

    setState(attempt === 0 ? "connecting" : "connecting");
    source = new EventSource(
      `/api/v1/sessions/stream?access_token=${encodeURIComponent(token)}`,
    );

    source.onopen = () => {
      attempt = 0;
      setState("live");
    };

    // The server names each event, so a client could subscribe by type. We take
    // them all through onmessage-equivalent handlers and let the reducer sort
    // it out — there are six event types and one place that cares about them.
    const handle = (raw: MessageEvent) => {
      try {
        onEvent(JSON.parse(raw.data) as ServerEvent);
      } catch {
        // A malformed frame is a server bug, not a reason to drop the stream.
      }
    };

    for (const name of [
      "session.opened",
      "session.claimed",
      "session.closed",
      "alert.raised",
      "punch.unknown_user",
      "heartbeat",
    ]) {
      source.addEventListener(name, handle);
    }
    source.onmessage = handle;

    source.onerror = () => {
      setState("offline");
      source?.close();
      source = null;
      if (closed) return;

      // Back off, but never further than a few seconds: this is a LAN, and an
      // operator standing at the terminal after a switch reboot should not be
      // waiting a minute for the claim screen to come back.
      attempt += 1;
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 3), 8000);
      reconnectTimer = window.setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    window.clearTimeout(reconnectTimer);
    source?.close();
  };
}
