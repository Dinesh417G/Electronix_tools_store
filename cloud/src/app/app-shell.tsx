"use client";

// App shell: enrolment, the live event stream, the outbox flusher, and the
// over-the-air update prompt.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  OfflineError,
  api,
  clearCredentials,
  getToken,
  type AlertSummary,
  type UnclaimedSession,
} from "@/lib/api";
import { subscribeToEvents, type ConnectionState, type ServerEvent } from "@/lib/events";
import {
  ADMIN_NAME_KEY,
  ADMIN_ROLE_KEY,
  ADMIN_SIGNED_OUT_EVENT,
  ADMIN_TOKEN_KEY,
} from "@/lib/admin";
import { count as outboxCount, flush, type QueuedTxn } from "@/lib/outbox";
import { Admin } from "@/screens/Admin";
import { AdminLogin } from "@/screens/AdminLogin";
import { MySignIn } from "@/screens/MySignIn";
import { Enrol } from "@/screens/Enrol";
import { LiveView } from "@/screens/LiveView";
import { Terminal } from "@/screens/Terminal";
import { Banner, BigButton, Spinner } from "@/components/ui";
import { BottomBar, ChromeProvider } from "@/components/chrome";

type Mode = "terminal" | "live" | "admin";

/** CLAUDE.md §10 — an unclaimed punch stays on the claim screen for 90 s. */
const CLAIM_WINDOW_MS = 90_000;

