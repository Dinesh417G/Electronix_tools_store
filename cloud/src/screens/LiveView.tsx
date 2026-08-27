// The live view — a read-only window on the store, updating as things happen.
//
// This is what lets the shop be demonstrated and audited without the tablet
// hardware being on the wall yet. Everything here is a read of the ledger
// (§1: "Everything else in the product — reports, alerts, admin — is a read of
// that ledger"), so nothing on this screen can move stock.
//
// It refreshes on SSE events rather than on a timer. A poll loop would be
// simpler and would also mean the wall display is always a few seconds stale
// while somebody is standing there watching it.

import { useCallback, useEffect, useState } from "react";
import {
  api,
  formatQty,
  type AlertRow,
  type Item,
  type LedgerRow,
} from "../lib/api";
import type { ConnectionState, ServerEvent } from "../lib/events";
import { AlertChip, ConnectionPill, Spinner } from "../components/ui";

interface Props {
  connection: ConnectionState;
  /** Bumped by the app whenever a server event arrives, to trigger a reload. */
  revision: number;
  lastEvent: ServerEvent | null;
}

type Tab = "activity" | "stock" | "alerts";

export function LiveView({ connection, revision, lastEvent }: Props) {
  const [tab, setTab] = useState<Tab>("activity");
  const [ledger, setLedger] = useState<LedgerRow[] | null>(null);
  const [stock, setStock] = useState<Item[] | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, s, a] = await Promise.all([
        api.ledger("limit=40"),
        api.stock("limit=200"),
        api.alerts(),
      ]);
      setLedger(l);
      setStock(s);
      setAlerts(a);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, revision]);

  // A slow safety net for anything that does not emit an event — an admin
  // adjustment made from another machine, say. Rare enough that thirty seconds
  // is plenty; the SSE stream carries everything time-sensitive.
  useEffect(() => {
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="flex min-h-full flex-col safe-top safe-bottom">
      <header className="flex items-center justify-between px-4 pb-3">
        <div>
          <h1 className="text-xl font-bold">Live view</h1>
          <p className="text-sm text-slate-400">ElectronIx Tool Store</p>
        </div>
        <ConnectionPill state={connection} pending={0} />
      </header>

      {lastEvent && lastEvent.type !== "heartbeat" && (
        <div className="px-4 pb-2">
          <EventTicker event={lastEvent} />
        </div>
      )}

      {error && (
        <div className="px-4 pb-2 text-sm text-red-400">{error}</div>
      )}

      <nav className="flex gap-1 px-4 pb-3">
        {(
          [
            ["activity", "Activity"],
            ["stock", "Stock"],
            ["alerts", `Alerts${alerts?.length ? ` (${alerts.length})` : ""}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold ${
              tab === key ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {tab === "activity" && <Activity rows={ledger} />}
        {tab === "stock" && <Stock rows={stock} />}
        {tab === "alerts" && <Alerts rows={alerts} />}
      </div>
    </div>
  );
}

function EventTicker({ event }: { event: ServerEvent }) {
  const text = (() => {
    switch (event.type) {
      case "session.opened":
        return `${event.full_name} at the door`;
      case "session.claimed":
        return `Session claimed on ${event.tablet_id}`;
      case "session.closed":
        return `Session closed (${event.reason.toLowerCase()})`;
      case "alert.raised":
        return `${event.item_code} is now ${event.level}`;
      case "punch.unknown_user":
        // §9.4: never dropped. An unknown user at the door is an admin problem
        // to fix, and it belongs where somebody will see it.
        return `Unknown user ${event.zk_user_id} at ${event.device_serial}`;
      default:
        return null;
    }
  })();

  if (!text) return null;

  const tone =
    event.type === "punch.unknown_user" || event.type === "alert.raised"
      ? "bg-amber-500/15 text-amber-200"
      : "bg-sky-500/15 text-sky-200";

  return <div className={`rounded-xl px-3 py-2 text-sm ${tone}`}>{text}</div>;
}

function Activity({ rows }: { rows: LedgerRow[] | null }) {
  if (!rows) return <Spinner label="Loading activity…" />;
  if (rows.length === 0) {
    return <Empty>Nothing has moved yet.</Empty>;
  }

  return (
    <ol className="space-y-2">
      {rows.map((row) => {
        const out = row.delta_qty.startsWith("-");
        return (
          <li
            key={row.id}
            className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3"
          >
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg font-bold ${
                out ? "bg-red-900 text-red-300" : "bg-emerald-900 text-emerald-300"
              }`}
            >
              {out ? "↑" : "↓"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{row.item_code}</div>
              <div className="truncate text-sm text-slate-400">
                {row.operator_name}
                {row.machine_code ? ` · ${row.machine_code}` : ""}
                {row.reason_code ? ` · ${row.reason_code}` : ""}
                {/* §7: a reversal is a real row with the opposite sign, and it
                    says so rather than quietly cancelling the original out. */}
                {row.reverses_id ? ` · reverses #${row.reverses_id}` : ""}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div
                className={`text-lg font-bold tabular-nums ${
                  out ? "text-red-400" : "text-emerald-400"
                }`}
              >
                {formatQty(row.delta_qty)}
              </div>
              <div className="text-xs text-slate-500">{clock(row.created_at)}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Stock({ rows }: { rows: Item[] | null }) {
  if (!rows) return <Spinner label="Loading stock…" />;
  if (rows.length === 0) return <Empty>No items in the catalog yet.</Empty>;

  return (
    <ol className="space-y-2">
      {rows.map((item) => (
        <li key={item.id} className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{item.item_code}</span>
              <AlertChip level={item.alert_state} />
            </div>
            <div className="truncate text-sm text-slate-400">{item.description}</div>
            {item.bin_location && (
              <div className="text-xs text-slate-500">Bin {item.bin_location}</div>
            )}
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-bold tabular-nums">{formatQty(item.on_hand)}</div>
            <div className="text-xs text-slate-500">{item.uom}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Alerts({ rows }: { rows: AlertRow[] | null }) {
  if (!rows) return <Spinner label="Loading alerts…" />;
  if (rows.length === 0) {
    return <Empty>Nothing is low or empty. Everything is above its reorder level.</Empty>;
  }

  return (
    <ol className="space-y-2">
      {rows.map((alert) => (
        <li
          key={alert.id}
          className={`rounded-xl border-l-4 bg-slate-900 px-4 py-3 ${
            alert.level === "EMPTY" ? "border-red-500" : "border-amber-500"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold">{alert.item_code}</span>
            <AlertChip level={alert.level} />
          </div>
          <div className="text-sm text-slate-400">{alert.description}</div>
          <div className="pt-1 text-sm">
            <span className="tabular-nums text-slate-300">
              {formatQty(alert.on_hand)} on hand
            </span>
            <span className="text-slate-500">
              {" "}
              · reorder at {formatQty(alert.reorder_level)}
              {alert.reorder_qty ? ` · order ${formatQty(alert.reorder_qty)}` : ""}
            </span>
          </div>
          {alert.bin_location && (
            <div className="text-xs text-slate-500">Bin {alert.bin_location}</div>
          )}
        </li>
      ))}
    </ol>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-12 text-center text-slate-500">{children}</p>;
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
