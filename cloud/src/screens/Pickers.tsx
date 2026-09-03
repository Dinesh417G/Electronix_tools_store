// The two lists the terminal's optional step is made of (§12.6): machines and
// reason codes.
//
// They are small screens for a reason that is not size. Both are *axes of the
// consumption report* (§11) — "which machine ate the end mills", "how much went
// to breakage" — so editing them is editing the labels on history. The
// transaction count on every row is there to make that visible before somebody
// renames CNC-L1 into something else and wonders why last year's report changed.
//
// Neither list deletes. Retiring drops an entry out of the terminal's pickers
// and leaves every past transaction that cites it readable.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import type { Machine, ReasonCode, adminApi } from "../lib/admin";
import { Banner, Chip, Field, Header, Spinner } from "../components/ui";
import { Row, RowList } from "../components/row";

const input =
  "w-full rounded-xl border border-line bg-surface px-4 py-3 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent/30";

type Client = ReturnType<typeof adminApi>;

export function Machines({
  client,
  onBack,
  onError,
  onNotice,
}: {
  client: Client;
  onBack: () => void;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [rows, setRows] = useState<Machine[] | null>(null);
  const [editing, setEditing] = useState<Machine | "new" | null>(null);

  const load = useCallback(() => {
    client.machines().then(setRows).catch((err) => {
      onError(describe(err));
      setRows([]);
    });
  }, [client, onError]);

  useEffect(load, [load]);

  if (editing) {
    return (
      <MachineForm
        client={client}
        machine={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(message) => {
          setEditing(null);
          onNotice(message);
          load();
        }}
        onError={onError}
      />
    );
  }

  return (
    <div className="space-y-3">
      <Header title="Machines" subtitle="What the terminal offers on the optional step" onBack={onBack} />

      <button
        type="button"
        onClick={() => setEditing("new")}
        className="tap w-full rounded-xl bg-accent px-4 font-semibold text-white"
      >
        Add machine
      </button>

      {!rows && <Spinner label="Loading machines…" />}

      {rows && rows.length > 0 && (
        <RowList>
          {rows.map((machine) => (
            <div key={machine.id} className={machine.active ? undefined : "opacity-60"}>
              <Row
                title={machine.code}
                badge={!machine.active && <span className="text-xs text-faint">retired</span>}
                subtitle={machine.name ?? "—"}
                meta={`${machine.txn_count} transaction${machine.txn_count === 1 ? "" : "s"}`}
                onClick={() => setEditing(machine)}
              />
            </div>
          ))}
        </RowList>
      )}

      {rows?.length === 0 && (
        <p className="py-10 text-center text-faint">
          No machines yet. Consumption-by-machine has nothing to group by until
          there are some.
        </p>
      )}
    </div>
  );
}

function MachineForm({
  client,
  machine,
  onClose,
  onSaved,
  onError,
}: {
  client: Client;
  machine: Machine | null;
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [code, setCode] = useState(machine?.code ?? "");
  const [name, setName] = useState(machine?.name ?? "");
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-4">
      <Header
        title={machine ? machine.code : "Add machine"}
        subtitle={machine ? `${machine.txn_count} transactions` : "New"}
        onBack={onClose}
      />

      {machine && machine.txn_count > 0 && (
        <Banner tone="warn">
          {machine.txn_count} transaction{machine.txn_count === 1 ? "" : "s"} already
          name this machine. Renaming it relabels them in every report.
        </Banner>
      )}

      <Field label="Code" hint="What the operator taps. Short — VMC-01, CNC-L2.">
        <input
          className={input}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoCapitalize="characters"
        />
      </Field>

      <Field label="Description" hint="Optional. The make and model helps a new starter.">
        <input className={input} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <button
        type="button"
        disabled={busy || !code.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            if (machine) {
              await client.updateMachine(machine.id, {
                code,
                name: name || null,
                active: machine.active,
              });
              onSaved(`${code} updated.`);
            } else {
              await client.createMachine({ code, name: name || null });
              onSaved(`${code} added.`);
            }
          } catch (err) {
            onError(describe(err));
          } finally {
            setBusy(false);
          }
        }}
        className="tap w-full rounded-xl bg-accent px-4 font-semibold text-white disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>

      {machine && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (machine.active) {
                await client.deactivateMachine(machine.id);
                onSaved(`${machine.code} retired. Its history is unchanged.`);
              } else {
                await client.updateMachine(machine.id, {
                  code: machine.code,
                  name: machine.name,
                  active: true,
                });
                onSaved(`${machine.code} is back in the picker.`);
              }
            } catch (err) {
              onError(describe(err));
            } finally {
              setBusy(false);
            }
          }}
          className="tap w-full rounded-xl bg-surface-2 px-4 text-sm text-ink-2"
        >
          {machine.active ? "Retire" : "Bring back"}
        </button>
      )}
    </div>
  );
}

// ── Reason codes ──────────────────────────────────────────────────────────

