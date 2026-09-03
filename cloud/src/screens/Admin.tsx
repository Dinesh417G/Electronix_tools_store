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
  type InsightView,
  type AlertRow,
  type Item,
} from "../lib/api";
import { adminApi, type Category, type ItemInput } from "../lib/admin";
import { useRefreshOnReturn } from "../lib/refresh";
import { AlertChip, Banner, BigButton, Chip, Field, Header, Spinner, TabStrip } from "../components/ui";
import { Row, RowList } from "../components/row";
import { PrinterSettings } from "./PrinterSettings";
import { Serials } from "./Serials";
import { People } from "./People";
import { Machines, ReasonCodes } from "./Pickers";
import { Door } from "./Door";
import { Loaded, useLoadable } from "./Loadable";
import { FilterChips, hintFor, viewDetail } from "./Filters";
import { Passkeys } from "./Passkeys";
import { Reports } from "./Reports";

type Tab = "catalog" | "stock" | "alerts" | "activity" | "reports" | "settings";

/** The things behind Setup. Each is a screen of its own, not a tab: they are
 *  visited when something changes, not while working. */
type SetupSection = "printer" | "people" | "machines" | "reasons" | "door" | "passkeys";

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

  /* Both banners belong to the tab that raised them. They are rendered by the
   * shell, above the tab bar, so without this a `Request failed (504)` from
   * Catalog stays on screen while you read Setup — which fetches nothing at
   * all, and so cannot have failed. An error that outlives its context does
   * not merely linger; it accuses the wrong screen, and the reader believes
   * it. Leaving the tab is the moment the message stops being true. */
  const openTab = useCallback((next: Tab) => {
    setTab(next);
    setError(null);
    setNotice(null);
  }, []);

  return (
    // `h-dvh` rather than `min-h-full`: on a phone the address bar changes the
    // viewport as you scroll, and a percentage height resolved against an
    // auto-height ancestor left the whole page scrolling — which took the
    // header and the tab bar off the top of the screen. The dynamic viewport
    // unit plus `min-h-0` on the scroller keeps scrolling inside the list,
    // where it belongs.
    <div className="admin flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 safe-top">
        <Header
          title="Admin"
          subtitle={operatorName}
          right={
            <button
              type="button"
              onClick={onSignOut}
              className="tap rounded-lg px-4 text-sm text-muted active:bg-surface-2"
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

      {/* Six labels will not fit a 390 px phone at a readable size, so this
          scrolls as one row instead of wrapping into a block of six pills. */}
      <TabStrip
        value={tab}
        onChange={openTab}
        options={[
          { value: "catalog", label: "Catalog" },
          { value: "stock", label: "Stock" },
          { value: "alerts", label: "Alerts" },
          { value: "activity", label: "Ledger" },
          { value: "reports", label: "Reports" },
          { value: "settings", label: "Setup" },
        ]}
      />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 safe-bottom">
        {tab === "catalog" && (
          <Catalog client={client} onError={setError} onNotice={setNotice} />
        )}
        {tab === "stock" && <StockTab />}
        {tab === "alerts" && <AlertsTab client={client} onError={setError} />}
        {tab === "reports" && (
          <Reports client={client} onError={setError} onNotice={setNotice} />
        )}
        {tab === "settings" && (
          <Setup
            client={client}
            token={token}
            operatorName={operatorName}
            onError={setError}
            onNotice={setNotice}
          />
        )}
        {tab === "activity" && (
          <ActivityTab client={client} onError={setError} onNotice={setNotice} />
        )}
      </div>
    </div>
  );
}

// ── Setup ───────────────────────────────────────────────────────────────
//
// A hub rather than five more tabs. Everything behind it is something you
// change when the store changes — a new machine arrives, somebody joins, the
// reader moves — not something you look at while working. Putting them in the
// tab bar would push the things that *are* daily off the edge of a phone.

