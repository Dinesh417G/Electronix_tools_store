// The issue/receipt terminal — CLAUDE.md §12.
//
// The whole flow, in one component, because it is one flow:
//
//   idle → claim → direction → item (scan | search) → qty → optional → confirm
//
// Target: **scan → qty → confirm in under 8 seconds.** Everything here is
// arranged around that number. Quantity defaults to 1 so a single-insert issue
// is two taps. The optional step's SKIP is the largest control on the screen,
// because §12.6 says skipping must never be slower than filling.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  OfflineError,
  api,
  formatQty,
  getTerminalId,
  type Item,
  type Machine,
  type ReasonCode,
  type TxnResponse,
  type UnclaimedSession,
} from "../lib/api";
import type { ConnectionState } from "../lib/events";
import { enqueue, newTxnId } from "../lib/outbox";
import { isScanningSupported, startScanner, type ScannerError } from "../lib/scanner";
import { isPasskeySupported, signInWithPasskey } from "../lib/passkey";
import { AlertChip, Banner, BigButton, ConnectionPill, Header, Screen, Spinner } from "../components/ui";

type Direction = "issue" | "receipt";

/**
 * What the rest of the flow needs from a session, whichever way identity
 * arrived — a punch the operator claimed, or an emp code they typed.
 *
 * §10 keeps `manual` on the session rather than inferring it later: the two
 * are the same transaction to the ledger but not the same evidence, and the
 * screens that name the operator should say which one they are looking at.
 */
interface ActiveSession {
  session_id: string;
  emp_code: string;
  full_name: string;
  manual: boolean;
}

type Step =
  | { name: "idle" }
  | { name: "claim" }
  | { name: "manual" }
  | { name: "direction"; session: ActiveSession }
  | { name: "item"; session: ActiveSession; direction: Direction }
  | { name: "qty"; session: ActiveSession; direction: Direction; item: Item }
  | {
      name: "optional";
      session: ActiveSession;
      direction: Direction;
      item: Item;
      qty: string;
    }
  | {
      name: "split";
      session: ActiveSession;
      direction: Direction;
      item: Item;
      qty: string;
      machines: Machine[];
      reasonId: string | null;
    }
  | {
      name: "confirm";
      session: ActiveSession;
      direction: Direction;
      item: Item;
      qty: string;
      machineId: string | null;
      reasonId: string | null;
      /** Set only for a multi-machine issue; one ledger row will be written per
       *  entry. `qty` is then the total of these. */
      splits: Split[] | null;
    }
  | { name: "success"; result: TxnResponse; queued: boolean };

/** One machine's share of a multi-machine issue, as the screens carry it. */
interface Split {
  machine: Machine;
  qty: string;
}

interface Props {
  cards: UnclaimedSession[];
  connection: ConnectionState;
  pending: number;
  alertBanner: { low: number; empty: number };
  onRefreshCards: () => void;
  onQueued: () => void;
}

