// Consumption — what the crib actually spent, and on what (CLAUDE.md §11, M8).
//
// The endpoint has been here since M8 and nothing called it, which is the same
// dead wiring as the Setup screens beside it: `GET /reports/consumption` and
// its `.csv` twin were built, tested against a hand-computed fixture, and
// reachable only with curl.
//
// Every figure is a read of the ledger (§7), so there is nothing to maintain
// and nothing that can disagree with the stock screens. The grouping is the
// whole feature: "what did we spend" is a different question from "which
// machine ate it" and "who signed for it", and they are one query apart.
//
// Two things it deliberately does not do:
//
//   * **No date pickers, yet.** The server takes `from` and `to`; this offers
//     whole windows rather than a calendar, because the question on a shop
//     floor is "this month" far more often than "the 3rd to the 19th". The
//     parameters are there when somebody wants the calendar.
//
//   * **No totals row.** Quantities here span every `uom` in the crib (§6) —
//     summing litres with pieces produces a number with no unit, which the
//     terminal's TODAY strip already learned the hard way. Value totals would
//     be meaningful; a quantity total would not, and one without the other
//     invites the reader to add the wrong column.

import { useEffect, useState } from "react";
import type { ConsumptionRow, adminApi } from "../lib/admin";
import { Banner, Spinner } from "../components/ui";

/** §11's `group_by`: item | machine | operator | category | month. */
const GROUPS = [
  ["machine", "By machine"],
  ["item", "By item"],
  ["operator", "By operator"],
  ["category", "By category"],
  ["month", "By month"],
] as const;

type Group = (typeof GROUPS)[number][0];

const WINDOWS = [
  ["30", "Last 30 days"],
  ["90", "Last quarter"],
  ["365", "Last year"],
  ["", "All time"],
] as const;

export function Reports({
  client,
  onError,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (message: string) => void;
}) {
  const [group, setGroup] = useState<Group>("machine");
  const [days, setDays] = useState<string>("30");
  const [rows, setRows] = useState<ConsumptionRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);

    const params = new URLSearchParams({ group_by: group });
    if (days) {
      const from = new Date(Date.now() - Number(days) * 86_400_000);
      params.set("from", from.toISOString());
    }

    client
      .consumption(params.toString())
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((err) => {
        if (cancelled) return;
        // Emptiness and failure are different things. "Nothing went out in this
        // period" is a confident statement about the shop, and a screen must
        // never make it out of a request that did not arrive.
        setFailed(true);
        onError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [client, group, days, onError]);

  const [saving, setSaving] = useState(false);

  /**
   * Fetch the CSV, then hand it to the browser.
   *
   * A plain `<a href>` was the obvious thing and would have shipped a 401: the
   * endpoint needs a token and an href carries no Authorization header, so the
   * browser would have saved the refusal as a file called consumption.csv.
   */
  const saveCsv = async () => {
    setSaving(true);
    try {
      const params = new URLSearchParams({ group_by: group });
      if (days) {
        params.set("from", new Date(Date.now() - Number(days) * 86_400_000).toISOString());
      }
      const blob = await client.consumptionCsv(params.toString());
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `consumption-by-${group}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 overflow-x-auto">
        {GROUPS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setGroup(key)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${
              group === key ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex gap-1 overflow-x-auto">
        {WINDOWS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setDays(key)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm ${
              days === key ? "bg-slate-700 text-slate-100" : "bg-slate-800 text-slate-400"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {failed ? (
        <Banner tone="error">
          This report did not load, so the figures below are missing rather than
          zero.
        </Banner>
      ) : rows === null ? (
        <Spinner label="Adding up the ledger…" />
      ) : rows.length === 0 ? (
        <p className="py-10 text-center text-slate-400">
          Nothing went out in this period.
        </p>
      ) : (
        <div className="divide-y divide-slate-800 rounded-xl bg-slate-800/30">
          {rows.map((row) => (
            <div key={row.bucket_key} className="flex items-baseline gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold text-slate-100">
                  {row.bucket_label}
                </div>
                <div className="text-sm text-slate-400">
                  {row.txn_count} movement{row.txn_count === 1 ? "" : "s"}
                </div>
              </div>
              <div className="shrink-0 text-right">
                {/* Quantity above value, because the storekeeper's question is
                    "how many" and the owner's is "how much" — and the two are
                    in different units, so they must not sit on one line. */}
                <div className="tabular-nums font-bold text-slate-100">{row.qty}</div>
                <div className="text-sm tabular-nums text-slate-400">₹{row.value}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={() => void saveCsv()}
        disabled={saving}
        className="block w-full py-2 text-center text-sm text-sky-400 disabled:text-slate-500"
      >
        {saving ? "Preparing…" : "↓ CSV"}
      </button>
    </div>
  );
}
