// Admin API client (CLAUDE.md §11).
//
// Kept separate from `api.ts` because it authenticates differently: the
// terminal holds a long-lived *device* token, the admin console holds a
// short-lived *operator* token from a PIN login. Mixing them in one module
// invites a handler that reaches for the wrong one, and a tablet that could
// rewrite the catalog is exactly what §11's split is there to prevent.

import { ApiError, OfflineError } from "./api";

export const ADMIN_TOKEN_KEY = "electronix.store.admin_token";
export const ADMIN_NAME_KEY = "electronix.store.admin_name";

export interface Category {
  id: string;
  name: string;
  sort_order: number;
}

/// Numbers cross the wire as strings — see the note in `api.ts`.
export interface ItemInput {
  item_code: string;
  description: string;
  category_id: string | null;
  uom: string;
  iso_code: string | null;
  grade: string | null;
  manufacturer: string | null;
  mfr_part_no: string | null;
  diameter_mm: string | null;
  flutes: number | null;
  reorder_level: string;
  reorder_qty: string | null;
  bin_location: string | null;
  unit_cost: string | null;
  allow_negative: boolean;
}


/**
 * One physical tool's sticker.
 *
 * A serial identifies a *tool*, not a catalog line: forty identical inserts in
 * one bin are one item and forty stickers.
 */
export interface ToolSerial {
  id: string;
  item_id: string;
  serial_no: string;
  /** false once somebody typed the number rather than minting it. */
  minted: boolean;
  status: "ACTIVE" | "RETIRED";
  note: string | null;
  print_count: number;
  first_printed_at: string | null;
  last_printed_at: string | null;
  item_code?: string;
  description?: string;
}

export interface PrinterSettings {
  mode: "BROWSER_PDF" | "LAN_AGENT";
  name: string | null;
  host: string | null;
  port: number;
  dpi: number;
  label_width_mm: string;
  label_height_mm: string;
  last_seen_at: string | null;
}

export interface PrintResult {
  job_id: string;
  status: string;
  mode: string;
  /** Set in BROWSER_PDF mode: open it and the page prints itself. */
  sheet_url: string | null;
  serial: ToolSerial;
}

// ── People, pickers, the door and the reports ────────────────────────────

export type Role = "OPERATOR" | "STOREKEEPER" | "ADMIN";

export interface Operator {
  id: string;
  emp_code: string;
  full_name: string;
  role: Role;
  /** The id programmed into the door terminal. Null means they cannot punch in. */
  zk_user_id: string | null;
  department: string | null;
  active: boolean;
  /** Never the hash. Whether the manual fallback path (§8) is open to them. */
  has_pin: boolean;
  passkey_count: number;
  last_txn_at: string | null;
  created_at: string;
}

export interface OperatorInput {
  emp_code: string;
  full_name: string;
  role: Role;
  zk_user_id: string | null;
  department: string | null;
  /** Only ever sent, never received. Omit to leave an existing PIN alone. */
  pin?: string | null;
}

export interface Machine {
  id: string;
  code: string;
  name: string | null;
  active: boolean;
  /** How much history is attached. Renaming a busy machine relabels its past. */
  txn_count: number;
}

export interface ReasonCode {
  id: string;
  code: string;
  label: string;
  applies_to: "ISSUE" | "RECEIPT";
  sort_order: number;
  active: boolean;
  txn_count: number;
}

export interface DeviceRow {
  id: string;
  serial_no: string;
  name: string | null;
  location: string | null;
  firmware: string | null;
  timezone_offset_min: number | null;
  last_seen_at: string | null;
  punch_count: number;
  last_punch_at: string | null;
}

export interface PunchRow {
  id: string;
  zk_user_id: string;
  device_serial: string;
  /** What the server observed. §9.3 says business logic uses this one. */
  received_at: string;
  /** What the terminal claimed. Diagnostic only — clocks drift. */
  device_ts: string | null;
  verify_mode: string | null;
  claimed?: boolean;
  emp_code?: string | null;
  full_name?: string | null;
}

export interface DoorStatus {
  devices: DeviceRow[];
  unknown_users: PunchRow[];
  recent_punches: PunchRow[];
}

export type GroupBy = "item" | "machine" | "operator" | "category" | "month";

export interface ConsumptionRow {
  bucket_key: string;
  bucket_label: string;
  /** Strings, like every other quantity and price here. */
  qty: string;
  value: string;
  txn_count: number;
}

export interface DateRange {
  from?: string | null;
  to?: string | null;
}

