// Consumption (§11, M8). Where the stock went, not how much is left.
//
// Five groupings over one question. The two that get looked at are by machine —
// which job is eating the inserts — and by month, which is the one that tells
// you whether this month is unusual. Item and category are for purchasing;
// operator is for a conversation nobody enjoys, and is included because the
// ledger already knows and hiding it would be pretending otherwise.
//
// `to` is exclusive, so two adjacent ranges cannot both count the boundary.
// The presets do the arithmetic, because a storekeeper typing 2026-09-01 to
// mean "all of August" is exactly the sort of correct-but-surprising thing that
// makes people distrust a report.
//
// The value column is priced at the cost snapshot taken when each movement was
// booked, never today's price — valuing last year's consumption at this year's
// price would quietly rewrite last year.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import type { ConsumptionRow, GroupBy, adminApi } from "../lib/admin";
import { Spinner } from "../components/ui";

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: "machine", label: "Machine" },
  { value: "item", label: "Item" },
  { value: "category", label: "Category" },
  { value: "operator", label: "Person" },
  { value: "month", label: "Month" },
];

type Preset = "30d" | "month" | "year" | "all";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "30d", label: "30 days" },
  { value: "month", label: "This month" },
  { value: "year", label: "This year" },
  { value: "all", label: "All time" },
];

function rangeFor(preset: Preset): { from?: string; to?: string } {
  const now = new Date();
  switch (preset) {
    case "30d":
      return { from: new Date(Date.now() - 30 * 86_400_000).toISOString() };
    case "month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    case "year":
      return { from: new Date(now.getFullYear(), 0, 1).toISOString() };
    case "all":
      return {};
  }
}

export function Reports({
  client,
  onError,
  onNotice,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("machine");
  const [preset, setPreset] = useState<Preset>("30d");
  const [rows, setRows] = useState<ConsumptionRow[] | null>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(() => {
    client
      .consumption(groupBy, rangeFor(preset))
      .then(setRows)
      .catch((err) => {
        onError(describe(err));
        setRows([]);
      });
  }, [client, groupBy, preset, onError]);

  useEffect(load, [load]);

  const totalQty = (rows ?? []).reduce((sum, r) => sum + Number(r.qty), 0);
  const totalValue = (rows ?? []).reduce((sum, r) => sum + Number(r.value), 0);
  // The widest bar is the one to compare the others against; an absolute scale
  // would make a quiet month look like an empty one.
  const biggest = Math.max(1, ...(rows ?? []).map((r) => Number(r.qty)));

  async function download() {
    setDownloading(true);
    try {
      const blob = await client.consumptionCsv(groupBy, rangeFor(preset));
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `consumption-by-${groupBy}.csv`;
      link.click();
      // Revoked late: revoking immediately races the save.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onNotice("CSV downloaded.");
    } catch (err) {
      onError(describe(err));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1">
        {GROUPS.map((group) => (
          <button
            key={group.value}
            type="button"
            onClick={() => {
              // Blank the figures on the tap that changes their meaning, not
              // inside the effect that reloads them: numbers from the previous
              // grouping sitting under a new heading is the one thing a report
              // must never do.
              setRows(null);
              setGroupBy(group.value);
            }}
            className={`tap rounded-lg px-2 text-sm font-semibold ${
              groupBy === group.value ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            {group.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-1">
        {PRESETS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => {
              setRows(null);
              setPreset(option.value);
            }}
            className={`tap rounded-lg px-1 text-xs ${
              preset === option.value ? "bg-slate-700 text-white" : "bg-slate-900 text-slate-400"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {!rows && <Spinner label="Adding it up…" />}

      {rows && rows.length === 0 && (
        <p className="py-10 text-center text-slate-500">
          Nothing went out in this period. Only ISSUE and SCRAP count as
          consumption — stock arriving is not.
        </p>
      )}

      {rows && rows.length > 0 && (
        <>
          <div className="rounded-xl bg-slate-900 px-4 py-3">
            <div className="text-xs text-slate-500">
              Total consumed · {rows.length} {groupBy === "month" ? "months" : "buckets"}
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums">
                {totalQty.toLocaleString(undefined, { maximumFractionDigits: 3 })}
              </span>
              <span className="text-sm text-slate-400 tabular-nums">
                ₹{totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>

          {rows.map((row) => (
            <div key={row.bucket_key} className="rounded-xl bg-slate-900 px-4 py-3">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {row.bucket_label}
                </span>
                <span className="shrink-0 text-lg font-bold tabular-nums">
                  {Number(row.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                <div
                  className="h-full rounded-full bg-sky-500"
                  style={{ width: `${(Number(row.qty) / biggest) * 100}%` }}
                />
              </div>
              <div className="pt-1 text-xs text-slate-500 tabular-nums">
                ₹{Number(row.value).toLocaleString(undefined, { minimumFractionDigits: 2 })} ·{" "}
                {row.txn_count} transaction{row.txn_count === 1 ? "" : "s"}
              </div>
            </div>
          ))}

          <button
            type="button"
            disabled={downloading}
            onClick={download}
            className="tap w-full rounded-xl bg-slate-800 px-4 text-sm text-slate-200 disabled:opacity-40"
          >
            {downloading ? "Preparing…" : "Download CSV"}
          </button>
        </>
      )}

      <p className="pb-4 text-xs text-slate-500">
        Priced at the unit cost recorded when each movement was booked, not
        today&apos;s. A reversed transaction nets itself out — the correcting row
        is a real row with the opposite sign.
      </p>
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