export function AppShell() {
  // Next renders this on the server first, where there is no localStorage and
  // no token. Reading either during the first render would make the server's
  // HTML disagree with the client's and React would throw away the tree. So the
  // first paint is deliberately the logged-out shape, and the real state
  // arrives in an effect one tick later.
  const [hydrated, setHydrated] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [mode, setMode] = useState<Mode>("terminal");

  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [cards, setCards] = useState<UnclaimedSession[]>([]);
  const [alerts, setAlerts] = useState<AlertSummary>({ low: 0, empty: 0 });
  const [pending, setPending] = useState(0);
  const [revision, setRevision] = useState(0);
  const [lastEvent, setLastEvent] = useState<ServerEvent | null>(null);
  const [dropped, setDropped] = useState<QueuedTxn[]>([]);
  const [updateReady, setUpdateReady] = useState(false);

  // The admin console authenticates separately: a device token is not an
  // operator, and §11 keeps the two apart on purpose.
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminName, setAdminName] = useState<string>("");
  // Which screen the token is worth drawing, not what it may do — every route
  // re-checks the role for itself.
  const [adminRole, setAdminRole] = useState<string>("");

  // The hydration read promised above. It sits below every state it writes,
  // and the sign-out listener with it: the admin token and name are declared
  // last, and a lint pass reading top to bottom is right to object to an effect
  // that reaches back over its own declarations.
  //
  // Setting state straight out of an effect is what `set-state-in-effect`
  // exists to catch, and this is the case it cannot help with: localStorage
  // does not exist during the server render, so these values can only arrive
  // after the first paint. One pass, empty dependency list, nothing to cascade.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEnrolled(getToken() !== null);
    setMode((localStorage.getItem("electronix.store.mode") as Mode) ?? "terminal");
    setAdminToken(localStorage.getItem(ADMIN_TOKEN_KEY));
    setAdminName(localStorage.getItem(ADMIN_NAME_KEY) ?? "");
    setAdminRole(localStorage.getItem(ADMIN_ROLE_KEY) ?? "");
    setHydrated(true);
  }, []);

  // A stored admin token the server refuses is worse than no token: the console
  // keeps drawing admin screens and answers every tap with an error, and the
  // one control that fixes it — Sign out — reads like giving up rather than
  // like the remedy. `admin.ts` clears the token on any 401 and fires this, so
  // the console falls back to the sign-in form on its own.
  useEffect(() => {
    const onSignedOut = () => {
      setAdminToken(null);
      setAdminName("");
      setAdminRole("");
    };
    window.addEventListener(ADMIN_SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(ADMIN_SIGNED_OUT_EVENT, onSignedOut);
  }, []);

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
    // The Vite build wrapped `virtual:pwa-register` around a service worker.
    // This deployment has no service worker yet, so the same promise is kept
    // the plain way: ask the server what build it is serving, and if that
    // differs from the build this page loaded, offer a reload.
    //
    // The prompt stays deliberate rather than automatic. Reloading under an
    // operator halfway through an issue would lose their typing, so we wait for
    // a tap.
    let loadedBuild: string | null = null;
    let cancelled = false;

    const check = async () => {
      try {
        const info = await api.version();
        const build = `${info.version}@${info.git_sha}`;
        if (loadedBuild === null) loadedBuild = build;
        else if (build !== loadedBuild && !cancelled) setUpdateReady(true);
      } catch {
        // Offline. The terminal keeps working from what it already has.
      }
    };

    applyUpdate.current = async (reload = true) => {
      if (reload) window.location.reload();
    };

    void check();
    // A wall-mounted terminal may go weeks without a reload.
    const timer = setInterval(() => void check(), 60 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
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

    // Both of these set state only after an `await`, which is a render apart
    // from the effect that started them. `set-state-in-effect` does not follow
    // the call, so it reports the call site instead.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // As above: `drainOutbox` reaches its setState after awaiting the flush.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  /* One sign-out for both signed-in screens. Forgetting the role matters as
   * much as forgetting the token: left behind, the next person to sign in on
   * this device is drawn the previous person's screen until their own role
   * lands. */
  const signOutOfConsole = () => {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_NAME_KEY);
    localStorage.removeItem(ADMIN_ROLE_KEY);
    setAdminToken(null);
    setAdminName("");
    setAdminRole("");
    switchMode("terminal");
  };

  // Until the effect above has read localStorage, we genuinely do not know
  // whether this device is enrolled. Rendering Enrol in the meantime would
  // flash a setup form at every operator on every load.
  if (!hydrated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950">
        <Spinner label="Starting up" />
      </div>
    );
  }

  if (!enrolled) {
    return <Enrol onEnrolled={() => setEnrolled(true)} />;
  }

  return (
    /* One `h-dvh` column for the whole app: the screen fills the top half and
     * the bar sits under it as reserved space. Nothing is `fixed` over content
     * any more, which is what stops a control hiding a row mid-scroll. */
    <ChromeProvider>
      {(back) => (
    <div className="relative flex h-dvh flex-col overflow-hidden">
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

      {/* The content region. `min-h-0` is what lets a child's own
          `overflow-y-auto` engage: without it a flex item refuses to shrink
          below its content and the whole column grows instead. */}
      <main className="flex min-h-0 flex-1 flex-col">
      {mode === "terminal" && (
        <Terminal
          cards={cards}
          connection={connection}
          pending={pending}
          alertBanner={alerts}
          onRefreshCards={() => void refreshCards()}
          onQueued={() => void outboxCount().then(setPending)}
        />
      )}

      {mode === "live" && (
        <LiveView connection={connection} revision={revision} lastEvent={lastEvent} />
      )}

      {mode === "admin" &&
        (adminToken ? (
          // An OPERATOR signs in for exactly one reason — to register or revoke
          // the device that signs in as them — so they get that page and not a
          // console whose every tab would answer 403. Storekeepers and admins
          // get the console, as before.
          adminRole === "OPERATOR" ? (
            <MySignIn
              token={adminToken}
              operatorName={adminName}
              onSignOut={signOutOfConsole}
            />
          ) : (
            <Admin
              token={adminToken}
              operatorName={adminName}
              onSignOut={signOutOfConsole}
            />
          )
        ) : (
          <AdminLogin
            onSignedIn={(token, name, role) => {
              // Session-scoped to this device; the token expires in 12 hours
              // regardless, so a forgotten admin screen stops working on its own.
              localStorage.setItem(ADMIN_TOKEN_KEY, token);
              localStorage.setItem(ADMIN_NAME_KEY, name);
              localStorage.setItem(ADMIN_ROLE_KEY, role);
              setAdminToken(token);
              setAdminName(name);
              setAdminRole(role);
            }}
            onCancel={() => switchMode("terminal")}
          />
        ))}

      </main>

      <BottomBar
        back={back}
        right={
          <ModeSwitch
            mode={mode}
            onChange={switchMode}
            onReset={() => {
              clearCredentials();
              setEnrolled(false);
            }}
          />
        }
      />
    </div>
      )}
    </ChromeProvider>
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
    /* `relative`, and the panel is absolutely positioned above the button:
       inside the bar there is no room to stack, and a menu that pushed the bar
       taller would move every other control while it was open. */
    <div className="relative">
      {open && (
        <div className="absolute right-0 bottom-full z-20 mb-2 w-56 space-y-2 rounded-2xl bg-slate-800 p-3 shadow-xl">
          {(["terminal", "live", "admin"] as const)
            .filter((m) => m !== mode)
            .map((m) => (
              <BigButton
                key={m}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                }}
                variant="neutral"
                className="w-full text-base capitalize"
              >
                {m === "live" ? "Live view" : m}
              </BigButton>
            ))}
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
        className="tap flex h-11 items-center gap-2 rounded-xl px-3 text-slate-300 active:bg-slate-800"
      >
        <span className="text-lg">⚙</span>
        <span className="text-sm font-semibold capitalize">
          {mode === "live" ? "Live view" : mode}
        </span>
      </button>
    </div>
  );
}