function reportQuery(groupBy: GroupBy, range: DateRange): string {
  const p = new URLSearchParams({ group_by: groupBy });
  if (range.from) p.set("from", range.from);
  if (range.to) p.set("to", range.to);
  return p.toString();
}

export interface LoginResult {
  token: string;
  operator_id: string;
  full_name: string;
  role: string;
}

async function send(
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (cause) {
    throw new OfflineError(cause);
  }

  if (!response.ok) {
    const text = await response.text();
    let code = "error";
    let message = `Request failed (${response.status}).`;
    try {
      const body = JSON.parse(text);
      code = body.code ?? code;
      message = body.message ?? message;
    } catch {
      /* not JSON — keep the generic message */
    }
    throw new ApiError(response.status, code, message);
  }

  return response;
}

async function json<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await send(token, path, init);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}

/// Log in with an employee code and PIN. Returns a 12-hour operator token.
export async function login(empCode: string, pin: string): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch("/api/v1/auth/operator", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emp_code: empCode, pin }),
    });
  } catch (cause) {
    throw new OfflineError(cause);
  }

  if (!response.ok) {
    // One message for every failure, so this cannot be used to work out which
    // employee codes exist.
    throw new ApiError(401, "unauthorized", "That employee code or PIN is not right.");
  }

  return (await response.json()) as LoginResult;
}