function Setup({
  client,
  token,
  operatorName,
  onError,
  onNotice,
}: {
  client: ReturnType<typeof adminApi>;
  // Passkey registration needs the raw token, not the client wrapped around
  // it: the ceremony is the browser's, and §8 requires proving who you are by
  // the means that already exist before enrolling a new one.
  token: string;
  operatorName: string;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [section, setSection] = useState<SetupSection | null>(null);
  const back = () => setSection(null);

  if (section === "people") {
    return <People client={client} onBack={back} onError={onError} onNotice={onNotice} />;
  }
  if (section === "machines") {
    return <Machines client={client} onBack={back} onError={onError} onNotice={onNotice} />;
  }
  if (section === "reasons") {
    return <ReasonCodes client={client} onBack={back} onError={onError} onNotice={onNotice} />;
  }
  if (section === "door") {
    return <Door client={client} onBack={back} onError={onError} />;
  }
  if (section === "passkeys") {
    return (
      <Passkeys
        client={client}
        token={token}
        operatorName={operatorName}
        onBack={back}
        onError={onError}
        onNotice={onNotice}
      />
    );
  }
  if (section === "printer") {
    return (
      <div className="space-y-3">
        <Header title="Printer" subtitle="Labels and the label size" onBack={back} />
        <PrinterSettings client={client} onNotice={onNotice} onError={onError} />
      </div>
    );
  }

  const sections: { key: SetupSection; title: string; blurb: string }[] = [
    {
      key: "people",
      title: "People",
      blurb: "Who can take stock out, and what they may do. Admin only.",
    },
    {
      key: "machines",
      title: "Machines",
      blurb: "The picker on the optional step — and the axis of the by-machine report.",
    },
    {
      key: "reasons",
      title: "Reasons",
      blurb: "Why stock moved, when anybody bothers to say.",
    },
    {
      key: "door",
      title: "Door",
      blurb: "Is the reader still talking to us, and what has it sent.",
    },
    {
      key: "passkeys",
      title: "Fingerprint sign-in",
      blurb: "Which of your devices may sign in as you, and forgetting one you have lost.",
    },
    {
      key: "printer",
      title: "Printer",
      blurb: "Label size, and whether printing goes through the browser or the shop agent.",
    },
  ];

  return (
    <RowList>
      {sections.map((entry) => (
        <Row
          key={entry.key}
          title={entry.title}
          subtitle={entry.blurb}
          onClick={() => setSection(entry.key)}
          trailing={<ChevronRight />}
        />
      ))}
    </RowList>
  );
}

/** The "this row goes somewhere" affordance — Setup's list, nowhere else yet. */
function ChevronRight() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0 text-faint"
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
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
  // The serial list is a view *of an item*, so it is reached from the row
  // rather than from the tab bar: "which tools of this kind exist" is a
  // question you ask about a specific line in the catalog.
  const [serialsFor, setSerialsFor] = useState<Item | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(query.trim().length >= 2 ? await api.search(query) : await api.stock("limit=200"));
      setFailed(false);
    } catch (err) {
      // Recorded on the screen as well as raised as a banner. A banner can be
      // dismissed, and a dismissed banner over an empty list is indistinguishable
      // from a store with no items in it.
      setFailed(true);
      onError(describe(err));
    } finally {
      setLoading(false);
    }
  }, [query, onError]);

  // The tab was backgrounded for the print dialogue, or the radio dropped.
  // Coming back should fix itself rather than need a reload.
  useRefreshOnReturn(load);

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

  if (serialsFor) {
    return (
      <Serials
        client={client}
        itemId={serialsFor.id}
        itemCode={serialsFor.item_code}
        onBack={() => setSerialsFor(null)}
        onNotice={onNotice}
        onError={onError}
      />
    );
  }

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
          className="tap flex-1 rounded-xl border border-line bg-surface px-4 outline-none placeholder:text-faint focus:border-accent focus:ring-1 focus:ring-accent/30"
        />
        <BigButton onClick={() => setEditing("new")} variant="primary" className="px-5 text-base">
          + Item
        </BigButton>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-accent-soft px-4 py-3">
          <span className="flex-1 text-sm">
            {selected.size} selected for label printing
          </span>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="tap rounded-lg px-4 text-sm text-muted"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => void printSelected()}
            className="tap rounded-lg bg-accent px-4 text-sm font-semibold text-white"
          >
            Print labels
          </button>
        </div>
      )}

      {loading && items.length === 0 && <Spinner label="Loading catalog…" />}

      {!loading && failed && items.length === 0 && (
        <div className="space-y-3 py-10 text-center">
          <p className="text-muted">The catalog did not load.</p>
          <button
            type="button"
            onClick={() => void load()}
            className="tap rounded-xl bg-accent px-6 py-3 font-semibold text-white"
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !failed && items.length === 0 && (
        <p className="py-10 text-center text-faint">
          {query.trim() ? "Nothing matches." : "No items yet. Add one with + Item."}
        </p>
      )}

      {items.length > 0 && (
        <RowList>
          {items.map((item) => (
            <Row
              key={item.id}
              title={item.item_code}
              badge={
                <>
                  <AlertChip level={item.alert_state} />
                  {!item.active && (
                    <span className="rounded-full bg-surface-3 px-2 py-0.5 text-xs">
                      retired
                    </span>
                  )}
                </>
              }
              subtitle={item.description}
              meta={item.bin_location ? `Bin ${item.bin_location}` : undefined}
              value={formatQty(item.on_hand)}
              valueNote={item.uom}
              onClick={() => setEditing(item)}
              leading={
                <button
                  type="button"
                  aria-label={`Select ${item.item_code}`}
                  onClick={() => toggle(item.id)}
                  className={`h-8 w-8 shrink-0 rounded-lg border-2 text-sm ${
                    selected.has(item.id)
                      ? "border-accent bg-accent text-white"
                      : "border-line-strong"
                  }`}
                >
                  {selected.has(item.id) ? "✓" : ""}
                </button>
              }
              trailing={
                <button
                  type="button"
                  aria-label={`Serial numbers for ${item.item_code}`}
                  onClick={() => setSerialsFor(item)}
                  className="tap shrink-0 rounded-lg bg-surface-2 px-3 text-xs text-ink-2"
                >
                  Serials
                </button>
              }
            />
          ))}
        </RowList>
      )}

    </div>
  );
}

