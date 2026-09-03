// The people list — §11's `/admin/operators`, on a screen.
//
// This is the only part of the console that mints something an operator signs a
// ledger row with, so it is deliberately plain about consequences:
//
//   * A person is never deleted, only deactivated. Their name stays on every
//     row they ever signed, which is what §7 exists to preserve.
//   * The terminal user id is what a fingerprint at the door resolves to (§9).
//     Somebody with no id can still work — through a PIN or a passkey — but
//     their sessions are flagged `manual_identity`, which is weaker evidence
//     and shows differently in reports (§8, §10).
//   * The last active ADMIN cannot be removed or demoted. The server refuses it
//     and this screen says why before you try.

import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import type { Operator, OperatorInput, Role, adminApi } from "../lib/admin";
import { Banner, Chip, Field, Header, Spinner } from "../components/ui";
import { Row, RowList } from "../components/row";

const ROLES: { value: Role; label: string; blurb: string }[] = [
  { value: "OPERATOR", label: "Operator", blurb: "Takes tools out and puts them back." },
  {
    value: "STOREKEEPER",
    label: "Storekeeper",
    blurb: "Also books stock in, edits the catalog and prints labels.",
  },
  { value: "ADMIN", label: "Admin", blurb: "Also manages people, machines and the door." },
];

const input =
  "w-full rounded-xl border border-line bg-surface px-4 py-3 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent/30";

