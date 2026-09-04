// Setup — people, machines, reason codes, and the door (CLAUDE.md §11).
//
// These endpoints existed on this server before anything could call them. §11
// names dead wiring as this project's known failure mode — "built at both ends,
// never connected" — and this side of the workspace was carrying it: the
// catalog, stock, alerts and ledger had screens, and the four things a
// storekeeper changes on a Tuesday did not. `store-cli` was the only way to add
// a person, which needs a Rust toolchain and the database password.
//
// Two rules run through everything here, and both come from §7 rather than from
// taste:
//
//   * **Retire, never delete.** `stock_ledger` points at every operator,
//     machine and reason code. §7's claim is that the history still answers
//     "who took the forty inserts, on which machine, and why" years later, and
//     that survives exactly as long as those rows do. So every "remove" is
//     `active = false`, and a retired row keeps its place in the list rather
//     than vanishing from it.
//
//   * **The last active ADMIN cannot leave through this screen.** The server
//     refuses it inside the transaction that made the change; this screen's job
//     is to say so in words rather than showing a bare 409.
//
// What is *not* here, deliberately: a fingerprint field on the person form.
// §8 — the door's template belongs to the terminal, which captures and matches
// it; all we store is the mapping in `operators.zk_user_id`. Enrolling a finger
// is done at the terminal's own keypad by a storekeeper. The form says so,
// because it is the first thing every user asks for.

import { useCallback, useEffect, useState } from "react";
import type {
  DoorView,
  MachineRow,
  Operator,
  ReasonRow,
  adminApi,
} from "../lib/admin";
import { Banner, BigButton, Spinner } from "../components/ui";

type Client = ReturnType<typeof adminApi>;
type Section = "people" | "machines" | "reasons" | "door";

