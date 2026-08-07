// The admin console — CLAUDE.md §13 M7.
//
// §2 originally put this in a Tauri desktop app on the server PC. It lives here
// for the same reason the terminal does: it runs at the address the server is
// already on, needs no install, and rides the one OTA channel that already
// exists. A desktop shell can wrap this same UI later without the API changing.
//
// Everything here is catalog and policy. **Nothing on this screen moves stock**
// — that only happens through the ledger (§7), and the one place this comes
// close is reversing a transaction, which appends a correcting row rather than
// editing anything.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  api,
  formatQty,
  type AlertRow,
  type Item,
  type LedgerRow,
} from "../lib/api";
import { adminApi, type Category, type ItemInput } from "../lib/admin";
import { AlertChip, Banner, BigButton, Header, Spinner } from "../components/ui";

type Tab = "catalog" | "stock" | "alerts" | "activity";

interface Props {
  token: string;
  operatorName: string;
  onSignOut: () => void;
}

export function Admin({ token, operatorName, onSignOut }: Props) {
  const [tab, setTab] = useState<Tab>("catalog");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const client = useMemo(() => adminApi(token), [token]);

  return (
    <div className="flex min-h-full flex-col safe-top safe-bottom">
      <Header
        title="Admin"
        subtitle={operatorName}
        right={
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-lg px-3 py-2 text-sm text-slate-400 active:bg-slate-800"
          >
            Sign out
          </button>
        }
      />

      {error && (
        <div className="px-4 pb-2">
          <Banner tone="error" onDismiss={() => setError(null)}>
            {error}
          </Banner>
        </div>
      )}
      {notice && (
        <div className="px-4 pb-2">
          <Banner tone="success" onDismiss={() => setNotice(null)}>
            {notice}
          </Banner>
        </div>
      )}

      <nav className="flex gap-1 px-4 pb-3">
        {(
          [
            ["catalog", "Catalog"],
            ["stock", "Stock"],
            ["alerts", "Alerts"],
            ["activity", "Ledger"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 rounded-xl px-2 py-2.5 text-sm font-semibold ${
              tab === key ? "bg-sky-600 text-white" : "bg-slate-800 text-slate-300"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {tab === "catalog" && (
          <Catalog client={client} onError={setError} onNotice={setNotice} />
        )}
        {tab === "stock" && <StockTab />}
        {tab === "alerts" && <AlertsTab client={client} onError={setError} />}
        {tab === "activity" && (
          <ActivityTab client={client} onError={setError} onNotice={setNotice} />
        )}
      </div>
    </div>
  );
}

// ── Catalog ─────────────────────────────────────────────────────────────

function Catalog({
  client,
  onError,
  onNotice,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(query.trim().length >= 2 ? await api.search(query) : await api.stock("limit=200"));
    } catch (err) {
      onError(describe(err));
    } finally {
      setLoading(false);
    }
  }, [query, onError]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    void client.categories().then(setCategories).catch(() => setCategories([]));
  }, [client]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const printSelected = async () => {
    try {
      // The PDF is opened rather than downloaded silently: on the server PC the
      // storekeeper wants the print dialogue, not a file in Downloads.
      const blob = await client.printLabels([...selected]);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoked late: revoking immediately races the new tab's load.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      onNotice(`${selected.size} label${selected.size === 1 ? "" : "s"} sent to the printer.`);
      setSelected(new Set());
    } catch (err) {
      onError(describe(err));
    }
  };

  if (editing) {
    return (
      <ItemForm
        item={editing === "new" ? null : editing}
        categories={categories}
        client={client}
        onDone={(message) => {
          setEditing(null);
          if (message) onNotice(message);
          void load();
        }}
        onError={onError}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the catalog"
          className="tap flex-1 rounded-xl bg-slate-800 px-4 outline-none placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500"
        />
        <BigButton onClick={() => setEditing("new")} variant="primary" className="px-5 text-base">
          + Item
        </BigButton>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-sky-950 px-4 py-3">
          <span className="flex-1 text-sm">
            {selected.size} selected for label printing
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-400"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void printSelected()}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-semibold"
          >
            Print labels
          </button>
        </div>
      )}

      {loading && items.length === 0 && <Spinner label="Loading catalog…" />}

      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-3 rounded-xl bg-slate-900 px-3 py-3"
        >
          <button
            type="button"
            aria-label={`Select ${item.item_code}`}
            onClick={() => toggle(item.id)}
            className={`h-8 w-8 shrink-0 rounded-lg border-2 text-sm ${
              selected.has(item.id)
                ? "border-sky-500 bg-sky-600 text-white"
                : "border-slate-600"
            }`}
          >
            {selected.has(item.id) ? "✓" : ""}
          </button>

          <button
            type="button"
            onClick={() => setEditing(item)}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{item.item_code}</span>
              <AlertChip level={item.alert_state} />
              {!item.active && (
                <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs">retired</span>
              )}
            </div>
            <div className="truncate text-sm text-slate-400">{item.description}</div>
            <div className="text-xs text-slate-500">
              {item.bin_location ? `Bin ${item.bin_location} · ` : ""}
              {formatQty(item.on_hand)} {item.uom} on hand
            </div>
          </button>
        </div>
      ))}

      {!loading && items.length === 0 && (
        <p className="py-10 text-center text-slate-500">Nothing matches.</p>
      )}
    </div>
  );
}