export function ReasonCodes({
  client,
  onBack,
  onError,
  onNotice,
}: {
  client: Client;
  onBack: () => void;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [rows, setRows] = useState<ReasonCode[] | null>(null);
  const [editing, setEditing] = useState<ReasonCode | "new" | null>(null);

  const load = useCallback(() => {
    client.reasonCodes().then(setRows).catch((err) => {
      onError(describe(err));
      setRows([]);
    });
  }, [client, onError]);

  useEffect(load, [load]);

  if (editing) {
    return (
      <ReasonForm
        client={client}
        reason={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={(message) => {
          setEditing(null);
          onNotice(message);
          load();
        }}
        onError={onError}
      />
    );
  }

  const groups = (["ISSUE", "RECEIPT"] as const).map((applies) => ({
    applies,
    rows: (rows ?? []).filter((r) => r.applies_to === applies),
  }));

  return (
    <div className="space-y-3">
      <Header title="Reasons" subtitle="Why stock moved, when anyone says" onBack={onBack} />

      <button
        type="button"
        onClick={() => setEditing("new")}
        className="tap w-full rounded-xl bg-accent px-4 font-semibold text-white"
      >
        Add reason
      </button>

      {!rows && <Spinner label="Loading reasons…" />}

      {rows &&
        groups.map(({ applies, rows: group }) => (
          <section key={applies} className="space-y-2 pt-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
              {applies === "ISSUE" ? "Taking out" : "Putting in"}
            </h2>
            {group.length === 0 && (
              <p className="text-sm text-faint">Nothing here yet.</p>
            )}
            {group.length > 0 && (
              <RowList>
                {group.map((reason) => (
                  <div key={reason.id} className={reason.active ? undefined : "opacity-60"}>
                    <Row
                      title={reason.label}
                      badge={!reason.active && <span className="text-xs text-faint">retired</span>}
                      subtitle={reason.code}
                      meta={`${reason.txn_count} use${reason.txn_count === 1 ? "" : "s"} · position ${reason.sort_order}`}
                      onClick={() => setEditing(reason)}
                    />
                  </div>
                ))}
              </RowList>
            )}
          </section>
        ))}

      <p className="pt-2 text-xs text-faint">
        Reasons are optional at the terminal and always have a SKIP button
        (§12.6). Keep the list short — a long one is slower to skip than to fill,
        and then nobody fills it.
      </p>
    </div>
  );
}

function ReasonForm({
  client,
  reason,
  onClose,
  onSaved,
  onError,
}: {
  client: Client;
  reason: ReasonCode | null;
  onClose: () => void;
  onSaved: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [code, setCode] = useState(reason?.code ?? "");
  const [label, setLabel] = useState(reason?.label ?? "");
  const [appliesTo, setAppliesTo] = useState<"ISSUE" | "RECEIPT">(
    reason?.applies_to ?? "ISSUE",
  );
  const [sortOrder, setSortOrder] = useState(String(reason?.sort_order ?? 100));
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-4">
      <Header
        title={reason ? reason.label : "Add reason"}
        subtitle={reason ? `${reason.txn_count} uses` : "New"}
        onBack={onClose}
      />

      <Field label="Applies to">
        <div className="flex gap-1.5">
          {(["ISSUE", "RECEIPT"] as const).map((value) => (
            <Chip
              key={value}
              active={appliesTo === value}
              onClick={() => setAppliesTo(value)}
              className="flex-1"
            >
              {value === "ISSUE" ? "Taking out" : "Putting in"}
            </Chip>
          ))}
        </div>
      </Field>

      <Field label="Code" hint="CAPS_AND_UNDERSCORES. This is what reports group by.">
        <input
          className={input}
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
        />
      </Field>

      <Field label="Label" hint="What the operator reads on the chip.">
        <input className={input} value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>

      <Field label="Position" hint="Lower comes first. Ten apart leaves room to insert one later.">
        <input
          className={input}
          inputMode="numeric"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, ""))}
        />
      </Field>

      <button
        type="button"
        disabled={busy || !code.trim() || !label.trim()}
        onClick={async () => {
          setBusy(true);
          const body = {
            code,
            label,
            applies_to: appliesTo,
            sort_order: Number(sortOrder || "100"),
          };
          try {
            if (reason) {
              await client.updateReasonCode(reason.id, { ...body, active: reason.active });
              onSaved(`${label} updated.`);
            } else {
              await client.createReasonCode(body);
              onSaved(`${label} added.`);
            }
          } catch (err) {
            onError(describe(err));
          } finally {
            setBusy(false);
          }
        }}
        className="tap w-full rounded-xl bg-accent px-4 font-semibold text-white disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>

      {reason && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (reason.active) {
                await client.deactivateReasonCode(reason.id);
                onSaved(`${reason.label} retired. Past transactions still cite it.`);
              } else {
                await client.updateReasonCode(reason.id, {
                  code: reason.code,
                  label: reason.label,
                  applies_to: reason.applies_to,
                  sort_order: reason.sort_order,
                  active: true,
                });
                onSaved(`${reason.label} is back in the chips.`);
              }
            } catch (err) {
              onError(describe(err));
            } finally {
              setBusy(false);
            }
          }}
          className="tap w-full rounded-xl bg-surface-2 px-4 text-sm text-ink-2"
        >
          {reason.active ? "Retire" : "Bring back"}
        </button>
      )}
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
