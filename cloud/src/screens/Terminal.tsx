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
  type InsightItem,
  type InsightView,
  type Item,
  type Machine,
  type ReasonCode,
  type TxnResponse,
  type TerminalStatus,
  type UnclaimedSession,
} from "../lib/api";
import type { ConnectionState } from "../lib/events";
import { enqueue, newTxnId } from "../lib/outbox";
import { isScanningSupported, startScanner, type ScannerError } from "../lib/scanner";
import { VIEW_LABELS, hintFor, viewDetail } from "./Filters";
import { Loaded, useLoadable } from "./Loadable";
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
  | { name: "shortages"; level: "LOW" | "EMPTY" }
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
      note: string | null;
    }
  | {
      name: "confirm";
      session: ActiveSession;
      direction: Direction;
      item: Item;
      qty: string;
      machineId: string | null;
      reasonId: string | null;
      /** What broke, in the operator's words. Required for a damage reason. */
      note: string | null;
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
  //
  // The set is synchronous on purpose and `step` stays state rather than a
  // value derived from `cards`: every other screen in this flow writes it, so
  // deriving the claim arm alone would leave the terminal with two sources of
  // truth for where it is.
  useEffect(() => {
    if (step.name === "idle" && cards.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep({ name: "claim" });
    }
    if (step.name === "claim" && cards.length === 0) {
      setStep({ name: "idle" });
    }
  }, [cards.length, step.name]);

  /* What this crib is: does it have a door reader, and what has moved today.
   *
   * Fetched when the screen goes idle rather than on a timer. Idle is when
   * somebody is reading it, and §12's eight-second budget belongs to the steps
   * after it — a poll running behind a quantity pad spends the operator's
   * network and tells nobody anything. A failure leaves `status` null, which
   * renders the screen without the strip and without any claim about a reader,
   * because a wrong claim about the reader sends an operator to a wall.
   */
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  useEffect(() => {
    if (step.name !== "idle") return;
    let live = true;
    void api
      .terminalStatus(localMidnight())
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => {
        // Silent by design, and the only silent catch here: the strip is
        // decoration on a screen whose job is the button above it. Nothing is
        // hidden — `status` stays null and the screen says less, rather than
        // saying something untrue.
      });
    return () => {
      live = false;
    };
  }, [step.name]);

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
    note: string | null,
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
          // What broke, when the reason says something did. It rides on every
          // split row, because the batch describes one event.
          ...(note ? { note } : {}),
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
          ...(note ? { note } : {}),
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
          status={status}
          onStart={() => (cards.length > 0 ? setStep({ name: "claim" }) : onRefreshCards())}
          onManual={() => setStep({ name: "manual" })}
          onShowShortages={(level) => setStep({ name: "shortages", level })}
          banner={banner}
        />
      );

    case "shortages":
      return (
        <ShortagesScreen
          level={step.level}
          onBack={() => setStep({ name: "idle" })}
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
          onNext={(machines, reasonId, note) =>
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
                  note,
                })
              : setStep({
                  name: "confirm",
                  session: step.session,
                  direction: step.direction,
                  item: step.item,
                  qty: step.qty,
                  machineId: machines[0]?.id ?? null,
                  reasonId,
                  note,
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
              note: step.note,
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
              step.note,
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

/**
 * Local midnight, as an ISO string, for the day counters.
 *
 * The tablet's clock is the store's clock — it is the thing physically in the
 * crib. The server runs in UTC, where "today" begins at 05:30 in an Indian
 * plant, which is mid-shift: every number on this screen would drop to zero
 * while somebody was looking at it.
 */
function localMidnight(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function IdleScreen({
  connection,
  pending,
  alerts,
  status,
  onStart,
  onManual,
  onShowShortages,
  banner,
}: {
  connection: ConnectionState;
  pending: number;
  alerts: { low: number; empty: number };
  status: TerminalStatus | null;
  onStart: () => void;
  onManual: () => void;
  onShowShortages: (level: "LOW" | "EMPTY") => void;
  banner: React.ReactNode;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Until the first answer comes back, say nothing about a reader rather than
  // guessing. Claiming one exists and being wrong sends an operator to a wall.
  const reader = status?.reader ?? null;

  return (
    <Screen className="justify-between">
      <div className="flex items-center justify-between px-4">
        <span className="text-sm font-semibold tracking-wide text-slate-400">
          ELECTRONIX TOOL STORE
        </span>
        <ConnectionPill state={connection} pending={pending} />
      </div>

      {banner}

      {/* The clock shrinks to a line. It was the largest thing on a screen that
          sits six pixels under the phone's own clock, and §12's budget is eight
          seconds from scan to confirm — the time of day never spends any of it.
          On a wall tablet across a workshop it earns its size again, which is
          what the sm: breakpoint is for. */}
      <div className="flex items-baseline justify-center gap-3 px-4 pt-2">
        <span className="text-4xl font-bold tabular-nums sm:text-6xl">
          {now.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </span>
        <span className="text-sm text-slate-400 sm:text-lg">
          {now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}
        </span>
      </div>

      {/* Not `justify-center`. Centring left the button floating between two
          voids on a tall phone; the sign-in belongs high, where a thumb reaches
          it, and the space that is left belongs to the activity list. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pt-6 pb-4">
        <div>
          <BigButton onClick={onStart} variant="primary" className="w-full">
            I&apos;m here — sign me in
          </BigButton>
          {/* What is actually true of *this* crib. A store with no reader is
              never told to put a finger on one; a store whose reader has gone
              quiet is told that, because the two need opposite remedies. */}
          <p className="pt-2 text-center text-sm text-slate-400">
            {reader === null
              ? "\\u00a0"
              : !reader.installed
                ? "Fingerprint on your own phone, or your employee code and PIN."
                : reader.online
                  ? "Put your finger on the door reader, then tap your name."
                  : "The door reader has gone quiet — use your phone or your PIN."}
          </p>
        </div>

        {/* Tappable, because a count nobody can open is a nag. "2 items are
            EMPTY" tells a storekeeper there is a problem and nothing about
            which bin, which is the one thing they need to do anything. */}
        {(alerts.empty > 0 || alerts.low > 0) && (
          <div className="flex gap-3">
            {alerts.empty > 0 && (
              <ShortageChip
                tone="error"
                n={alerts.empty}
                label="EMPTY"
                onClick={() => onShowShortages("EMPTY")}
              />
            )}
            {alerts.low > 0 && (
              <ShortageChip
                tone="warn"
                n={alerts.low}
                label="LOW"
                onClick={() => onShowShortages("LOW")}
              />
            )}
          </div>
        )}

        {status && <TodayStrip status={status} />}
        {/* Nothing below it: the strip grows into whatever is left. */}
      </div>

      <div className="px-4 pb-2">
        {/* §10's fallback, and on a crib with no reader it is not a fallback at
            all — it is the way in. It stays reachable either way, because the
            shift when the reader dies is exactly the shift nobody can afford to
            stop booking stock on. */}
        <button
          type="button"
          onClick={onManual}
          className="w-full rounded-xl px-4 py-3 text-sm text-slate-400 active:bg-slate-800"
        >
          {reader?.installed === false
            ? "Enter my number"
            : "Reader not working? Enter my number"}
        </button>
      </div>
    </Screen>
  );
}

function ShortageChip({
  tone,
  n,
  label,
  onClick,
}: {
  tone: "error" | "warn";
  n: number;
  label: string;
  onClick: () => void;
}) {
  const tones = {
    error: "border-red-700 bg-red-950 text-red-100",
    warn: "border-amber-600 bg-amber-950 text-amber-100",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`tap flex-1 rounded-xl border-2 px-4 py-3 text-left ${tones[tone]}`}
    >
      <div className="text-2xl font-bold tabular-nums">{n}</div>
      <div className="text-xs tracking-wide opacity-80">{label} · tap to see</div>
    </button>
  );
}

/**
 * What the crib did today.
 *
 * It fills the band under the button that was empty, and it earns the space by
 * answering the question the green "Live" pill only gestures at: is anything
 * actually reaching the server. A storekeeper opening the console to ask "what
 * went out this morning" is a round trip this saves.
 */
function TodayStrip({ status }: { status: TerminalStatus }) {
  const { today, recent } = status;

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-slate-900 px-4 py-3">
      <div className="flex shrink-0 items-center justify-between text-xs tracking-wide text-slate-500">
        <span>TODAY</span>
        {today.last_at && (
          <span>
            last{" "}
            {new Date(today.last_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </span>
        )}
      </div>

      {today.movements === 0 ? (
        <p className="pt-2 text-sm text-slate-400">Nothing has moved yet today.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Trips to the crib, each way. The quantities these replaced were
              summed across units — twenty-litre drums added to carbide
              inserts — which is a number with no unit and no meaning (§6). */}
          <div className="flex shrink-0 items-baseline gap-3 pt-1 text-sm">
            <span>
              <strong className="tabular-nums">{today.movements}</strong>{" "}
              <span className="text-slate-400">
                movement{today.movements === 1 ? "" : "s"}
              </span>
            </span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400">
              <span className="text-red-400">↓</span>{" "}
              <strong className="tabular-nums text-slate-300">{today.out_count}</strong> out
            </span>
            <span className="text-slate-400">
              <span className="text-emerald-400">↑</span>{" "}
              <strong className="tabular-nums text-slate-300">{today.in_count}</strong> in
            </span>
          </div>

          {/* Scrolls rather than pushing the card past the fold. Twenty rows
              rather than eight: the card grows into the space left below the
              chips, and eight never filled a tall phone. A short screen shows
              what fits and scrolls for the rest. */}
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pt-2">
            {recent.map((row) => {
              const out = row.delta_qty.startsWith("-");
              return (
                /* Fixed columns, not a row of inline spans.
                 *
                 * Every field was `shrink-0` in source order, so a quantity of
                 * 11 pushed its item code two characters further right than a
                 * quantity of 1 and the codes never lined up. Time and quantity
                 * are numeric and get fixed widths — the quantity right-aligned
                 * against the arrow, so the digits stack — and the item code
                 * takes the rest. `tabular-nums` is what makes 1 and 11 occupy
                 * the same width per digit. */
                <li key={row.id} className="flex items-baseline gap-2 text-sm">
                  {/* The time is what tells two otherwise identical lines
                      apart. Three rows reading "2 COOL-SYN-20L R. Kumar" look
                      like a rendering fault; three times are three trips to the
                      crib, which is what they were. */}
                  <span className="w-11 shrink-0 tabular-nums text-xs text-slate-500">
                    {new Date(row.created_at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </span>
                  <span
                    className={`w-3 shrink-0 text-center ${
                      out ? "text-red-400" : "text-emerald-400"
                    }`}
                  >
                    {out ? "↓" : "↑"}
                  </span>
                  <span className="w-10 shrink-0 text-right tabular-nums text-slate-200">
                    {formatQty(row.delta_qty.replace("-", ""))}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-slate-400">{row.item_code}</span>
                  {/* Not `split(" ")[0]`: "R. Kumar" becomes "R.", which names
                      nobody. CSS truncation keeps whatever fits. */}
                  <span className="max-w-[5.5rem] shrink-0 truncate text-xs text-slate-500">
                    {row.operator_name}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * What the EMPTY and LOW chips open.
 *
 * The banners this replaced said "2 items are EMPTY" and stopped there, which
 * tells a storekeeper there is a problem and nothing about which bin — the one
 * thing needed to act on it. §12 asks for the count on the idle screen; it does
 * not ask for it to be a dead end.
 *
 * Read-only, and it moves no stock: booking a receipt still goes through a
 * session like every other movement (§7), because a ledger row with no operator
 * behind it is exactly what the ledger exists to prevent.
 */
function ShortagesScreen({
  level,
  onBack,
}: {
  level: "LOW" | "EMPTY";
  onBack: () => void;
}) {
  /* `useLoadable` rather than a private fetch, for the reason that file was
   * written: on this screen an empty list reads "nothing is short" — a
   * statement about the crib — and drawing it from a request that failed is
   * the exact defect it exists to stop. Failure keeps `data` null and offers a
   * Retry instead. */
  const state = useLoadable<Item[]>(
    async () => {
      const rows = await api.stock(
        level === "EMPTY" ? "empty=true&limit=100" : "low=true&limit=100",
      );
      // `low=true` on the server means LOW *or* EMPTY, which is right for a
      // stock screen and wrong for this one: the chip that opened it counted
      // seven and this would list nine. A count that does not survive being
      // tapped is worse than no count.
      return rows.filter((item) => item.alert_state === level);
    },
    [level],
  );

  return (
    <Screen>
      <Header
        title={level === "EMPTY" ? "Empty bins" : "Low on stock"}
        subtitle={
          level === "EMPTY"
            ? "Nothing left in the system"
            : "At or below the reorder level"
        }
        onBack={onBack}
      />

      <div className="flex-1 space-y-2 overflow-y-auto px-4 pb-20">
        <Loaded
          state={state}
          label="Reading stock"
          empty={
            <p className="py-10 text-center text-slate-500">
              Nothing is {level === "EMPTY" ? "empty" : "low"} right now.
            </p>
          }
        >
          {(rows) => (
            <div className="space-y-2">
              {rows.map((item) => (
                <div key={item.id} className="rounded-xl bg-slate-900 px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate font-semibold">
                      {item.item_code}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <strong
                        className={level === "EMPTY" ? "text-red-300" : "text-amber-300"}
                      >
                        {formatQty(item.on_hand)}
                      </strong>
                      <span className="text-slate-500">
                        {" "}
                        / {formatQty(item.reorder_level)}
                      </span>
                    </span>
                  </div>
                  <div className="truncate pt-1 text-sm text-slate-400">{item.description}</div>
                  {item.bin_location && (
                    <div className="pt-1 text-xs text-slate-500">bin {item.bin_location}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Loaded>
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

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-20">
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
          My name isn&apos;t here — enter my number
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

  // Browsing starts on "Busiest" rather than alphabetically. An operator who
  // opens the list is nearly always after something the shop gets through
  // constantly, and A-to-Z puts a rarely-touched boring bar at the top. "All"
  // is still one tap away, and the ranking is the same one the console shows,
  // from the same endpoint (§12.4's argument, applied to a list rather than to
  // a scan).
  const [browseView, setBrowseView] = useState<InsightView | "all">("frequent");
  const [insights, setInsights] = useState<InsightItem[] | null>(null);
  const [insightError, setInsightError] = useState<string | null>(null);
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
    if (mode !== "browse" || browseView !== "all" || catalog.length > 0) return;
    // `loadMore` sets state after awaiting the page, not in this pass.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadMore();
  }, [mode, browseView, catalog.length, loadMore]);

  useEffect(() => {
    if (mode !== "browse" || browseView === "all") return;
    let cancelled = false;
    // Blanking has to be synchronous, or the previous view's rows sit under the
    // new heading while the request is in flight — the same rule the console's
    // report panel follows.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInsights(null);
    setInsightError(null);
    api
      .insights(browseView, 60)
      .then((rows) => {
        if (!cancelled) setInsights(rows);
      })
      .catch((err) => {
        // Emptiness and failure are different things, on this screen too: an
        // operator told "nothing here" walks to the bin and finds it full.
        if (!cancelled) setInsightError(describe(err));
      });
    return () => {
      cancelled = true;
    };
  }, [mode, browseView]);

  // Typeahead, debounced so a fast typist does not generate a request per key.
  useEffect(() => {
    if (mode !== "search" || query.trim().length < 2) {
      // Blanking synchronously, for the reason the insights effect above gives:
      // otherwise the previous query's matches stay on screen under a search
      // box that no longer says what found them.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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

      <div className="flex-1 overflow-y-auto px-4 pb-20">
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
            <div className="grid grid-cols-4 gap-1">
              <button
                type="button"
                onClick={() => setBrowseView("all")}
                className={`tap rounded-lg px-2 text-sm font-semibold ${
                  browseView === "all" ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
                }`}
              >
                All
              </button>
              {VIEW_LABELS.slice(0, 3).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setBrowseView(option.value)}
                  className={`tap rounded-lg px-2 text-sm font-semibold ${
                    browseView === option.value
                      ? "bg-sky-600 text-white"
                      : "bg-slate-800 text-slate-300"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            {browseView === "all" ? (
              <>
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
              </>
            ) : insightError ? (
              <Banner tone="warn">
                This list did not load. {insightError} Tap All, or search instead.
              </Banner>
            ) : insights === null ? (
              <Spinner label="Working out what moves…" />
            ) : insights.length === 0 ? (
              <p className="py-6 text-center text-slate-500">
                Nothing to show under {hintFor(browseView)}.
              </p>
            ) : (
              insights.map((item) => (
                <div key={item.id}>
                  <ItemRow item={item} onClick={() => onPick(item)} />
                  <p className="px-4 pt-1 text-xs text-slate-500">
                    {viewDetail(browseView, item)}
                  </p>
                </div>
              ))
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

  // …but the default must not become a prefix. Tapping 2 on a pad showing 1
  // meant 12, which is the kind of mistake that reaches the ledger looking
  // deliberate: it is a plausible quantity, nothing refuses it, and the bin is
  // ten short a week later. The first digit replaces the default; after that
  // the pad appends normally, so 1→2→5 still types 25.
  const [pristine, setPristine] = useState(true);

  const press = (key: string) => {
    setPristine(false);
    setValue((current) => {
      if (key === "⌫") return current.length > 1 ? current.slice(0, -1) : "0";
      if (key === ".") return pristine ? "0." : current.includes(".") ? current : `${current}.`;
      if (pristine) return key;
      if (current === "0") return key;
      // numeric(12,3): refuse a fourth decimal place here rather than letting
      // the server reject the whole transaction after the operator has typed it.
      const [, decimals] = current.split(".");
      if (decimals !== undefined && decimals.length >= 3) return current;
      return current + key;
    });
  };

  const bump = (by: number) => {
    setPristine(false);
    setValue((current) => String((Number.parseFloat(current) || 0) + by));
  };

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

      <div className="px-4 pb-16 pt-4">
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

/**
 * Reason codes that mean a tool was destroyed rather than used up.
 *
 * By code, not by label: §6 seeds the codes and an admin can rename the label
 * to anything, so matching on the display text would silently stop asking the
 * moment somebody typed "Broken in cut (report!)". A reason added later that
 * also means damage belongs in this set.
 */
const DAMAGE_REASONS = new Set(["BREAKAGE", "SCRAP", "DAMAGE"]);

function OptionalScreen({
  direction,
  onNext,
  onBack,
  banner,
}: {
  direction: Direction;
  onNext: (machines: Machine[], reasonId: string | null, note: string | null) => void;
  onBack: () => void;
  banner: React.ReactNode;
}) {
  const [machines, setMachines] = useState<Machine[]>([]);
  const [reasons, setReasons] = useState<ReasonCode[]>([]);
  // §11: an operator can take one item for several machines in one trip. Tap to
  // add, tap again to remove; picking exactly one behaves as it always did.
  const [picked, setPicked] = useState<string[]>([]);
  const [reasonId, setReasonId] = useState<string | null>(null);
  const [note, setNote] = useState("");

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

  // Damage is the one reason worth interrupting somebody for.
  //
  // Everything else on this screen is optional by design (§12.6) and skipping
  // must never be slower than filling. A breakage is different: "BREAKAGE, 2"
  // tells the storekeeper a tool broke and nothing about whether it was a bad
  // insert, a crash, or the wrong feed — which is the only part anybody can act
  // on. The cost is one sentence, and only on the transactions where the shop
  // has already lost a tool.
  const damaged = applicable.find((r) => r.id === reasonId && DAMAGE_REASONS.has(r.code));
  const needsNote = damaged !== undefined && note.trim().length < 3;

  return (
    <Screen>
      <Header title="Anything else?" subtitle="Optional" onBack={onBack} />
      {banner}

      <div className="flex-1 space-y-5 overflow-y-auto px-4 pb-20">
        {direction === "issue" && machines.length > 0 && (
          <section>
            <h2 className="pb-2 text-sm font-semibold text-slate-400">
              MACHINE
              {picked.length > 1 && (
                <span className="pl-2 font-normal text-sky-400">
                  {picked.length} selected — you&apos;ll set a quantity for each
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
                  onClick={() => {
                    const next = reasonId === r.id ? null : r.id;
                    setReasonId(next);
                    if (next === null || !DAMAGE_REASONS.has(r.code)) setNote("");
                  }}
                />
              ))}
            </div>

            {damaged && (
              <div className="pt-3">
                <label className="block text-sm font-semibold text-slate-400">
                  WHAT HAPPENED?
                  <span className="pl-2 font-normal text-amber-400">required</span>
                </label>
                <input
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Crashed into the fixture / bad edge out of the box"
                  className="tap mt-1 w-full rounded-xl bg-slate-800 px-4 text-base outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-amber-500"
                />
                <p className="pt-1 text-xs text-slate-500">
                  {damaged.label} on its own says a tool broke. This says why, which
                  is the part somebody can act on.
                </p>
              </div>
            )}
          </section>
        )}
      </div>

      {/* §12.6: skipping must never be slower than filling. SKIP is the biggest
          control here, and it is reachable without scrolling. */}
      <div className="space-y-2 px-4 pb-16 pt-3">
        <BigButton
          onClick={() => onNext([], null, null)}
          variant="ghost"
          className="w-full"
        >
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
              note.trim() === "" ? null : note.trim(),
            )
          }
          variant="primary"
          className="w-full"
          disabled={needsNote}
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

      <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-20">
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

      <div className="px-4 pb-16 pt-3">
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

      <div className="px-4 pb-16 pt-3">
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