/** One registered passkey, as `/auth/webauthn/credentials` reports it. */
export interface Passkey {
  id: string;
  device_label: string | null;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

export function adminApi(token: string) {
  return {
    categories: () => json<Category[]>(token, "/api/v1/admin/categories"),

    createItem: (input: ItemInput) =>
      json<unknown>(token, "/api/v1/admin/items", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    updateItem: (id: string, input: ItemInput) =>
      json<unknown>(token, `/api/v1/admin/items/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),

    /// Retires rather than deletes: deleting would orphan ledger history, and
    /// §7's whole point is that history survives.
    deactivateItem: (id: string) =>
      json<void>(token, `/api/v1/admin/items/${id}`, { method: "DELETE" }),

    addBarcode: (id: string, code: string, kind = "VENDOR") =>
      json<unknown>(token, `/api/v1/admin/items/${id}/barcodes`, {
        method: "POST",
        body: JSON.stringify({ code, kind }),
      }),

    ackAlert: (id: string) =>
      json<void>(token, `/api/v1/alerts/${id}/ack`, { method: "POST" }),

    /// §7: appends the mirror image. Never edits or deletes the original.
    reverse: (ledgerId: number, note?: string) =>
      json<unknown>(token, `/api/v1/txn/${ledgerId}/reverse`, {
        method: "POST",
        body: JSON.stringify({ note: note ?? null }),
      }),

    /// Code128 label batch → PDF (§11).
    printLabels: async (itemIds: string[], copies = 1): Promise<Blob> => {
      const response = await send(token, "/api/v1/admin/labels/print", {
        method: "POST",
        body: JSON.stringify({ item_ids: itemIds, copies }),
      });
      return response.blob();
    },


    // ── Passkeys (§8) ───────────────────────────────────────────────────
    //
    // Scoped to the caller by the server, always: listing another operator's
    // devices would tell you which phones open the crib, which is
    // reconnaissance dressed as a feature. Registration is not here — it needs
    // the raw token and the browser's WebAuthn ceremony, so it lives in
    // lib/passkey.ts.

    passkeys: () => json<Passkey[]>(token, "/api/v1/auth/webauthn/credentials"),

    /// Revoked rather than deleted, so "this phone could open the crib until
    /// the 14th" stays answerable after the phone is gone.
    revokePasskey: (id: string) =>
      json<void>(token, `/api/v1/auth/webauthn/credentials/${id}`, { method: "DELETE" }),

    // ── Serials ─────────────────────────────────────────────────────────
    //
    // On the admin client, not the device one: minting and printing need a
    // storekeeper, and a tablet token would be refused. Putting them in
    // `api.ts` would be an endpoint that 403s from the only place it is
    // reachable.

    serialsForItem: (itemId: string) =>
      json<ToolSerial[]>(token, `/api/v1/items/${itemId}/serials`),

    mintSerials: (itemId: string, count: number) =>
      json<ToolSerial[]>(token, `/api/v1/items/${itemId}/serials`, {
        method: "POST",
        body: JSON.stringify({ count }),
      }),

    /// Editable, but never duplicable — the unique index refuses a number
    /// already on another tool and the server answers 409.
    updateSerial: (
      id: string,
      patch: { serial_no?: string; status?: "ACTIVE" | "RETIRED"; note?: string | null },
    ) =>
      json<ToolSerial>(token, `/api/v1/serials/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    /// Reprint is the same number again: print_count moves, the serial does not.
    printSerial: (id: string, copies = 1) =>
      json<PrintResult>(token, `/api/v1/serials/${id}/print`, {
        method: "POST",
        body: JSON.stringify({ copies }),
      }),

    /// The sheet endpoint needs the operator token too, so it is fetched here
    /// and handed to the browser as a blob rather than opened as a bare URL.
    labelSheet: async (serialIds: string[], copies = 1): Promise<Blob> => {
      const response = await send(
        token,
        `/api/v1/labels/sheet?serial_ids=${serialIds.join(",")}&copies=${copies}`,
      );
      return response.blob();
    },

    // ── Printer ─────────────────────────────────────────────────────────
    printerSettings: () => json<PrinterSettings>(token, "/api/v1/admin/printer"),

    savePrinterSettings: (patch: Partial<PrinterSettings>) =>
      json<PrinterSettings>(token, "/api/v1/admin/printer", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),

    // ── People ──────────────────────────────────────────────────────────
    //
    // ADMIN only, server-side. A storekeeper who opens this tab gets a 403 with
    // a sentence rather than an empty list, which is the difference between
    // "you may not" and "there is nobody here".

    operators: (includeInactive = false) =>
      json<Operator[]>(
        token,
        `/api/v1/admin/operators?include_inactive=${includeInactive}`,
      ),

    createOperator: (input: OperatorInput) =>
      json<Operator>(token, "/api/v1/admin/operators", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    /// Partial: what is not sent is not changed. Omitting `pin` leaves the
    /// existing one alone; sending null clears it and closes the PIN path.
    updateOperator: (id: string, patch: Partial<OperatorInput> & { active?: boolean }) =>
      json<Operator>(token, `/api/v1/admin/operators/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    /// Deactivates. Their ledger rows keep their name on them (§7).
    deactivateOperator: (id: string) =>
      json<Operator>(token, `/api/v1/admin/operators/${id}`, { method: "DELETE" }),

    // ── Pickers ─────────────────────────────────────────────────────────

    machines: () => json<Machine[]>(token, "/api/v1/admin/machines"),

    createMachine: (input: { code: string; name: string | null }) =>
      json<Machine>(token, "/api/v1/admin/machines", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    updateMachine: (id: string, input: { code: string; name: string | null; active?: boolean }) =>
      json<Machine>(token, `/api/v1/admin/machines/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),

    deactivateMachine: (id: string) =>
      json<Machine>(token, `/api/v1/admin/machines/${id}`, { method: "DELETE" }),

    reasonCodes: () => json<ReasonCode[]>(token, "/api/v1/admin/reason-codes"),

    createReasonCode: (input: Omit<ReasonCode, "id" | "active" | "txn_count">) =>
      json<ReasonCode>(token, "/api/v1/admin/reason-codes", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    updateReasonCode: (
      id: string,
      input: {
        code: string;
        label: string;
        applies_to: "ISSUE" | "RECEIPT";
        sort_order: number;
        active?: boolean;
      },
    ) =>
      json<ReasonCode>(token, `/api/v1/admin/reason-codes/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),

    deactivateReasonCode: (id: string) =>
      json<ReasonCode>(token, `/api/v1/admin/reason-codes/${id}`, { method: "DELETE" }),

    // ── The door ────────────────────────────────────────────────────────

    door: () => json<DoorStatus>(token, "/api/v1/admin/devices"),

    // ── Reports (M8) ────────────────────────────────────────────────────

    consumption: (groupBy: GroupBy, range: DateRange = {}) =>
      json<ConsumptionRow[]>(
        token,
        `/api/v1/reports/consumption?${reportQuery(groupBy, range)}`,
      ),

    /// Fetched rather than linked: the endpoint needs the operator token, and a
    /// bare href carries no Authorization header.
    consumptionCsv: async (groupBy: GroupBy, range: DateRange = {}): Promise<Blob> => {
      const response = await send(
        token,
        `/api/v1/reports/consumption.csv?${reportQuery(groupBy, range)}`,
      );
      return response.blob();
    },

    health: () => json<Record<string, unknown>>(token, "/api/v1/admin/health"),
  };
}