export function Terminal({
  cards,
  connection,
  pending,
  alertBanner,
  onRefreshCards,
  onQueued,
}: Props) {
  const [step, setStep] = useState<Step>({ name: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const terminalId = getTerminalId() ?? "";

  const reset = useCallback(() => {
    setStep({ name: "idle" });
    setError(null);
  }, []);

  // §10: ACTIVE closes on submit, on explicit Done, or after 180 s idle. This
  // is the Done arm. Without it, an operator who claims a card and then backs
  // out leaves the session ACTIVE until the reaper takes it, and for those
  // three minutes the store looks busy to everyone else — including to them,
  // if they punch again.
  //
  // Deliberately fire-and-forget: the operator has already walked away by the
  // time this lands, the endpoint is idempotent (`where state = 'ACTIVE'`), and
  // if the LAN is down the reaper closes the session anyway. Nothing here is
  // worth making somebody watch a spinner for.
  //
  // Not called from the success screen: on the online path the server already
  // closed the session on submit, and on the offline path the transaction is
  // still sitting in the outbox — closing now would meet its flush with a 410.
  const abandon = useCallback(
    (session: ActiveSession) => {
      void api.closeSession(session.session_id).catch(() => {});
      reset();
    },
    [reset],
  );

  // §12.2: a punch arriving while we are idle foregrounds the claim screen.
  // Only from idle — pulling an operator mid-transaction to somebody else's
  // card would be worse than making them tap once.
  useEffect(() => {
    if (step.name === "idle" && cards.length > 0) {
      setStep({ name: "claim" });
    }
    if (step.name === "claim" && cards.length === 0) {
      setStep({ name: "idle" });
    }
  }, [cards.length, step.name]);

  // §12.8: auto-return to idle after 15 s on the success screen.
  useEffect(() => {
    if (step.name !== "success") return;
    const timer = setTimeout(reset, 15_000);
    return () => clearTimeout(timer);
  }, [step, reset]);

  // §10: keep the session alive while the operator is working it.
  //
  // Everything between claiming a card and confirming happens on the tablet —
  // scanning, keying a quantity, picking machines — so the server has no way to
  // tell an operator mid-transaction from one who walked away. Without this the
  // 180 s idle timeout is a deadline on the whole transaction, and a careful
  // operator is punished for being careful.
  //
  // Fired on entering each step, and on a timer well inside the window for a
  // step somebody lingers on.
  const sessionId = "session" in step ? step.session.session_id : null;
  useEffect(() => {
    if (!sessionId) return;

    const keepAlive = () => {
      void api.touchSession(sessionId).catch(() => {
        // A missed keepalive is not worth interrupting the operator for: the
        // next step will try again, and a genuinely dead session announces
        // itself at confirm with a 410 that already has a handler.
      });
    };

    keepAlive();
    const timer = setInterval(keepAlive, 60_000);
    return () => clearInterval(timer);
  }, [sessionId, step.name]);

  const claim = async (card: UnclaimedSession) => {
    setBusy(true);
    setError(null);
    try {
      await api.claim(card.session_id, terminalId);
      setStep({
        name: "direction",
        session: {
          session_id: card.session_id,
          emp_code: card.emp_code,
          full_name: card.full_name,
          manual: false,
        },
      });
    } catch (err) {
      setError(describe(err));
      onRefreshCards();
      setStep({ name: "idle" });
    } finally {
      setBusy(false);
    }
  };

  // §10: the fallback when no punch arrives — device down, network down, or a
  // reader that will not read this particular finger. The session it opens is
  // ACTIVE immediately (there is no card for anyone to claim) and carries
  // `manual_identity = true`, which is what makes it weaker evidence in
  // reports than a punch.
  // §8's third identity source. The phone verifies its owner and signs our
  // challenge; the server opens the session with identity_source = WEBAUTHN,
  // which reports as stronger than a typed PIN and weaker than the door.
  const passkeySignIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await signInWithPasskey();
      setStep({
        name: "direction",
        session: {
          session_id: session.session_id,
          emp_code: session.emp_code,
          full_name: session.full_name,
          manual: session.manual_identity,
        },
      });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const manualSignIn = async (empCode: string, pin: string) => {
    setBusy(true);
    setError(null);
    try {
      const session = await api.manualSession(empCode, pin, terminalId);
      setStep({
        name: "direction",
        session: {
          session_id: session.session_id,
          emp_code: session.emp_code,
          full_name: session.full_name,
          manual: true,
        },
      });
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (
    session: ActiveSession,
    direction: Direction,
    item: Item,
    qty: string,
    machineId: string | null,
    reasonId: string | null,
    splits: Split[] | null,
  ) => {
    setBusy(true);
    setError(null);

    // Generated once, before the first attempt, and never regenerated: a retry
    // of a request the server already committed must resolve to the same row.
    const txnId = newTxnId();

    // A multi-machine issue goes as one request carrying every split. Sending
    // one request per machine could not work — §10 closes the session on the
    // first submit — and would risk the bin being half-emptied by a batch the
    // operator was told had failed.
    const body = splits
      ? {
          session_id: session.session_id,
          item_id: item.id,
          qty,
          reason_id: reasonId,
          client_txn_uuid: txnId,
          // One key per row, minted here with the rest of the body. The body is
          // built once and re-sent verbatim on every retry — including out of
          // the offline outbox — so these stay stable and a replay resolves row
          // by row rather than all-or-nothing.
          splits: splits.map((s) => ({
            machine_id: s.machine.id,
            qty: s.qty,
            client_txn_uuid: newTxnId(),
          })),
        }
      : {
          session_id: session.session_id,
          item_id: item.id,
          qty,
          ...(direction === "issue"
            ? { machine_id: machineId, reason_id: reasonId }
            : { reason_id: reasonId }),
          client_txn_uuid: txnId,
        };

    try {
      const result =
        direction === "issue"
          ? await api.issue(body as never)
          : await api.receipt(body as never);
      setStep({ name: "success", result, queued: false });
      onRefreshCards();
    } catch (err) {
      if (err instanceof OfflineError) {
        // §12: queue it, mark it pending, and tell the operator plainly. The
        // stock figure we show is our best local guess, flagged as such.
        await enqueue({
          id: txnId,
          kind: direction,
          body,
          itemCode: item.item_code,
          qty,
          queuedAt: Date.now(),
          attempts: 0,
        });
        onQueued();
        setStep({
          name: "success",
          queued: true,
          result: {
            ledger_id: 0,
            // Nothing is in the ledger yet — this is the local guess shown
            // while the outbox holds the transaction.
            ledger_ids: [],
            item_id: item.id,
            item_code: item.item_code,
            description: item.description,
            delta_qty: direction === "issue" ? `-${qty}` : qty,
            on_hand: item.on_hand,
            alert_state: item.alert_state,
            crossed_threshold: false,
          },
        });
      } else {
        setError(describe(err));
        // §10: a 410 means the session closed under them. Send them back to
        // the claim screen rather than leaving a dead form on screen.
        if (err instanceof ApiError && err.isSessionGone) {
          onRefreshCards();
          setStep({ name: "idle" });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const banner = error ? (
    <div className="px-4 pb-3">
      <Banner tone="error" onDismiss={() => setError(null)}>
        {error}
      </Banner>
    </div>
  ) : null;

  switch (step.name) {
    case "idle":
      return (
        <IdleScreen
          connection={connection}
          pending={pending}
          alerts={alertBanner}
          onStart={() => (cards.length > 0 ? setStep({ name: "claim" }) : onRefreshCards())}
          onManual={() => setStep({ name: "manual" })}
          banner={banner}
        />
      );

    case "claim":
      return (
        <ClaimScreen
          cards={cards}
          busy={busy}
          connection={connection}
          pending={pending}
          onPick={claim}
          onManual={() => setStep({ name: "manual" })}
          onCancel={reset}
          banner={banner}
        />
      );

    case "manual":
      return (
        <ManualScreen
          busy={busy}
          onSubmit={manualSignIn}
          onPasskey={passkeySignIn}
          onCancel={reset}
          banner={banner}
        />
      );

    case "direction":
      return (
        <DirectionScreen
          session={step.session}
          onPick={(direction) => setStep({ name: "item", session: step.session, direction })}
          onCancel={() => abandon(step.session)}
          banner={banner}
        />
      );

    case "item":
      return (
        <ItemScreen
          direction={step.direction}
          onPick={(item) =>
            setStep({ name: "qty", session: step.session, direction: step.direction, item })
          }
          onCancel={() => abandon(step.session)}
          banner={banner}
        />
      );

    case "qty":
      return (
        <QuantityScreen
          item={step.item}
          direction={step.direction}
          onNext={(qty) =>
            setStep({
              name: "optional",
              session: step.session,
              direction: step.direction,
              item: step.item,
              qty,
            })
          }
          onBack={() =>
            setStep({ name: "item", session: step.session, direction: step.direction })
          }
          banner={banner}
        />
      );

    case "optional":
      return (
        <OptionalScreen
          direction={step.direction}
          onNext={(machines, reasonId) =>
            // One machine (or none) is the ordinary transaction. Two or more
            // means the operator is stocking several machines from one trip,
            // and each needs its own quantity before anything can be written.
            machines.length > 1
              ? setStep({
                  name: "split",
                  session: step.session,
                  direction: step.direction,
                  item: step.item,
                  qty: step.qty,
                  machines,
                  reasonId,
                })
              : setStep({
                  name: "confirm",
                  session: step.session,
                  direction: step.direction,
                  item: step.item,
                  qty: step.qty,
                  machineId: machines[0]?.id ?? null,
                  reasonId,
                  splits: null,
                })
          }
          onBack={() =>
            setStep({
              name: "qty",
              session: step.session,
              direction: step.direction,
              item: step.item,
            })
          }
          banner={banner}
        />
      );

    case "split":
      return (
        <SplitScreen
          item={step.item}
          machines={step.machines}
          total={step.qty}
          onNext={(splits) =>
            setStep({
              name: "confirm",
              session: step.session,
              direction: step.direction,
              item: step.item,
              qty: splits
                .reduce((sum, s) => sum + (Number.parseFloat(s.qty) || 0), 0)
                .toString(),
              machineId: null,
              reasonId: step.reasonId,
              splits,
            })
          }
          onBack={() =>
            setStep({
              name: "optional",
              session: step.session,
              direction: step.direction,
              item: step.item,
              qty: step.qty,
            })
          }
          banner={banner}
        />
      );

    case "confirm":
      return (
        <ConfirmScreen
          step={step}
          busy={busy}
          onConfirm={() =>
            submit(
              step.session,
              step.direction,
              step.item,
              step.qty,
              step.machineId,
              step.reasonId,
              step.splits,
            )
          }
          onBack={() =>
            setStep({
              name: "optional",
              session: step.session,
              direction: step.direction,
              item: step.item,
              qty: step.qty,
            })
          }
          banner={banner}
        />
      );

    case "success":
      return <SuccessScreen result={step.result} queued={step.queued} onDone={reset} />;
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof OfflineError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

// ── 1. Idle (§12.1) ─────────────────────────────────────────────────────

function IdleScreen({
  connection,
  pending,
  alerts,
  onStart,
  onManual,
  banner,
}: {
  connection: ConnectionState;
  pending: number;
  alerts: { low: number; empty: number };
  onStart: () => void;
  onManual: () => void;
  banner: React.ReactNode;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <Screen className="justify-between">
      <div className="flex items-center justify-between px-4">
        <span className="text-sm font-semibold tracking-wide text-slate-400">
          ELECTRONIX TOOL STORE
        </span>
        <ConnectionPill state={connection} pending={pending} />
      </div>

      {banner}

      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4">
        <div className="text-7xl font-bold tabular-nums sm:text-8xl">
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="text-lg text-slate-400">
          {now.toLocaleDateString([], {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </div>
        <p className="mt-8 max-w-xs text-center text-slate-400">
          Put your finger on the door reader, then tap your name here.
        </p>
      </div>

      <div className="space-y-3 px-4">
        {alerts.empty > 0 && (
          <Banner tone="error">
            <strong>{alerts.empty}</strong> item{alerts.empty === 1 ? " is" : "s are"} EMPTY.
          </Banner>
        )}
        {alerts.low > 0 && (
          <Banner tone="warn">
            <strong>{alerts.low}</strong> item{alerts.low === 1 ? " is" : "s are"} low on stock.
          </Banner>
        )}
        <BigButton onClick={onStart} variant="ghost" className="w-full">
          I'm here — show me
        </BigButton>

        {/* §10's fallback. Deliberately quieter than the button above: the
            reader is the normal way in, and a typed emp code is weaker
            evidence. It stays reachable at all times anyway, because the
            shift when the reader dies is exactly the shift nobody can afford
            to stop booking stock. */}
        <button
          type="button"
          onClick={onManual}
          className="w-full rounded-xl px-4 py-3 text-sm text-slate-400 active:bg-slate-800"
        >
          Reader not working? Enter my number
        </button>
      </div>
    </Screen>
  );
}

// ── 2. Claim (§12.2, §10) ───────────────────────────────────────────────

function ClaimScreen({
  cards,
  busy,
  connection,
  pending,
  onPick,
  onManual,
  onCancel,
  banner,
}: {
  cards: UnclaimedSession[];
  busy: boolean;
  connection: ConnectionState;
  pending: number;
  onPick: (card: UnclaimedSession) => void;
  onManual: () => void;
  onCancel: () => void;
  banner: React.ReactNode;
}) {
  return (
    <Screen>
      <Header
        title="Who are you?"
        subtitle="Tap your own name"
        right={<ConnectionPill state={connection} pending={pending} />}
      />
      {banner}

      <div className="flex-1 space-y-3 overflow-y-auto px-4">
        {cards.length === 0 && <Spinner label="Waiting for a punch at the door…" />}

        {/* §10: every unclaimed punch from the last 90 s is listed. Tailgating
            is solved socially — each person taps their own card — so we never
            guess which one is "the" operator, even when there is only one. */}
        {cards.map((card) => (
          <button
            key={card.session_id}
            type="button"
            disabled={busy}
            onClick={() => onPick(card)}
            className="tap flex w-full items-center gap-4 rounded-2xl bg-slate-800 px-5 py-4 text-left active:bg-slate-700 disabled:opacity-50"
          >
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-sky-600 text-xl font-bold">
              {initials(card.full_name)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xl font-semibold">{card.full_name}</div>
              <div className="truncate text-sm text-slate-400">
                {card.emp_code}
                {card.department ? ` · ${card.department}` : ""}
              </div>
            </div>
            <div className="shrink-0 text-sm tabular-nums text-slate-500">
              {card.expires_in_secs}s
            </div>
          </button>
        ))}
      </div>

      <div className="space-y-2 px-4 pt-3">
        {/* Your card is not here — the reader missed you, or the push never
            arrived. Same fallback as the idle screen, offered where the
            operator actually discovers the problem. */}
        <button
          type="button"
          onClick={onManual}
          className="w-full rounded-xl px-4 py-3 text-sm text-slate-400 active:bg-slate-800"
        >
          My name isn't here — enter my number
        </button>

        <BigButton onClick={onCancel} variant="ghost" className="w-full">
          Cancel
        </BigButton>
      </div>
    </Screen>
  );
}

function initials(name: string): string {
  return name
    .split(/[\s.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

// ── 2b. Manual identity (§10) ───────────────────────────────────────────
//
// The path for when the door reader is down. It is not a login: there is no
// token and nothing is remembered afterwards. It opens one session for one
// person, flagged `manual_identity`, and the next operator starts over.

function ManualScreen({
  busy,
  onSubmit,
  onPasskey,
  onCancel,
  banner,
}: {
  busy: boolean;
  onSubmit: (empCode: string, pin: string) => void;
  onPasskey: () => void;
  onCancel: () => void;
  banner: React.ReactNode;
}) {
  const [empCode, setEmpCode] = useState("");
  const [pin, setPin] = useState("");
  const [passkeyReady, setPasskeyReady] = useState(false);
  const ready = empCode.trim().length > 0 && pin.length > 0 && !busy;

  // Asked at render rather than assumed: a wall tablet with no sensor and a
  // desktop browser both answer false, and a fingerprint button that cannot
  // produce a prompt reads as a broken terminal.
  useEffect(() => {
    void isPasskeySupported().then(setPasskeyReady);
  }, []);

  return (
    <Screen>
      <Header title="Enter your number" subtitle="Only when the reader is down" onBack={onCancel} />
      {banner}

      {/* Offered above the PIN because it is both faster and stronger evidence:
          §10 records it as WEBAUTHN rather than PIN, and the ledger keeps that
          distinction. It is still not the door — the phone verifies whoever it
          trusts, it does not match a finger against enrolled templates. */}
      {passkeyReady && (
        <div className="px-4 pb-4">
          <BigButton onClick={onPasskey} variant="primary" className="w-full" disabled={busy}>
            Use fingerprint on this phone
          </BigButton>
          <p className="pt-2 text-center text-xs text-slate-500">
            Only on a phone you registered yourself.
          </p>
        </div>
      )}

      {/* Neither field is a credential the browser should remember. This
          terminal is shared: an autofilled emp code is somebody else's
          identity on somebody else's transaction. `autocomplete="off"` alone
          does not stop Chrome — it stops offering saved logins only once the
          form no longer looks like one, which is why the PIN is a text input
          masked in CSS rather than `type="password"`. */}
      <div className="flex flex-1 flex-col gap-5 px-4">
        <label className="block">
          <span className="text-sm font-semibold text-slate-400">EMPLOYEE CODE</span>
          <input
            name="terminal-emp-code"
            value={empCode}
            onChange={(e) => setEmpCode(e.target.value.toUpperCase())}
            autoFocus
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-2xl tabular-nums outline-none focus:ring-2 focus:ring-sky-500"
          />
        </label>

        <label className="block">
          <span className="text-sm font-semibold text-slate-400">PIN</span>
          <input
            name="terminal-pin"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) onSubmit(empCode.trim(), pin);
            }}
            className="pin tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-2xl tabular-nums outline-none focus:ring-2 focus:ring-sky-500"
          />
        </label>

        <p className="text-sm text-slate-500">
          This is recorded as a typed entry rather than a punch, and the
          storekeeper can see which is which.
        </p>
      </div>

      <div className="px-4 pt-3">
        <BigButton
          onClick={() => onSubmit(empCode.trim(), pin)}
          variant="primary"
          className="w-full"
          disabled={!ready}
        >
          {busy ? "Checking…" : "Continue"}
        </BigButton>
      </div>
    </Screen>
  );
}

// ── 3. Direction (§12.3) ────────────────────────────────────────────────

function DirectionScreen({
  session,
  onPick,
  onCancel,
  banner,
}: {
  session: ActiveSession;
  onPick: (d: Direction) => void;
  onCancel: () => void;
  banner: React.ReactNode;
}) {
  return (
    <Screen>
      <Header
        title={`Welcome, ${session.full_name}`}
        subtitle={session.manual ? `${session.emp_code} · typed in` : session.emp_code}
        onBack={onCancel}
      />
      {banner}

      {/* Two enormous buttons. Nothing else. */}
      <div className="grid flex-1 grid-rows-2 gap-4 p-4">
        <button
          type="button"
          onClick={() => onPick("issue")}
          className="tap flex flex-col items-center justify-center rounded-3xl bg-red-700 text-white active:bg-red-800"
        >
          <span className="text-5xl">↑</span>
          <span className="mt-2 text-3xl font-bold">TAKE OUT</span>
        </button>
        <button
          type="button"
          onClick={() => onPick("receipt")}
          className="tap flex flex-col items-center justify-center rounded-3xl bg-emerald-700 text-white active:bg-emerald-800"
        >
          <span className="text-5xl">↓</span>
          <span className="mt-2 text-3xl font-bold">PUT IN</span>
        </button>
      </div>
    </Screen>
  );
}

// ── 4. Item: scan or search (§12.4) ─────────────────────────────────────

function ItemScreen({
  direction,
  onPick,
  onCancel,
  banner,
}: {
  direction: Direction;
  onPick: (item: Item) => void;
  onCancel: () => void;
  banner: React.ReactNode;
}) {
  // §12.4: the camera opens immediately — unless this browser has no barcode
  // detector, in which case opening a dead camera would just waste the
  // operator's time. Both paths land on the same item card either way.
  const [mode, setMode] = useState<"scan" | "search" | "browse">(
    isScanningSupported() ? "scan" : "search",
  );
  const [scanError, setScanError] = useState<ScannerError | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [looking, setLooking] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);
  // Browsing: the whole crib, in pages, for an operator who knows the tool by
  // sight but not by name. Search needs you to already know what it is called.
  const [catalog, setCatalog] = useState<Item[]>([]);
  const [catalogDone, setCatalogDone] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const busyRef = useRef(false);

  const resolve = useCallback(
    async (code: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setLooking(true);
      setNotFound(null);
      try {
        onPick(await api.lookup(code));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(code);
        } else {
          setNotFound(code);
        }
      } finally {
        setLooking(false);
        busyRef.current = false;
      }
    },
    [onPick],
  );

  useEffect(() => {
    if (mode !== "scan") return;
    const video = videoRef.current;
    if (!video) return;

    let handle: { stop: () => void } | undefined;
    let cancelled = false;

    void startScanner({
      video,
      onDetect: (code) => void resolve(code),
      onError: (e) => {
        setScanError(e);
        setMode("search");
      },
    }).then((h) => {
      if (cancelled) h.stop();
      else handle = h;
    });

    return () => {
      cancelled = true;
      handle?.stop();
    };
  }, [mode, resolve]);

  const PAGE = 40;

  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const offset = catalog.length;
      const page = await api.stock(`limit=${PAGE}&offset=${offset}`);
      setCatalog((current) => [...current, ...page]);
      if (page.length < PAGE) setCatalogDone(true);
    } catch {
      // Leave what has already loaded on screen; the button stays available.
      setCatalogDone(true);
    } finally {
      setLoadingMore(false);
    }
  }, [catalog.length]);

  useEffect(() => {
    if (mode !== "browse" || catalog.length > 0) return;
    void loadMore();
  }, [mode, catalog.length, loadMore]);

  // Typeahead, debounced so a fast typist does not generate a request per key.
  useEffect(() => {
    if (mode !== "search" || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        setResults(await api.search(query));
      } catch {
        setResults([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, mode]);

  return (
    <Screen>
      <Header
        title={direction === "issue" ? "What are you taking?" : "What are you putting in?"}
        onBack={onCancel}
      />
      {banner}

      <div className="flex-1 overflow-y-auto px-4">
        {notFound && (
          <div className="pb-3">
            <Banner tone="warn" onDismiss={() => setNotFound(null)}>
              No item matches <strong>{notFound}</strong>. Try searching instead.
            </Banner>
          </div>
        )}

        {scanError && mode === "search" && (
          <div className="pb-3">
            <Banner tone="info" onDismiss={() => setScanError(null)}>
              {scanError === "permission-denied"
                ? "Camera permission was refused — search for the item instead."
                : scanError === "unsupported"
                  ? "This browser cannot scan barcodes. Search for the item instead."
                  : "The camera is unavailable — search for the item instead."}
            </Banner>
          </div>
        )}

        {mode === "browse" ? (
          <div className="space-y-3">
            {catalog.map((item) => (
              <ItemRow key={item.id} item={item} onClick={() => onPick(item)} />
            ))}
            {catalog.length === 0 && !loadingMore && (
              <p className="py-6 text-center text-slate-500">The catalog is empty.</p>
            )}
            {loadingMore && <Spinner label="Loading the catalog…" />}
            {!catalogDone && !loadingMore && catalog.length > 0 && (
              <BigButton onClick={() => void loadMore()} variant="ghost" className="w-full">
                Show more
              </BigButton>
            )}
          </div>
        ) : mode === "scan" ? (
          <div className="relative overflow-hidden rounded-2xl bg-black">
            <video ref={videoRef} className="aspect-3/4 w-full object-cover" muted />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-28 w-4/5 rounded-xl border-4 border-sky-400/80" />
            </div>
            {looking && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                <Spinner label="Looking up…" />
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Code, description, ISO or grade"
              className="tap w-full rounded-2xl bg-slate-800 px-5 text-lg outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500"
            />
            {results.map((item) => (
              <ItemRow key={item.id} item={item} onClick={() => onPick(item)} />
            ))}
            {query.trim().length >= 2 && results.length === 0 && (
              <p className="py-6 text-center text-slate-500">Nothing matches that.</p>
            )}
          </div>
        )}
      </div>

      {/* §12.4: a permanent "Search instead" button, never buried in a menu.
          Browsing sits alongside it for the operator who would recognise the
          tool on sight but cannot name it — search cannot help you find a thing
          you do not know the word for. */}
      <div className="flex gap-2 px-4 pt-3">
        {mode !== "scan" && isScanningSupported() && (
          <BigButton onClick={() => setMode("scan")} variant="ghost" className="flex-1">
            Scan
          </BigButton>
        )}
        {mode !== "search" && (
          <BigButton onClick={() => setMode("search")} variant="ghost" className="flex-1">
            Search
          </BigButton>
        )}
        {mode !== "browse" && (
          <BigButton onClick={() => setMode("browse")} variant="ghost" className="flex-1">
            Browse all
          </BigButton>
        )}
      </div>
    </Screen>
  );
}

function ItemRow({ item, onClick }: { item: Item; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tap flex w-full items-center gap-3 rounded-2xl bg-slate-800 px-4 py-3 text-left active:bg-slate-700"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-semibold">{item.item_code}</div>
        <div className="truncate text-sm text-slate-400">{item.description}</div>
        {item.bin_location && (
          <div className="text-xs text-slate-500">Bin {item.bin_location}</div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className="text-lg font-bold tabular-nums">{formatQty(item.on_hand)}</div>
        <AlertChip level={item.alert_state} />
      </div>
    </button>
  );
}

// ── 5. Quantity (§12.5) ─────────────────────────────────────────────────

function QuantityScreen({
  item,
  direction,
  onNext,
  onBack,
  banner,
}: {
  item: Item;
  direction: Direction;
  onNext: (qty: string) => void;
  onBack: () => void;
  banner: React.ReactNode;
}) {
  // Default 1 — the overwhelmingly common case, and what makes a single-insert
  // issue two taps rather than five.
  const [value, setValue] = useState("1");

  const press = (key: string) => {
    setValue((current) => {
      if (key === "⌫") return current.length > 1 ? current.slice(0, -1) : "0";
      if (key === ".") return current.includes(".") ? current : `${current}.`;
      if (current === "0") return key;
      // numeric(12,3): refuse a fourth decimal place here rather than letting
      // the server reject the whole transaction after the operator has typed it.
      const [, decimals] = current.split(".");
      if (decimals !== undefined && decimals.length >= 3) return current;
      return current + key;
    });
  };

  const bump = (by: number) =>
    setValue((current) => String((Number.parseFloat(current) || 0) + by));

  const numeric = Number.parseFloat(value) || 0;
  const short = direction === "issue" && numeric > Number.parseFloat(item.on_hand);
  // What the server will actually refuse (§7), as opposed to what merely looks
  // surprising.
  const refused = short && !item.allow_negative;

  return (
    <Screen>
      <Header title={item.item_code} subtitle={item.description} onBack={onBack} />
      {banner}

      <div className="px-4 pb-3">
        <div className="flex items-baseline justify-between rounded-2xl bg-slate-900 px-4 py-3">
          <span className="text-sm text-slate-400">
            In system{item.bin_location ? ` · bin ${item.bin_location}` : ""}
          </span>
          <span className="text-lg font-bold tabular-nums">
            {formatQty(item.on_hand)} {item.uom}
          </span>
        </div>
      </div>

      <div className="px-4 pb-2 text-center">
        <div className={`text-6xl font-bold tabular-nums ${refused ? "text-red-400" : ""}`}>
          {value}
        </div>
        {/* §7: the server rejects an issue that would take stock below zero
            with a 409 unless the item allows it. Letting the operator key a
            number the server has already decided to refuse, then failing at
            confirm, wastes the trip — so Next goes dead here, wearing the
            §7 wording. Where allow_negative is set the number is legal and
            the old advisory warning stands. */}
        {short && !item.allow_negative && (
          <p className="mt-2 text-sm text-red-400">
            Only {formatQty(item.on_hand)} {item.uom} left in system — count the bin and
            adjust.
          </p>
        )}
        {short && item.allow_negative && (
          <p className="mt-2 text-sm text-amber-400">
            More than the system shows — count the bin before you confirm.
          </p>
        )}
      </div>

      <div className="flex gap-2 px-4 pb-3">
        {[1, 5, 10].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => bump(n)}
            className="tap flex-1 rounded-xl bg-slate-800 text-lg font-semibold active:bg-slate-700"
          >
            +{n}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"].map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            className="tap rounded-xl bg-slate-800 text-2xl font-semibold active:bg-slate-700"
          >
            {key}
          </button>
        ))}
      </div>

      <div className="px-4 pt-4">
        <BigButton
          onClick={() => onNext(value)}
          variant="primary"
          className="w-full"
          disabled={numeric <= 0 || refused}
        >
          Next
        </BigButton>
      </div>
    </Screen>
  );
}

// ── 6. Optional: machine and reason (§12.6) ─────────────────────────────

function OptionalScreen({
  direction,
  onNext,
  onBack,
  banner,
}: {
  direction: Direction;
  onNext: (machines: Machine[], reasonId: string | null) => void;
  onBack: () => void;
  banner: React.ReactNode;
}) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [reasons, setReasons] = useState<ReasonCode[]>([]);
  // §11: an operator can take one item for several machines in one trip. Tap to
  // add, tap again to remove; picking exactly one behaves as it always did.
  const [picked, setPicked] = useState<string[]>([]);
  const [reasonId, setReasonId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [m, r] = await Promise.all([api.machines(), api.reasonCodes()]);
        setMachines(m);
        setReasons(r);
      } catch {
        // These are optional fields. Failing to load the pickers must not block
        // the transaction — SKIP still works.
      }
    })();
  }, []);

  const applicable = useMemo(
    () =>
      reasons.filter((r) => r.applies_to === (direction === "issue" ? "ISSUE" : "RECEIPT")),
    [reasons, direction],
  );

  return (
    <Screen>
      <Header title="Anything else?" subtitle="Optional" onBack={onBack} />
      {banner}

      <div className="flex-1 space-y-5 overflow-y-auto px-4">
        {direction === "issue" && machines.length > 0 && (
          <section>
            <h2 className="pb-2 text-sm font-semibold text-slate-400">
              MACHINE
              {picked.length > 1 && (
                <span className="pl-2 font-normal text-sky-400">
                  {picked.length} selected — you'll set a quantity for each
                </span>
              )}
            </h2>
            <div className="flex flex-wrap gap-2">
              {machines.map((m) => (
                <Chip
                  key={m.id}
                  label={m.code}
                  selected={picked.includes(m.id)}
                  onClick={() =>
                    setPicked((current) =>
                      current.includes(m.id)
                        ? current.filter((id) => id !== m.id)
                        : [...current, m.id],
                    )
                  }
                />
              ))}
            </div>
          </section>
        )}

        {applicable.length > 0 && (
          <section>
            <h2 className="pb-2 text-sm font-semibold text-slate-400">REASON</h2>
            <div className="flex flex-wrap gap-2">
              {applicable.map((r) => (
                <Chip
                  key={r.id}
                  label={r.label}
                  selected={reasonId === r.id}
                  onClick={() => setReasonId(reasonId === r.id ? null : r.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* §12.6: skipping must never be slower than filling. SKIP is the biggest
          control here, and it is reachable without scrolling. */}
      <div className="space-y-2 px-4 pt-3">
        <BigButton onClick={() => onNext([], null)} variant="ghost" className="w-full">
          SKIP
        </BigButton>
        <BigButton
          onClick={() =>
            onNext(
              // Ordered as the operator tapped them, so the split screen reads
              // in the order they were thinking.
              picked
                .map((id) => machines.find((m) => m.id === id))
                .filter((m): m is Machine => m !== undefined),
              reasonId,
            )
          }
          variant="primary"
          className="w-full"
        >
          Next
        </BigButton>
      </div>
    </Screen>
  );
}

// ── 6b. Split: how many for each machine (§11) ──────────────────────────
//
// Only reached when two or more machines were picked. One ledger row per
// machine is written from here, in one transaction — so either the whole trip
// is recorded or none of it is.

function SplitScreen({
  item,
  machines,
  total,
  onNext,
  onBack,
  banner,
}: {
  item: Item;
  machines: Machine[];
  total: string;
  onNext: (splits: Split[]) => void;
  onBack: () => void;
  banner: React.ReactNode;
}) {
  // Seeded from the quantity already keyed, spread as evenly as the number
  // divides, remainder on the first machine. Most trips are "one each" or "two
  // each", so the common case needs no typing at all.
  const [quantities, setQuantities] = useState<string[]>(() => {
    const asked = Number.parseFloat(total) || 0;
    const each = Math.floor(asked / machines.length);
    return machines.map((_, i) =>
      String(i === 0 ? asked - each * (machines.length - 1) : each),
    );
  });

  const set = (index: number, next: string) =>
    setQuantities((current) => current.map((q, i) => (i === index ? next : q)));

  const sum = quantities.reduce((acc, q) => acc + (Number.parseFloat(q) || 0), 0);
  const available = Number.parseFloat(item.on_hand);
  const refused = sum > available && !item.allow_negative;
  const ready = sum > 0 && !refused && quantities.every((q) => (Number.parseFloat(q) || 0) > 0);

  return (
    <Screen>
      <Header title="How many for each?" subtitle={item.item_code} onBack={onBack} />
      {banner}

      <div className="flex-1 space-y-3 overflow-y-auto px-4">
        {machines.map((machine, i) => (
          <div
            key={machine.id}
            className="flex items-center gap-3 rounded-2xl bg-slate-800 px-4 py-3"
          >
            <span className="flex-1 text-lg font-semibold">{machine.code}</span>
            <button
              type="button"
              aria-label={`one fewer for ${machine.code}`}
              onClick={() => set(i, String(Math.max(0, (Number.parseFloat(quantities[i]!) || 0) - 1)))}
              className="tap w-14 rounded-xl bg-slate-700 text-2xl font-semibold active:bg-slate-600"
            >
              −
            </button>
            <span className="w-16 text-center text-3xl font-bold tabular-nums">
              {quantities[i]}
            </span>
            <button
              type="button"
              aria-label={`one more for ${machine.code}`}
              onClick={() => set(i, String((Number.parseFloat(quantities[i]!) || 0) + 1))}
              className="tap w-14 rounded-xl bg-slate-700 text-2xl font-semibold active:bg-slate-600"
            >
              +
            </button>
          </div>
        ))}
      </div>

      <div className="px-4 pt-3 text-center">
        <p className={`text-sm ${refused ? "text-red-400" : "text-slate-400"}`}>
          {refused ? (
            <>
              Only {formatQty(item.on_hand)} {item.uom} left in system — count the bin and
              adjust.
            </>
          ) : (
            <>
              total {formatQty(String(sum))} of {formatQty(item.on_hand)} {item.uom} available
            </>
          )}
        </p>
      </div>

      <div className="px-4 pt-3">
        <BigButton onClick={() => onNext(machines.map((machine, i) => ({ machine, qty: quantities[i]! })))} variant="primary" className="w-full" disabled={!ready}>
          Next
        </BigButton>
      </div>
    </Screen>
  );
}

function Chip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tap rounded-xl px-5 text-base font-semibold ${
        selected ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-200 active:bg-slate-700"
      }`}
    >
      {label}
    </button>
  );
}

// ── 7. Confirm (§12.7) ──────────────────────────────────────────────────

function ConfirmScreen({
  step,
  busy,
  onConfirm,
  onBack,
  banner,
}: {
  step: Extract<Step, { name: "confirm" }>;
  busy: boolean;
  onConfirm: () => void;
  onBack: () => void;
  banner: React.ReactNode;
}) {
  const out = step.direction === "issue";
  return (
    <Screen>
      <Header title="Confirm" onBack={onBack} />
      {banner}

      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
        <div
          className={`rounded-2xl px-6 py-2 text-2xl font-bold ${
            out ? "bg-red-700" : "bg-emerald-700"
          }`}
        >
          {out ? "TAKE OUT" : "PUT IN"}
        </div>
        <div className="text-6xl font-bold tabular-nums">
          {step.qty} <span className="text-3xl text-slate-400">{step.item.uom}</span>
        </div>
        <div>
          <div className="text-2xl font-semibold">{step.item.item_code}</div>
          <div className="text-slate-400">{step.item.description}</div>
        </div>

        {/* A split issue writes one row per machine. Show the breakdown before
            the operator commits, because the ledger will show it afterwards. */}
        {step.splits && (
          <div className="w-full max-w-xs space-y-1">
            {step.splits.map((s) => (
              <div key={s.machine.id} className="flex justify-between text-slate-300">
                <span>{s.machine.code}</span>
                <span className="font-semibold tabular-nums">
                  {formatQty(s.qty)} {step.item.uom}
                </span>
              </div>
            ))}
            <p className="pt-1 text-xs text-slate-500">
              {step.splits.length} ledger rows, one per machine
            </p>
          </div>
        )}
        <div className="text-sm text-slate-500">
          {step.session.full_name} · {step.session.emp_code}
          {step.session.manual ? " · typed in" : ""}
        </div>
      </div>

      <div className="px-4 pt-3">
        <BigButton
          onClick={onConfirm}
          variant={out ? "take-out" : "put-in"}
          className="h-20 w-full text-2xl"
          disabled={busy}
        >
          {busy ? "Saving…" : "CONFIRM"}
        </BigButton>
      </div>
    </Screen>
  );
}

// ── 8. Success (§12.7, §12.8) ───────────────────────────────────────────

function SuccessScreen({
  result,
  queued,
  onDone,
}: {
  result: TxnResponse;
  queued: boolean;
  onDone: () => void;
}) {
  return (
    <Screen>
      <div className="flex flex-1 flex-col items-center justify-center gap-5 px-4 text-center">
        <div
          className={`flex h-24 w-24 items-center justify-center rounded-full text-5xl ${
            queued ? "bg-amber-600" : "bg-emerald-600"
          }`}
        >
          {queued ? "⏳" : "✓"}
        </div>

        <div>
          <div className="text-2xl font-bold">{result.item_code}</div>
          <div className="text-slate-400">{result.description}</div>
        </div>

        {queued ? (
          <Banner tone="warn">
            Saved on this device — the store server is offline. It will be sent
            automatically when the network returns.
          </Banner>
        ) : (
          <div>
            <div className="text-sm text-slate-400">Now in system</div>
            <div className="text-5xl font-bold tabular-nums">{formatQty(result.on_hand)}</div>
          </div>
        )}

        {/* §12.7: if it crossed the reorder level, say so in words the operator
            can act on — not a colour change they have to interpret. */}
        {result.crossed_threshold && (
          <Banner tone={result.alert_state === "EMPTY" ? "error" : "warn"}>
            This item is now <strong>{result.alert_state}</strong> — storekeeper notified.
          </Banner>
        )}
      </div>

      <div className="px-4 pt-3">
        <BigButton onClick={onDone} variant="primary" className="w-full">
          Done
        </BigButton>
      </div>
    </Screen>
  );
}