const UOMS = ["NOS", "SET", "BOX", "LTR", "KG"] as const;

function ItemForm({
  item,
  categories,
  client,
  onDone,
  onError,
}: {
  item: Item | null;
  categories: Category[];
  client: ReturnType<typeof adminApi>;
  onDone: (message?: string) => void;
  onError: (m: string) => void;
}) {
  const [form, setForm] = useState<ItemInput>(() => ({
    item_code: item?.item_code ?? "",
    description: item?.description ?? "",
    category_id: item?.category_id ?? null,
    uom: item?.uom ?? "NOS",
    iso_code: item?.iso_code ?? null,
    grade: item?.grade ?? null,
    manufacturer: item?.manufacturer ?? null,
    mfr_part_no: item?.mfr_part_no ?? null,
    diameter_mm: null,
    flutes: null,
    reorder_level: item?.reorder_level ?? "0",
    reorder_qty: item?.reorder_qty ?? null,
    bin_location: item?.bin_location ?? null,
    unit_cost: item?.unit_cost ?? null,
    allow_negative: item?.allow_negative ?? false,
  }));
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof ItemInput>(key: K, value: ItemInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setBusy(true);
    try {
      if (item) {
        await client.updateItem(item.id, form);
        onDone(`${form.item_code} updated.`);
      } else {
        await client.createItem(form);
        onDone(`${form.item_code} created. Print its label from the catalog list.`);
      }
    } catch (err) {
      onError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDone()}
          className="tap -ml-2 w-12 rounded-xl text-2xl text-slate-400 active:bg-slate-800"
        >
          ←
        </button>
        <h2 className="text-lg font-bold">{item ? item.item_code : "New item"}</h2>
      </div>

      <Field label="ITEM CODE" hint="Also the barcode payload — keep it short enough to print">
        <input
          value={form.item_code}
          onChange={(e) => set("item_code", e.target.value.toUpperCase())}
          className={inputClass}
        />
      </Field>

      <Field label="DESCRIPTION">
        <input
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="UOM">
          <select
            value={form.uom}
            onChange={(e) => set("uom", e.target.value)}
            className={inputClass}
          >
            {UOMS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </Field>

        <Field label="BIN">
          <input
            value={form.bin_location ?? ""}
            onChange={(e) => set("bin_location", e.target.value || null)}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="CATEGORY">
        <select
          value={form.category_id ?? ""}
          onChange={(e) => set("category_id", e.target.value || null)}
          className={inputClass}
        >
          <option value="">(none)</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="ISO CODE">
          <input
            value={form.iso_code ?? ""}
            onChange={(e) => set("iso_code", e.target.value || null)}
            className={inputClass}
          />
        </Field>
        <Field label="GRADE">
          <input
            value={form.grade ?? ""}
            onChange={(e) => set("grade", e.target.value || null)}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="REORDER LEVEL" hint="0 disables the LOW alert">
          <input
            inputMode="decimal"
            value={form.reorder_level}
            onChange={(e) => set("reorder_level", e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="REORDER QTY">
          <input
            inputMode="decimal"
            value={form.reorder_qty ?? ""}
            onChange={(e) => set("reorder_qty", e.target.value || null)}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="UNIT COST">
        <input
          inputMode="decimal"
          value={form.unit_cost ?? ""}
          onChange={(e) => set("unit_cost", e.target.value || null)}
          className={inputClass}
        />
      </Field>

      <label className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
        <input
          type="checkbox"
          checked={form.allow_negative}
          onChange={(e) => set("allow_negative", e.target.checked)}
          className="h-5 w-5"
        />
        <span className="flex-1 text-sm">
          Allow negative stock
          <span className="block text-xs text-slate-500">
            Lets an issue go below zero. Reserve this for items the shop consumes
            faster than it books.
          </span>
        </span>
      </label>

      <BigButton
        onClick={save}
        variant="primary"
        className="w-full"
        disabled={busy || !form.item_code.trim() || !form.description.trim()}
      >
        {busy ? "Saving…" : item ? "Save changes" : "Create item"}
      </BigButton>

      {item && (
        <button
          type="button"
          onClick={async () => {
            try {
              await client.deactivateItem(item.id);
              onDone(`${item.item_code} retired. Its history is untouched.`);
            } catch (err) {
              onError(describe(err));
            }
          }}
          className="w-full rounded-xl px-4 py-3 text-sm text-red-400 active:bg-slate-800"
        >
          Retire this item
        </button>
      )}
    </div>
  );
}

const inputClass =
  "tap w-full rounded-xl bg-slate-800 px-4 text-base outline-none focus:ring-2 focus:ring-sky-500";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-slate-400">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

// ── Stock, alerts, ledger ───────────────────────────────────────────────

function StockTab() {
  const [rows, setRows] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState<"all" | "low" | "empty">("all");

  useEffect(() => {
    const params =
      filter === "low" ? "low=true&limit=200" : filter === "empty" ? "empty=true&limit=200" : "limit=200";
    void api.stock(params).then(setRows).catch(() => setRows([]));
  }, [filter]);

  return (
    <div className="space-y-3">
      <div className="flex gap-1">
        {(["all", "low", "empty"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`flex-1 rounded-lg px-3 py-2 text-sm capitalize ${
              filter === f ? "bg-slate-700" : "bg-slate-900 text-slate-400"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {!rows && <Spinner label="Loading stock…" />}
      {rows?.map((item) => (
        <div key={item.id} className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{item.item_code}</span>
              <AlertChip level={item.alert_state} />
            </div>
            <div className="truncate text-sm text-slate-400">{item.description}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xl font-bold tabular-nums">{formatQty(item.on_hand)}</div>
            <div className="text-xs text-slate-500">
              of {formatQty(item.reorder_level)}
            </div>
          </div>
        </div>
      ))}
      {rows?.length === 0 && <p className="py-10 text-center text-slate-500">Nothing here.</p>}
    </div>
  );
}

function AlertsTab({
  client,
  onError,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
}) {
  const [rows, setRows] = useState<AlertRow[] | null>(null);

  const load = useCallback(() => {
    void api.alerts().then(setRows).catch(() => setRows([]));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="space-y-2">
      {!rows && <Spinner label="Loading alerts…" />}
      {rows?.length === 0 && (
        <p className="py-10 text-center text-slate-500">
          Nothing is low or empty.
        </p>
      )}
      {rows?.map((alert) => (
        <div
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
          <div className="pt-1 text-sm tabular-nums text-slate-300">
            {formatQty(alert.on_hand)} on hand · reorder at {formatQty(alert.reorder_level)}
            {alert.reorder_qty ? ` · order ${formatQty(alert.reorder_qty)}` : ""}
          </div>
          {alert.acknowledged_at ? (
            <div className="pt-1 text-xs text-slate-500">Acknowledged</div>
          ) : (
            <button
              type="button"
              onClick={async () => {
                try {
                  await client.ackAlert(alert.id);
                  load();
                } catch (err) {
                  onError(describe(err));
                }
              }}
              className="mt-2 rounded-lg bg-slate-700 px-3 py-1.5 text-sm"
            >
              Acknowledge
            </button>
          )}
        </div>
      ))}
      {rows && rows.length > 0 && (
        <p className="pt-2 text-xs text-slate-500">
          Acknowledging records that you have seen it. The alert stays open until
          stock actually arrives.
        </p>
      )}
    </div>
  );
}

function ActivityTab({
  client,
  onError,
  onNotice,
}: {
  client: ReturnType<typeof adminApi>;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);

  const load = useCallback(() => {
    void api.ledger("limit=60").then(setRows).catch(() => setRows([]));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="space-y-2">
      {!rows && <Spinner label="Loading the ledger…" />}
      {rows?.map((row) => {
        const out = row.delta_qty.startsWith("-");
        const reversed = row.reverses_id !== null;
        return (
          <div key={row.id} className="rounded-xl bg-slate-900 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{row.item_code}</div>
                <div className="truncate text-sm text-slate-400">
                  {row.txn_type} · {row.operator_name}
                  {row.machine_code ? ` · ${row.machine_code}` : ""}
                </div>
                {reversed && (
                  <div className="text-xs text-amber-400">
                    reverses #{row.reverses_id}
                  </div>
                )}
              </div>
              <div
                className={`shrink-0 text-lg font-bold tabular-nums ${
                  out ? "text-red-400" : "text-emerald-400"
                }`}
              >
                {formatQty(row.delta_qty)}
              </div>
            </div>

            {/* §7: a mistake is corrected by appending the mirror image. There
                is deliberately no edit and no delete here — the database would
                refuse anyway. */}
            {!reversed && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await client.reverse(row.id);
                    onNotice(`Reversed #${row.id}. Both rows stay in the ledger.`);
                    load();
                  } catch (err) {
                    onError(describe(err));
                  }
                }}
                className="mt-2 rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-300"
              >
                Reverse
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