interface Props {
  client: Client;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

const describe = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function Setup({ client, onError, onNotice }: Props) {
  const [section, setSection] = useState<Section | null>(null);

  if (section === null) {
    return (
      <div className="space-y-2">
        {(
          [
            ["people", "People", "Who may sign in, and their PINs"],
            ["machines", "Machines", "The picker on the optional step"],
            ["reasons", "Reasons", "Why stock moved"],
            ["door", "Door", "The reader, and punches with no name"],
          ] as const
        ).map(([key, label, hint]) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            className="block w-full rounded-xl bg-slate-800 px-4 py-3 text-left"
          >
            <div className="font-semibold text-slate-100">{label}</div>
            <div className="text-sm text-slate-400">{hint}</div>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setSection(null)}
        className="rounded-lg px-2 py-1 text-sm text-slate-400"
      >
        ← Setup
      </button>
      {section === "people" && (
        <People client={client} onError={onError} onNotice={onNotice} />
      )}
      {section === "machines" && (
        <Machines client={client} onError={onError} onNotice={onNotice} />
      )}
      {section === "reasons" && (
        <Reasons client={client} onError={onError} onNotice={onNotice} />
      )}
      {section === "door" && <Door client={client} onError={onError} />}
    </div>
  );
}

/**
 * Load something once, with the three states kept apart.
 *
 * Emptiness and failure are different things: a screen that draws "nothing
 * here" from a request that failed tells the storekeeper the crib has no
 * machines, which is a confident statement about the shop made out of a
 * timeout.
 */
function useList<T>(load: () => Promise<T[]>, onError: (m: string) => void) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    try {
      setFailed(false);
      setRows(await load());
    } catch (err) {
      setFailed(true);
      onError(describe(err));
    }
    // `load` is rebuilt on every render by its caller; keying on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, failed, reload };
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg bg-slate-800 px-3 py-2 text-slate-100 placeholder:text-slate-500"
      />
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

/** A retired row stays on the list, greyed, with the way back on it. */
function RetiredPill() {
  return (
    <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide text-slate-300 uppercase">
      Retired
    </span>
  );
}

// ── People ─────────────────────────────────────────────────────────────────

function People({ client, onError, onNotice }: Props) {
  const { rows, failed, reload } = useList<Operator>(
    () => client.operators(),
    onError,
  );
  const [adding, setAdding] = useState(false);
  const [empCode, setEmpCode] = useState("");
  const [fullName, setFullName] = useState("");
  const [zkUserId, setZkUserId] = useState("");
  const [department, setDepartment] = useState("");
  const [role, setRole] = useState("OPERATOR");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      await client.createOperator({
        emp_code: empCode.trim(),
        full_name: fullName.trim(),
        zk_user_id: zkUserId.trim() || null,
        department: department.trim() || null,
        role,
        pin: pin.trim() || null,
      });
      onNotice(`${fullName.trim()} added.`);
      setAdding(false);
      setEmpCode("");
      setFullName("");
      setZkUserId("");
      setDepartment("");
      setPin("");
      setRole("OPERATOR");
      await reload();
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (operator: Operator, active: boolean) => {
    try {
      if (active) await client.patchOperator(operator.id, { active: true });
      else await client.deactivateOperator(operator.id);
      onNotice(`${operator.full_name} ${active ? "restored" : "retired"}.`);
      await reload();
    } catch (err) {
      // The server refuses the last active ADMIN inside the transaction that
      // made the change, so this is the only place the reason reaches a person.
      onError(describe(err));
    }
  };

  const setRoleOf = async (operator: Operator, next: string) => {
    try {
      await client.patchOperator(operator.id, { role: next });
      onNotice(`${operator.full_name} is now ${next}.`);
      await reload();
    } catch (err) {
      onError(describe(err));
    }
  };

  const setPinOf = async (operator: Operator) => {
    const entered = window.prompt(
      `New PIN for ${operator.full_name}. Leave empty to clear it.`,
    );
    if (entered === null) return;
    try {
      await client.patchOperator(operator.id, { pin: entered.trim() || null });
      onNotice(entered.trim() ? "PIN set." : "PIN cleared.");
      await reload();
    } catch (err) {
      onError(describe(err));
    }
  };

  if (failed) return <Banner tone="error">The people list did not load.</Banner>;
  if (rows === null) return <Spinner label="Loading people…" />;

  return (
    <div className="space-y-3">
      {adding ? (
        <div className="space-y-3 rounded-xl bg-slate-800/50 p-3">
          <Field label="Employee code" value={empCode} onChange={setEmpCode} placeholder="E1042" />
          <Field label="Full name" value={fullName} onChange={setFullName} placeholder="R. Kumar" />
          <Field
            label="Terminal user id"
            value={zkUserId}
            onChange={setZkUserId}
            placeholder="1042"
            hint="The PIN number programmed into the door reader, if there is one. Not a fingerprint — the reader captures and matches that itself, and it never leaves the device (§8). Enrol the finger at the terminal's own keypad."
          />
          <Field label="Department" value={department} onChange={setDepartment} placeholder="Turning" />
          <label className="block">
            <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
              Role
            </span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="mt-1 w-full rounded-lg bg-slate-800 px-3 py-2 text-slate-100"
            >
              <option value="OPERATOR">Operator</option>
              <option value="STOREKEEPER">Storekeeper</option>
              <option value="ADMIN">Admin</option>
            </select>
          </label>
          <Field
            label="PIN"
            value={pin}
            onChange={setPin}
            placeholder="4 digits"
            hint="Only for the manual fallback when the door has not spoken (§10). Leave empty for somebody who signs in at the reader alone."
          />
          <div className="flex gap-2">
            <BigButton onClick={() => setAdding(false)} variant="ghost" className="flex-1">
              Cancel
            </BigButton>
            <BigButton
              onClick={() => void create()}
              className="flex-1"
              disabled={busy || !empCode.trim() || !fullName.trim()}
            >
              Add
            </BigButton>
          </div>
        </div>
      ) : (
        <BigButton onClick={() => setAdding(true)} className="w-full">
          Add a person
        </BigButton>
      )}

      <div className="divide-y divide-slate-800 rounded-xl bg-slate-800/30">
        {rows.map((operator) => (
          <div key={operator.id} className={`p-3 ${operator.active ? "" : "opacity-60"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-slate-100">{operator.full_name}</span>
              {!operator.active && <RetiredPill />}
            </div>
            <div className="text-sm text-slate-400">
              {operator.emp_code}
              {operator.department ? ` · ${operator.department}` : ""}
              {operator.zk_user_id ? ` · reader ${operator.zk_user_id}` : ""}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                value={operator.role}
                onChange={(e) => void setRoleOf(operator, e.target.value)}
                className="rounded-lg bg-slate-800 px-2 py-1 text-sm text-slate-200"
              >
                <option value="OPERATOR">Operator</option>
                <option value="STOREKEEPER">Storekeeper</option>
                <option value="ADMIN">Admin</option>
              </select>
              <button
                type="button"
                onClick={() => void setPinOf(operator)}
                className="rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-200"
              >
                PIN
              </button>
              <button
                type="button"
                onClick={() => void setActive(operator, !operator.active)}
                className="rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-200"
              >
                {operator.active ? "Retire" : "Restore"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Machines and reason codes ──────────────────────────────────────────────

function Machines({ client, onError, onNotice }: Props) {
  const { rows, failed, reload } = useList<MachineRow>(
    () => client.machines(),
    onError,
  );
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const add = async () => {
    try {
      await client.createMachine({ code: code.trim(), name: name.trim() || null });
      onNotice(`${code.trim()} added.`);
      setCode("");
      setName("");
      await reload();
    } catch (err) {
      // A duplicate code usually means a retired machine of that name already
      // exists; the server's message says to bring it back rather than making
      // a second one, and the history is the reason.
      onError(describe(err));
    }
  };

  const setActive = async (machine: MachineRow, active: boolean) => {
    try {
      if (active) {
        await client.updateMachine(machine.id, {
          code: machine.code,
          name: machine.name,
          active: true,
        });
      } else {
        await client.deactivateMachine(machine.id);
      }
      await reload();
    } catch (err) {
      onError(describe(err));
    }
  };

  if (failed) return <Banner tone="error">The machine list did not load.</Banner>;
  if (rows === null) return <Spinner label="Loading machines…" />;

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl bg-slate-800/50 p-3">
        <Field label="Code" value={code} onChange={setCode} placeholder="CNC-L1" />
        <Field label="Name" value={name} onChange={setName} placeholder="Lathe 1" />
        <BigButton onClick={() => void add()} className="w-full" disabled={!code.trim()}>
          Add machine
        </BigButton>
      </div>

      <div className="divide-y divide-slate-800 rounded-xl bg-slate-800/30">
        {rows.map((machine) => (
          <div key={machine.id} className={`p-3 ${machine.active ? "" : "opacity-60"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-slate-100">{machine.code}</span>
              {!machine.active && <RetiredPill />}
            </div>
            <div className="text-sm text-slate-400">
              {machine.name ?? "—"}
              {/* What makes a rename safe or damaging: this machine is the
                  label on that many past movements. */}
              {machine.txn_count > 0 && ` · ${machine.txn_count} movements`}
            </div>
            <button
              type="button"
              onClick={() => void setActive(machine, !machine.active)}
              className="mt-2 rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-200"
            >
              {machine.active ? "Retire" : "Restore"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Reasons({ client, onError, onNotice }: Props) {
  const { rows, failed, reload } = useList<ReasonRow>(
    () => client.reasonCodes(),
    onError,
  );
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [appliesTo, setAppliesTo] = useState("ISSUE");

  const add = async () => {
    try {
      await client.createReason({
        code: code.trim(),
        label: label.trim(),
        applies_to: appliesTo,
      });
      onNotice(`${label.trim()} added.`);
      setCode("");
      setLabel("");
      await reload();
    } catch (err) {
      onError(describe(err));
    }
  };

  const setActive = async (reason: ReasonRow, active: boolean) => {
    try {
      if (active) {
        await client.updateReason(reason.id, {
          code: reason.code,
          label: reason.label,
          applies_to: reason.applies_to,
          sort_order: reason.sort_order,
          active: true,
        });
      } else {
        await client.deactivateReason(reason.id);
      }
      await reload();
    } catch (err) {
      onError(describe(err));
    }
  };

  if (failed) return <Banner tone="error">The reason list did not load.</Banner>;
  if (rows === null) return <Spinner label="Loading reasons…" />;

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl bg-slate-800/50 p-3">
        <Field label="Code" value={code} onChange={setCode} placeholder="BREAKAGE" />
        <Field label="Label" value={label} onChange={setLabel} placeholder="Broke in the cut" />
        <label className="block">
          <span className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Applies to
          </span>
          <select
            value={appliesTo}
            onChange={(e) => setAppliesTo(e.target.value)}
            className="mt-1 w-full rounded-lg bg-slate-800 px-3 py-2 text-slate-100"
          >
            <option value="ISSUE">Taking out</option>
            <option value="RECEIPT">Putting in</option>
          </select>
        </label>
        <BigButton
          onClick={() => void add()}
          className="w-full"
          disabled={!code.trim() || !label.trim()}
        >
          Add reason
        </BigButton>
      </div>

      <div className="divide-y divide-slate-800 rounded-xl bg-slate-800/30">
        {rows.map((reason) => (
          <div key={reason.id} className={`p-3 ${reason.active ? "" : "opacity-60"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-slate-100">{reason.label}</span>
              {!reason.active && <RetiredPill />}
            </div>
            <div className="text-sm text-slate-400">
              {reason.code} · {reason.applies_to === "ISSUE" ? "taking out" : "putting in"}
              {reason.txn_count > 0 && ` · ${reason.txn_count} movements`}
            </div>
            <button
              type="button"
              onClick={() => void setActive(reason, !reason.active)}
              className="mt-2 rounded-lg bg-slate-800 px-3 py-1 text-sm text-slate-200"
            >
              {reason.active ? "Retire" : "Restore"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Door ───────────────────────────────────────────────────────────────────

/**
 * The reader, and the punches it sent that map to nobody.
 *
 * §9.4: a punch whose `zk_user_id` matches no operator is still recorded and
 * raised as an admin notice, because dropping data for an incomplete master is
 * how a crib ends up with a hole in its history. This is where that notice is
 * read, and the remedy is on the People screen: put that id in somebody's
 * "terminal user id".
 *
 * §9.3 is why every time here is `received_at`. A device clock on Wi-Fi can
 * drift off +05:30 silently, so `device_ts` is diagnostic only and never the
 * clock a person is shown.
 */
function Door({ client, onError }: { client: Client; onError: (m: string) => void }) {
  const [view, setView] = useState<DoorView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .door()
      .then((v) => {
        if (!cancelled) setView(v);
      })
      .catch((err) => {
        if (cancelled) return;
        setFailed(true);
        onError(describe(err));
      });
    return () => {
      cancelled = true;
    };
  }, [client, onError]);

  if (failed) {
    return (
      <Banner tone="error">
        The door screen could not ask the server. This says nothing about the
        reader.
      </Banner>
    );
  }
  if (view === null) return <Spinner label="Asking about the door…" />;

  const when = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
          Readers
        </h3>
        {view.devices.length === 0 ? (
          <p className="text-sm text-slate-400">
            No reader has ever checked in. That is a configuration, not a fault —
            a crib can run on the tablet alone, and the terminal offers manual
            sign-in for it (§3).
          </p>
        ) : (
          <div className="divide-y divide-slate-800 rounded-xl bg-slate-800/30">
            {view.devices.map((device) => (
              <div key={device.id} className="p-3">
                <div className="font-semibold text-slate-100">
                  {device.name ?? device.serial_no}
                </div>
                <div className="text-sm text-slate-400">
                  {device.serial_no}
                  {device.location ? ` · ${device.location}` : ""}
                  {device.firmware ? ` · ${device.firmware}` : ""}
                </div>
                <div className="text-sm text-slate-400">
                  {device.last_seen_at
                    ? `Last seen ${when(device.last_seen_at)}`
                    : "Never seen"}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {view.unknown_users.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
            Punches with no name (§9.4)
          </h3>
          <p className="text-sm text-slate-400">
            The reader accepted these fingers and we cannot say whose they are.
            Put the id into that person&apos;s <em>terminal user id</em> on the
            People screen.
          </p>
          <div className="divide-y divide-slate-800 rounded-xl bg-slate-800/30">
            {view.unknown_users.map((punch) => (
              <div key={punch.punch_id} className="p-3">
                <div className="font-semibold text-slate-100">{punch.zk_user_id}</div>
                <div className="text-sm text-slate-400">
                  {punch.device_serial} · {punch.occurrences}×· last {when(punch.received_at)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
          Recent punches
        </h3>
        {view.recent_punches.length === 0 ? (
          <p className="text-sm text-slate-400">Nothing has come from the door yet.</p>
        ) : (
          <div className="divide-y divide-slate-800 rounded-xl bg-slate-800/30">
            {view.recent_punches.map((punch) => (
              <div key={punch.id} className="flex items-baseline gap-3 p-3">
                {/* §9.3: what the server observed, never what the device
                    claimed — a drifting clock must not be shown as fact. */}
                <span className="w-32 shrink-0 text-sm tabular-nums text-slate-400">
                  {when(punch.received_at)}
                </span>
                <span className="flex-1 font-semibold text-slate-100">
                  {punch.zk_user_id}
                </span>
                <span className="text-sm text-slate-400">
                  {punch.claimed ? "claimed" : "unclaimed"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