export function People({
  client,
  onBack,
  onError,
  onNotice,
}: {
  client: ReturnType<typeof adminApi>;
  onBack: () => void;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [rows, setRows] = useState<Operator[] | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [editing, setEditing] = useState<Operator | "new" | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    client
      .operators(showRetired)
      .then((list) => {
        setForbidden(false);
        setRows(list);
      })
      .catch((err) => {
        // A storekeeper reaching this tab is not an error worth a red banner —
        // it is an answer. An empty list would read as "nobody works here".
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
          setRows([]);
          return;
        }
        onError(describe(err));
        setRows([]);
      });
  }, [client, showRetired, onError]);

  useEffect(load, [load]);

  if (editing) {
    return (
      <OperatorForm
        client={client}
        operator={editing === "new" ? null : editing}
        activeAdmins={(rows ?? []).filter((o) => o.active && o.role === "ADMIN").length}
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

  if (forbidden) {
    return (
      <div className="space-y-3">
        <Header title="People" onBack={onBack} />
        <Banner tone="info">
          Managing people needs an admin login. A storekeeper can do everything
          else on this console.
        </Banner>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Header
        title="People"
        subtitle="Operators, storekeepers and admins"
        onBack={onBack}
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setEditing("new")}
          className="tap flex-1 rounded-xl bg-accent px-4 font-semibold text-white"
        >
          Add person
        </button>
        <Chip
          active={showRetired}
          onClick={() => {
            // Clearing here rather than inside the effect: the spinner belongs
            // to the tap that caused it, and React would rather not have a
            // state update run synchronously inside an effect body.
            setRows(null);
            setShowRetired((v) => !v);
          }}
        >
          {showRetired ? "Hiding none" : "Show inactive"}
        </Chip>
      </div>

      {!rows && <Spinner label="Loading people…" />}

      {rows && rows.length > 0 && (
        <RowList>
          {rows.map((person) => (
            <div key={person.id} className={person.active ? undefined : "opacity-60"}>
              <Row
                title={person.full_name}
                badge={
                  <>
                    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">
                      {person.role}
                    </span>
                    {!person.active && (
                      <span className="shrink-0 text-xs text-faint">inactive</span>
                    )}
                  </>
                }
                subtitle={
                  person.emp_code + (person.department ? ` · ${person.department}` : "")
                }
                meta={
                  (person.zk_user_id ? `door id ${person.zk_user_id}` : "no door id") +
                  (person.has_pin ? " · PIN" : " · no PIN") +
                  (person.passkey_count > 0
                    ? ` · fingerprint on ${person.passkey_count} device${person.passkey_count === 1 ? "" : "s"}`
                    : "")
                }
                onClick={() => setEditing(person)}
              />
            </div>
          ))}
        </RowList>
      )}

      {rows?.length === 0 && !forbidden && (
        <p className="py-10 text-center text-faint">Nobody here yet.</p>
      )}
    </div>
  );
}

function OperatorForm({
  client,
  operator,
  activeAdmins,
  onClose,
  onSaved,
  onError,
}: {
  client: ReturnType<typeof adminApi>;
  operator: Operator | null;
  activeAdmins: number;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState<OperatorInput>({
    emp_code: operator?.emp_code ?? "",
    full_name: operator?.full_name ?? "",
    role: operator?.role ?? "OPERATOR",
    zk_user_id: operator?.zk_user_id ?? null,
    department: operator?.department ?? null,
  });
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);

  // The guard the server enforces, said out loud before the button is pressed.
  const lastAdmin = operator?.active === true && operator.role === "ADMIN" && activeAdmins <= 1;

  const set = <K extends keyof OperatorInput>(key: K, value: OperatorInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    setBusy(true);
    try {
      if (operator) {
        await client.updateOperator(operator.id, {
          ...form,
          // An empty box means "leave the PIN alone", not "clear it". Clearing
          // is its own button, because locking somebody out by leaving a field
          // blank is not a mistake worth making possible.
          ...(pin ? { pin } : {}),
        });
        onSaved(`${form.full_name} updated.`);
      } else {
        await client.createOperator({ ...form, pin: pin || null });
        onSaved(`${form.full_name} added.`);
      }
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Header
        title={operator ? form.full_name || "Person" : "Add person"}
        subtitle={operator ? operator.emp_code : "New"}
        onBack={onClose}
      />

      {lastAdmin && (
        <Banner tone="info">
          This is the only active admin. The server will refuse to deactivate or
          demote them — promote somebody else first, or nobody can manage the
          store.
        </Banner>
      )}

      <Field label="Employee code" hint="What they type at a PIN login.">
        <input
          className={input}
          value={form.emp_code}
          onChange={(e) => set("emp_code", e.target.value)}
          autoCapitalize="characters"
        />
      </Field>

      <Field label="Full name">
        <input
          className={input}
          value={form.full_name}
          onChange={(e) => set("full_name", e.target.value)}
        />
      </Field>

      <Field label="Role">
        <div className="space-y-2">
          {ROLES.map((role) => (
            <button
              key={role.value}
              type="button"
              onClick={() => set("role", role.value)}
              className={`tap block w-full rounded-xl border px-4 py-3 text-left ${
                form.role === role.value
                  ? "border-accent-line bg-accent-soft"
                  : "border-line bg-surface"
              }`}
            >
              <div className="font-semibold">{role.label}</div>
              <div
                className={`text-xs ${
                  form.role === role.value ? "text-accent" : "text-muted"
                }`}
              >
                {role.blurb}
              </div>
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Terminal user id"
        hint="The id programmed into the door reader, where their fingerprint is enrolled. The reader keeps the fingerprint itself; this is only how a punch finds them. Without it, a punch cannot."
      >
        <input
          className={input}
          inputMode="numeric"
          value={form.zk_user_id ?? ""}
          onChange={(e) => set("zk_user_id", e.target.value || null)}
        />
      </Field>

      <Field label="Department" hint="Optional.">
        <input
          className={input}
          value={form.department ?? ""}
          onChange={(e) => set("department", e.target.value || null)}
        />
      </Field>

      <Field
        label={operator?.has_pin ? "New PIN" : "PIN"}
        hint={
          operator?.has_pin
            ? "Leave blank to keep the current one. 4 to 8 digits."
            : "Optional. 4 to 8 digits — the fallback when the door push does not arrive."
        }
      >
        <input
          className={input}
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder={operator?.has_pin ? "••••" : ""}
        />
      </Field>

      {/* Asked on the first day the console was used: "while adding a user I
          have no option for adding a fingerprint". There cannot be one. A
          phone's fingerprint unlocks a credential bound to that phone, so it
          has to be registered on the person's own device, by them, after they
          have proved who they are some other way. The door reader's fingerprint
          is not ours at all — the terminal captures and matches it, and all we
          keep is the id above. Saying so here is cheaper than the question. */}
      <div className="rounded-xl bg-surface px-4 py-3 text-sm text-muted">
        <div className="font-semibold text-ink-2">Fingerprint sign-in</div>
        <p className="pt-1">
          {operator
            ? operator.passkey_count > 0
              ? `Registered on ${operator.passkey_count} device${
                  operator.passkey_count === 1 ? "" : "s"
                }.`
              : "Not set up on any device yet."
            : "Set up after this person exists."}
        </p>
        <p className="pt-2">
          It cannot be added from here: a fingerprint unlocks a key held by one
          phone, so {operator ? "they" : "the person"} must register it on{" "}
          {operator ? "their" : "their"} own phone. Give them their employee code
          and PIN, have them sign in at <strong>Admin</strong>, and the first
          screen they see is where they add it.
        </p>
      </div>

      <button
        type="button"
        disabled={busy || !form.emp_code.trim() || !form.full_name.trim()}
        onClick={save}
        className="tap w-full rounded-xl bg-accent px-4 font-semibold text-white disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>

      {operator && operator.active && (
        <button
          type="button"
          disabled={busy || lastAdmin}
          onClick={async () => {
            setBusy(true);
            try {
              await client.deactivateOperator(operator.id);
              onSaved(`${operator.full_name} deactivated. Their history is unchanged.`);
            } catch (err) {
              onError(describe(err));
            } finally {
              setBusy(false);
            }
          }}
          className="tap w-full rounded-xl bg-surface-2 px-4 text-sm text-danger disabled:opacity-40"
        >
          Deactivate
        </button>
      )}

      {operator && !operator.active && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await client.updateOperator(operator.id, { active: true });
              onSaved(`${operator.full_name} is active again.`);
            } catch (err) {
              onError(describe(err));
            } finally {
              setBusy(false);
            }
          }}
          className="tap w-full rounded-xl bg-surface-2 px-4 text-sm text-ink-2"
        >
          Reactivate
        </button>
      )}

      {operator?.has_pin && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await client.updateOperator(operator.id, { pin: null });
              onSaved(`${operator.full_name}'s PIN is cleared.`);
            } catch (err) {
              onError(describe(err));
            } finally {
              setBusy(false);
            }
          }}
          className="tap w-full rounded-xl bg-surface-2 px-4 text-sm text-muted"
        >
          Clear PIN
        </button>
      )}

      <p className="pb-4 text-xs text-faint">
        Deactivating never deletes. Every transaction they signed keeps their
        name on it — that is what makes the ledger worth having.
      </p>
    </div>
  );
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
