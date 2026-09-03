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

import { useState } from "react";
import { ApiError } from "../lib/api";
import type { GroupBy, adminApi } from "../lib/admin";
import { Loaded, useLoadable } from "./Loadable";
import { Chip } from "../components/ui";

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

type Panel = "consumption" | "machines" | "people";

const PANELS: { value: Panel; label: string }[] = [
  { value: "consumption", label: "Consumption" },
  { value: "machines", label: "By machine" },
  { value: "people", label: "By person" },
];

export function Reports(props: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [panel, setPanel] = useState<Panel>("consumption");
  const [preset, setPreset] = useState<Preset>("30d");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-1.5">
        {PANELS.map((option) => (
          <Chip key={option.value} active={panel === option.value} onClick={() => setPanel(option.value)}>
            {option.label}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {PRESETS.map((option) => (
          <Chip
            key={option.value}
            active={preset === option.value}
            onClick={() => setPreset(option.value)}
            size="sm"
          >
            {option.label}
          </Chip>
        ))}
      </div>

      {panel === "consumption" && <Consumption {...props} preset={preset} />}
      {panel === "machines" && <MachinePanel {...props} preset={preset} />}
      {panel === "people" && <PeoplePanel {...props} preset={preset} />}
    </div>
  );
}

function Consumption({
  client,
  onError,
  onNotice,
  preset,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
  preset: Preset;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>("machine");
  const [downloading, setDownloading] = useState(false);

  // A failed report is not an empty report. Until 2026-08-30 this `catch` did
  // `setRows([])`, so a request that timed out drew *"Nothing went out in this
  // period"* — a confident statement about the crib, made by a screen that had
  // just failed to ask. `useLoadable` keeps failure, emptiness and loading
  // apart, and `<Loaded>` draws each differently.
  const state = useLoadable(
    () => client.consumption(groupBy, rangeFor(preset)),
    [client, groupBy, preset],
    onError,
  );
  const rows = state.data;

  const totalQty = (rows ?? []).reduce((sum, r) => sum + Number(r.qty), 0);
  const totalValue = (rows ?? []).reduce((sum, r) => sum + Number(r.value), 0);
  /* §6 leaves `unit_cost` nullable, and plenty of a crib's catalog never gets
     one. Printing ₹0.00 on every row and every total then says "this cost
     nothing", which is not what the ledger knows — it knows nobody priced it.
     Where nothing is priced, the money is left off rather than invented. */
  const priced = totalValue > 0;
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
      <div className="grid grid-cols-3 gap-1.5">
        {GROUPS.map((group) => (
          <Chip
            key={group.value}
            active={groupBy === group.value}
            onClick={() => {
              // `useLoadable` blanks the rows whenever its deps change, so
              // numbers from the previous grouping can never sit under a new
              // heading — the one thing a report must never do.
              setGroupBy(group.value);
            }}
          >
            {group.label}
          </Chip>
        ))}
      </div>

      <Loaded
        state={state}
        label="Adding it up…"
        empty={
          <p className="py-10 text-center text-faint">
            Nothing went out in this period. Only ISSUE and SCRAP count as
            consumption — stock arriving is not.
          </p>
        }
      >
        {(loaded) => loaded.length > 0 && (
        <>
          <div className="rounded-xl bg-surface px-4 py-3">
            <div className="text-xs text-faint">
              Total consumed · {loaded.length} {groupBy === "month" ? "months" : "buckets"}
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-2xl font-bold tabular-nums">
                {totalQty.toLocaleString(undefined, { maximumFractionDigits: 3 })}
              </span>
              {priced && (
                <span className="text-sm text-muted tabular-nums">
                  ₹{totalValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              )}
            </div>
          </div>

          {loaded.map((row) => (
            <div key={row.bucket_key} className="rounded-xl bg-surface px-4 py-3">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {row.bucket_label}
                </span>
                <span className="shrink-0 text-lg font-bold tabular-nums">
                  {Number(row.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                </span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${(Number(row.qty) / biggest) * 100}%` }}
                />
              </div>
              <div className="pt-1 text-xs text-faint tabular-nums">
                {priced
                  ? `₹${Number(row.value).toLocaleString(undefined, { minimumFractionDigits: 2 })} · `
                  : ""}
                {row.txn_count} transaction{row.txn_count === 1 ? "" : "s"}
              </div>
            </div>
          ))}

          <button
            type="button"
            disabled={downloading}
            onClick={download}
            className="tap w-full rounded-xl bg-surface-2 px-4 text-sm text-ink-2 disabled:opacity-40"
          >
            {downloading ? "Preparing…" : "Download CSV"}
          </button>
        </>
        )}
      </Loaded>

      <p className="pb-4 text-xs text-faint">
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


// ── By machine ──────────────────────────────────────────────────────────
//
// `group_by=machine` already gave the totals. The question that follows is the
// one that leads somewhere — *which* tools is CNC-L1 getting through — so each
// machine opens to show exactly that. A machine eating one insert grade and
// nothing else is a setup problem, not a stock problem, and no total can say so.

function MachinePanel({
  client,
  onError,
  preset,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
  preset: Preset;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const state = useLoadable(() => client.machineUsage(rangeFor(preset)), [client, preset], onError);

  return (
    <Loaded
      state={state}
      label="Adding up each machine…"
      empty={
        <p className="py-10 text-center text-faint">
          Nothing was issued to any machine in this period.
        </p>
      }
    >
      {(rows) => {
        const biggest = Math.max(1, ...rows.map((r) => Number(r.qty)));
        const priced = rows.some((r) => Number(r.value) > 0);
        return (
          <div className="space-y-2">
            {rows.map((row) => {
              const key = row.machine_id ?? "none";
              return (
                <div key={key} className="rounded-xl bg-surface px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setOpen(open === key ? null : key)}
                    className="w-full text-left"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {row.machine_code}
                        {row.machine_name && (
                          <span className="pl-2 text-sm font-normal text-muted">
                            {row.machine_name}
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums font-bold">
                        {Number(row.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded bg-surface-2">
                      <div
                        className="h-full bg-accent"
                        style={{ width: `${(Number(row.qty) / biggest) * 100}%` }}
                      />
                    </div>
                    <div className="pt-1 text-xs text-faint">
                      {row.distinct_tools} different tools · {row.movements} movements
                      {priced
                        ? ` · ₹${Number(row.value).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                        : ""}
                      <span className="pl-2 text-faint">
                        {open === key ? "tap to close" : "tap for the tools"}
                      </span>
                    </div>
                  </button>

                  {open === key && <MachineTools client={client} machineId={row.machine_id} preset={preset} onError={onError} />}
                </div>
              );
            })}
            <p className="pb-4 text-xs text-faint">
              Movements booked without a machine are kept and labelled rather than
              dropped — §12.6 makes the machine optional, so a report that ignored
              them would not add up to the consumption report beside it.
            </p>
          </div>
        );
      }}
    </Loaded>
  );
}

function MachineTools({
  client,
  machineId,
  preset,
  onError,
}: {
  client: ReturnType<typeof adminApi>;
  machineId: string | null;
  preset: Preset;
  onError: (m: string) => void;
}) {
  const state = useLoadable(
    () => client.machineTools(machineId, rangeFor(preset)),
    [client, machineId, preset],
    onError,
  );

  return (
    <div className="mt-3 border-t border-line pt-2">
      <Loaded
        state={state}
        label="Which tools…"
        empty={<p className="py-3 text-sm text-faint">Nothing recorded.</p>}
      >
        {(tools) =>
          tools.map((tool) => (
            <div key={tool.item_id} className="flex items-baseline gap-3 py-1">
              <span className="min-w-0 flex-1 truncate text-sm">
                {tool.item_code}
                <span className="pl-2 text-faint">{tool.description}</span>
              </span>
              <span className="shrink-0 text-sm tabular-nums text-ink-2">
                {Number(tool.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
              </span>
            </div>
          ))
        }
      </Loaded>
    </div>
  );
}

// ── By person ───────────────────────────────────────────────────────────
//
// Who signed in, how they proved who they were, and what they took.
//
// The identity split is the point rather than a detail. §8 says a punch, a
// passkey and a typed PIN are not equal evidence, and a column that added them
// up into "sessions" would throw away the distinction the identity design
// exists to keep.

function PeoplePanel({
  client,
  onError,
  preset,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
  preset: Preset;
}) {
  const state = useLoadable(() => client.operatorStats(rangeFor(preset)), [client, preset], onError);

  return (
    <Loaded
      state={state}
      label="Counting sign-ins…"
      empty={<p className="py-10 text-center text-faint">Nobody signed in during this period.</p>}
    >
      {(rows) => {
        const priced = rows.some((r) => Number(r.value) > 0);
        return (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.operator_id} className="rounded-xl bg-surface px-4 py-3">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate font-semibold">
                  {row.full_name}
                  <span className="pl-2 text-sm font-normal text-faint">
                    {row.emp_code} · {row.role.toLowerCase()}
                  </span>
                </span>
                <span className="tabular-nums font-bold">
                  {Number(row.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                </span>
              </div>
              <div className="pt-1 text-xs text-faint">
                {row.sessions} sign-in{row.sessions === 1 ? "" : "s"} · {row.movements} movement
                {row.movements === 1 ? "" : "s"}
                {priced
                  ? ` · ₹${Number(row.value).toLocaleString(undefined, { minimumFractionDigits: 2 })}`
                  : ""}
              </div>
              <div className="flex gap-1 pt-2 text-xs">
                <IdentityChip label="door" n={row.punch_sessions} tone="bg-success-soft text-success" />
                <IdentityChip label="passkey" n={row.passkey_sessions} tone="bg-accent-soft text-accent" />
                <IdentityChip label="typed PIN" n={row.pin_sessions} tone="bg-warning-soft text-warning" />
              </div>
            </div>
          ))}
          <p className="pb-4 text-xs text-faint">
            A punch is the reader deciding whose finger it was. A passkey is a
            registered device unlocked by somebody it trusts. A typed PIN is four
            digits somebody knew. They are not equal evidence (§8), so they are
            not added together.
          </p>
        </div>
        );
      }}
    </Loaded>
  );
}

function IdentityChip({ label, n, tone }: { label: string; n: number; tone: string }) {
  if (n === 0) return null;
  return <span className={`rounded px-2 py-0.5 ${tone}`}>{n} {label}</span>;
}