/**
 * The stock band, edited where the problem is visible.
 *
 * "Two to five" is how a storekeeper describes a bin, so both ends are on one
 * row and the minimum is first. The maximum may be left empty — plenty of a
 * 90-line catalog will never have one — and clearing it is a deliberate action
 * rather than a side effect of not typing anything.
 */
function LevelBand({
  alert,
  onSave,
  onCancel,
}: {
  alert: AlertRow;
  onSave: (levels: { reorder_level: string; max_level: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const [min, setMin] = useState(trimQty(alert.reorder_level));
  const [max, setMax] = useState(alert.max_level ? trimQty(alert.max_level) : "");
  const [busy, setBusy] = useState(false);

  const invalid = max.trim() !== "" && Number(max) < Number(min || 0);

  return (
    <div className="mt-3 space-y-2 rounded-xl bg-app/60 p-3">
      <div className="flex items-end gap-2">
        <label className="flex-1 text-xs text-muted">
          Reorder at
          <input
            value={min}
            onChange={(e) => setMin(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="decimal"
            className="tap mt-1 w-full rounded-lg bg-surface-2 px-3 text-base text-ink"
          />
        </label>
        <span className="pb-3 text-faint">to</span>
        <label className="flex-1 text-xs text-muted">
          Full at
          <input
            value={max}
            onChange={(e) => setMax(e.target.value.replace(/[^\d.]/g, ""))}
            inputMode="decimal"
            placeholder="optional"
            className="tap mt-1 w-full rounded-lg bg-surface-2 px-3 text-base text-ink"
          />
        </label>
      </div>

      {invalid && (
        <p className="text-xs text-warning">
          The maximum cannot be below the reorder level.
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || invalid || min.trim() === ""}
          onClick={async () => {
            setBusy(true);
            await onSave({
              reorder_level: min.trim(),
              max_level: max.trim() === "" ? null : max.trim(),
            });
            setBusy(false);
          }}
          className="tap flex-1 rounded-lg bg-accent px-4 text-sm font-semibold text-white disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="tap rounded-lg bg-surface-2 px-4 text-sm text-ink-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** `numeric(12,3)` arrives as "2.000"; nobody types trailing zeroes. */
function trimQty(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
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
          className="tap -ml-2 w-12 rounded-xl text-2xl text-muted active:bg-surface-2"
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

      <label className="flex items-center gap-3 rounded-xl bg-surface px-4 py-3">
        <input
          type="checkbox"
          checked={form.allow_negative}
          onChange={(e) => set("allow_negative", e.target.checked)}
          className="h-5 w-5"
        />
        <span className="flex-1 text-sm">
          Allow negative stock
          <span className="block text-xs text-faint">
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
          className="w-full rounded-xl px-4 py-3 text-sm text-danger active:bg-surface-2"
        >
          Retire this item
        </button>
      )}
    </div>
  );
}

const inputClass =
  "tap w-full rounded-xl border border-line bg-surface px-4 text-base outline-none focus:border-accent focus:ring-1 focus:ring-accent/30";


// ── Stock, alerts, ledger ───────────────────────────────────────────────

function StockTab() {
  // Six questions rather than three states. "Low" and "Empty" answered what the
  // alert engine already knew; they could not answer "what is this crib
  // actually getting through" or "what has sat in a bin since March", which is
  // most of what a storekeeper wants a catalog for.
  const [view, setView] = useState<InsightView>("frequent");

  // This used to be `.catch(() => setRows([]))`: a failed request drew "Nothing
  // here" with no banner at all, which in a stock console reads as "the crib is
  // empty" rather than "I could not ask".
  const stockState = useLoadable(() => api.insights(view, 200), [view]);

  return (
    <div className="space-y-3">
      <FilterChips view={view} onChange={setView} />
      <p className="px-1 text-xs text-faint">{hintFor(view)}</p>

      <Loaded
        state={stockState}
        label="Loading stock…"
        empty={<p className="py-10 text-center text-faint">Nothing here.</p>}
      >
        {(loaded) => (
          <RowList>
            {loaded.map((item) => (
              <Row
                key={item.id}
                title={item.item_code}
                badge={<AlertChip level={item.alert_state} />}
                subtitle={item.description}
                meta={viewDetail(view, item)}
                value={formatQty(item.on_hand)}
                valueNote={`of ${formatQty(item.reorder_level)}`}
                tone={
                  item.alert_state === "EMPTY"
                    ? "empty"
                    : item.alert_state === "LOW"
                      ? "low"
                      : "plain"
                }
              />
            ))}
          </RowList>
        )}
      </Loaded>
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
  const [editing, setEditing] = useState<string | null>(null);

  const state = useLoadable(() => api.alerts(), []);
  const rows = state.data;
  const load = state.reload;

  useRefreshOnReturn(load);

  return (
    <div className="space-y-2">
      <Loaded
        state={state}
        label="Loading alerts…"
        empty={<p className="py-10 text-center text-faint">Nothing is low or empty.</p>}
      >
        {(loaded) => loaded.map((alert) => (
        <div
          key={alert.id}
          className={`rounded-xl border-l-4 bg-surface px-4 py-3 ${
            alert.level === "EMPTY" ? "border-danger" : "border-warning"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold">{alert.item_code}</span>
            <AlertChip level={alert.level} />
          </div>
          <div className="text-sm text-muted">{alert.description}</div>
          <div className="pt-1 text-sm tabular-nums text-ink-2">
            {formatQty(alert.on_hand)} on hand · band {formatQty(alert.reorder_level)}
            {alert.max_level ? `–${formatQty(alert.max_level)}` : "–—"}
            {alert.max_level
              ? ` · short ${formatQty(
                  String(Math.max(0, Number(alert.max_level) - Number(alert.on_hand))),
                )}`
              : ""}
          </div>

          {editing === alert.item_id ? (
            <LevelBand
              alert={alert}
              onCancel={() => setEditing(null)}
              onSave={async (levels) => {
                try {
                  await client.setLevels(alert.item_id, levels);
                  setEditing(null);
                  load();
                } catch (err) {
                  onError(describe(err));
                }
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditing(alert.item_id)}
              className="tap mt-2 mr-2 rounded-lg bg-surface-2 px-4 text-sm text-ink-2"
            >
              Set levels
            </button>
          )}
          {alert.acknowledged_at ? (
            <div className="pt-1 text-xs text-faint">Acknowledged</div>
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
              className="tap mt-2 rounded-lg bg-surface-3 px-4 text-sm"
            >
              Acknowledge
            </button>
          )}
        </div>
        ))}
      </Loaded>
      {rows && rows.length > 0 && (
        <p className="pt-2 text-xs text-faint">
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
  // Filter by reason, because the question a storekeeper actually asks is "show
  // me the breakages" — and until now the only way to answer it was to read 60
  // rows and squint. Damage carries a note now (§12.6), so this list is where
  // that note is read.
  const [reason, setReason] = useState<string | null>(null);
  const reasons = useLoadable(() => api.reasonCodes(), []);
  const state = useLoadable(
    () => api.ledger(reason ? `limit=60&reason=${encodeURIComponent(reason)}` : "limit=60"),
    [reason],
  );
  const load = state.reload;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <Chip active={reason === null} onClick={() => setReason(null)} size="sm">
          All reasons
        </Chip>
        {(reasons.data ?? []).map((r) => (
          <Chip
            key={r.id}
            active={reason === r.code}
            onClick={() => setReason(reason === r.code ? null : r.code)}
            size="sm"
          >
            {r.label}
          </Chip>
        ))}
      </div>

      <Loaded
        state={state}
        label="Loading the ledger…"
        empty={
          <p className="py-10 text-center text-faint">
            {reason
              ? "No movements booked under that reason in the last 60."
              : "No movements yet."}
          </p>
        }
      >
        {(loaded) => (
          <RowList>
            {loaded.map((row) => {
              const out = row.delta_qty.startsWith("-");
              const reversed = row.reverses_id !== null;
              return (
                <Row
                  key={row.id}
                  title={row.item_code}
                  badge={
                    reversed ? (
                      <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning">
                        reverses #{row.reverses_id}
                      </span>
                    ) : undefined
                  }
                  subtitle={
                    `${row.txn_type} · ${row.operator_name}` +
                    (row.machine_code ? ` · ${row.machine_code}` : "")
                  }
                  meta={
                    row.reason_code
                      ? row.reason_code + (row.note ? ` — ${row.note}` : "")
                      : undefined
                  }
                  value={formatQty(row.delta_qty)}
                  tone={out ? "out" : "in"}
                  /* §7: a mistake is corrected by appending the mirror image.
                     There is deliberately no edit and no delete here — the
                     database would refuse anyway. */
                  actions={
                    reversed ? undefined : (
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
                        className="tap rounded-lg bg-surface-2 px-4 text-sm text-ink-2"
                      >
                        Reverse
                      </button>
                    )
                  }
                />
              );
            })}
          </RowList>
        )}
      </Loaded>
    </div>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
