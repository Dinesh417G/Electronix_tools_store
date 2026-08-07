// App shell: enrolment, the live event stream, the outbox flusher, and the
// over-the-air update prompt.

import { useCallback, useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";
import {
  OfflineError,
  api,
  clearCredentials,
  getToken,
  type AlertSummary,
  type UnclaimedSession,
} from "./lib/api";
import { subscribeToEvents, type ConnectionState, type ServerEvent } from "./lib/events";
import { count as outboxCount, flush, type QueuedTxn } from "./lib/outbox";
import { Enrol } from "./screens/Enrol";
import { LiveView } from "./screens/LiveView";
import { Terminal } from "./screens/Terminal";
import { Banner, BigButton } from "./components/ui";

type Mode = "terminal" | "live";

/** CLAUDE.md §10 — an unclaimed punch stays on the claim screen for 90 s. */
const CLAIM_WINDOW_MS = 90_000;

export function App() {
  const [enrolled, setEnrolled] = useState(() => getToken() !== null);
  const [mode, setMode] = useState<Mode>(
    () => (localStorage.getItem("electronix.store.mode") as Mode) ?? "terminal",
  );

  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [cards, setCards] = useState<UnclaimedSession[]>([]);
  const [alerts, setAlerts] = useState<AlertSummary>({ low: 0, empty: 0 });
  const [pending, setPending] = useState(0);
  const [revision, setRevision] = useState(0);
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const [dropped, setDropped] = useState<QueuedTxn[]>([]);
  const [updateReady, setUpdateReady] = useState(false);

  const applyUpdate = useRef<(reload?: boolean) => Promise<void>>(async () => {});

  // ── Over-the-air updates ────────────────────────────────────────────
  //
  // This is the whole OTA story for the UI, and it is the strongest argument
  // for the terminal being a web app: a new build reaches every phone and
  // tablet on the next page load, with no signing key to lose, no store review,
  // and nobody walking the shop floor with a USB stick.
  //
  // The prompt is deliberate rather than automatic. Reloading under an operator
  // who is halfway through an issue would lose their typing, so we wait for a
  // tap. The service worker keeps serving the old build until then.
  useEffect(() => {
    applyUpdate.current = registerSW({
      onNeedRefresh: () => setUpdateReady(true),
      onRegisteredSW: (_url: string, registration: ServiceWorkerRegistration | undefined) => {
        // A wall-mounted terminal may go weeks without a reload. Ask the server
        // hourly whether there is something newer.
        if (registration) {
          setInterval(() => void registration.update(), 60 * 60 * 1000);
        }
      },
    });
  }, []);

  // ── Live stream ─────────────────────────────────────────────────────
  //
  // `session.opened` already carries everything a name card needs, so a card
  // is rendered straight from the event rather than triggering a re-read. That
  // is what makes §4's "no polling" literally true: with the network otherwise
  // idle, a punch at the door puts a card on screen.
  //
  // `/unclaimed` is still read, on a slow timer and on reconnect, as a
  // reconciliation backstop — a terminal that missed events while its Wi-Fi
  // dropped has to be able to catch up.
  const refreshCards = useCallback(async () => {
    try {
      setCards(await api.unclaimed());
    } catch {
      // The stream state already tells the operator we are offline.
    }
  }, []);

  const refreshAlerts = useCallback(async () => {
    try {
      setAlerts(await api.alertSummary());
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    if (!enrolled) return;

    void refreshCards();
    void refreshAlerts();

    const stop = subscribeToEvents({
      onStateChange: setConnection,
      onEvent: (event) => {
        setLastEvent(event);
        if (event.type === "heartbeat") return;

        // Any non-heartbeat event can change what the live view shows.
        setRevision((r) => r + 1);

        switch (event.type) {
          case "session.opened":
            setCards((current) =>
              current.some((c) => c.session_id === event.session_id)
                ? current
                : [
                    {
                      session_id: event.session_id,
                      operator_id: event.operator_id,
                      emp_code: event.emp_code,
                      full_name: event.full_name,
                      // Not carried on the event; the backstop read fills it in
                      // if anyone ever needs it on the card.
                      department: null,
                      opened_at: event.opened_at,
                      expires_in_secs: event.expires_in_secs,
                    },
                    ...current,
                  ],
            );
            break;

          case "session.claimed":
          case "session.closed":
            // Somebody took this card, or it timed out. Remove it everywhere —
            // two tablets showing the same name is how one gets a 409.
            setCards((current) =>
              current.filter((c) => c.session_id !== event.session_id),
            );
            break;

          case "alert.raised":
            void refreshAlerts();
            break;
        }
      },
    });

    return stop;
  }, [enrolled, refreshCards, refreshAlerts]);

  // A card must leave the screen when its 90 s window closes, rather than
  // sitting there refusing taps. Expiry is computed locally from `opened_at`
  // so the countdown keeps running without asking the server every second.
  useEffect(() => {
    if (!enrolled) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setCards((current) => {
        const live = current
          .map((card) => ({
            ...card,
            expires_in_secs: Math.max(
              0,
              Math.ceil(
                (new Date(card.opened_at).getTime() + CLAIM_WINDOW_MS - now) / 1000,
              ),
            ),
          }))
          .filter((card) => card.expires_in_secs > 0);

        // Only replace the array when something actually changed, so an idle
        // terminal is not re-rendering once a second all shift.
        return live.length === current.length &&
          live.every((c, i) => c.expires_in_secs === current[i]?.expires_in_secs)
          ? current
          : live;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [enrolled]);

  // Reconciliation backstop: a terminal that missed events while its Wi-Fi
  // dropped has to be able to catch up. Slow on purpose — the stream is what
  // carries anything time-sensitive.
  useEffect(() => {
    if (!enrolled) return;
    const timer = setInterval(() => void refreshCards(), 60_000);
    return () => clearInterval(timer);
  }, [enrolled, refreshCards]);

  // ── Outbox ──────────────────────────────────────────────────────────
  const drainOutbox = useCallback(async () => {
    const result = await flush(
      async (txn) => {
        if (txn.kind === "issue") await api.issue(txn.body as never);
        else await api.receipt(txn.body as never);
      },
      (err) => err instanceof OfflineError,
    );

    setPending(result.remaining);
    if (result.rejected.length > 0) setDropped((d) => [...d, ...result.rejected]);
    if (result.sent > 0) setRevision((r) => r + 1);
  }, []);

  useEffect(() => {
    if (!enrolled) return;
    void outboxCount().then(setPending);

    // Flush whenever the connection comes back, and on a slow timer as a
    // backstop for the case where the browser never fires an online event.
    if (connection === "live") void drainOutbox();

    const onOnline = () => void drainOutbox();
    window.addEventListener("online", onOnline);
    const timer = setInterval(() => void drainOutbox(), 30_000);

    return () => {
      window.removeEventListener("online", onOnline);
      clearInterval(timer);
    };
  }, [enrolled, connection, drainOutbox]);

  const switchMode = (next: Mode) => {
    setMode(next);
    localStorage.setItem("electronix.store.mode", next);
  };

  if (!enrolled) {
    return <Enrol onEnrolled={() => setEnrolled(true)} />;
  }

  return (
    <div className="relative min-h-full">
      {updateReady && (
        <div className="sticky top-0 z-20 p-3">
          <Banner tone="info">
            <div className="flex items-center gap-3">
              <span className="flex-1">A new version of the terminal is ready.</span>
              <button
                type="button"
                onClick={() => void applyUpdate.current(true)}
                className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white"
              >
                Update
              </button>
            </div>
          </Banner>
        </div>
      )}

      {dropped.length > 0 && (
        <div className="p-3">
          <Banner tone="error" onDismiss={() => setDropped([])}>
            {dropped.length} queued transaction{dropped.length === 1 ? " was" : "s were"}{" "}
            refused by the server and not recorded:{" "}
            {dropped.map((d) => `${d.itemCode} × ${d.qty}`).join(", ")}. Check the bin and
            re-enter.
          </Banner>
        </div>
      )}

      {mode === "terminal" ? (
        <Terminal
          cards={cards}
          connection={connection}
          pending={pending}
          alertBanner={alerts}
          onRefreshCards={() => void refreshCards()}
          onQueued={() => void outboxCount().then(setPending)}
        />
      ) : (
        <LiveView connection={connection} revision={revision} lastEvent={lastEvent} />
      )}

      <ModeSwitch mode={mode} onChange={switchMode} onReset={() => {
        clearCredentials();
        setEnrolled(false);
      }} />
    </div>
  );
}

/**
 * Mode switch, tucked into a corner.
 *
 * Deliberately small and out of the flow: on a wall-mounted terminal an
 * operator must not be able to leave the issue screen by fumbling a tap.
 */
function ModeSwitch({
  mode,
  onChange,
  onReset,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="fixed right-3 bottom-3 z-10 flex flex-col items-end gap-2 safe-bottom">
      {open && (
        <div className="w-56 space-y-2 rounded-2xl bg-slate-800 p-3 shadow-xl">
          <BigButton
            onClick={() => {
              onChange(mode === "terminal" ? "live" : "terminal");
              setOpen(false);
            }}
            variant="neutral"
            className="w-full text-base"
          >
            {mode === "terminal" ? "Live view" : "Terminal"}
          </BigButton>
          <button
            type="button"
            onClick={onReset}
            className="w-full rounded-xl px-3 py-2 text-sm text-slate-400 active:bg-slate-700"
          >
            Un-enrol this device
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Settings"
        className="h-11 w-11 rounded-full bg-slate-800/90 text-lg text-slate-400 shadow-lg backdrop-blur active:bg-slate-700"
      >
        ⚙
      </button>
    </div>
  );
}
