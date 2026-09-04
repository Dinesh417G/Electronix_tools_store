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

/** People, machines and reason codes — everything Setup edits. */
export interface Operator {
  id: string;
  emp_code: string;
  full_name: string;
  zk_user_id: string | null;
  role: "OPERATOR" | "STOREKEEPER" | "ADMIN";
  department: string | null;
  active: boolean;
}

export interface OperatorInput {
  emp_code: string;
  full_name: string;
  zk_user_id: string | null;
  role: string;
  department: string | null;
}

export interface MachineRow {
  id: string;
  code: string;
  name: string | null;
  active: boolean;
  /** How much history is attached. A rename with three years behind it
   *  relabels every past consumption report. */
  txn_count: number;
}

export interface ReasonRow {
  id: string;
  code: string;
  label: string;
  applies_to: string;
  sort_order: number;
  active: boolean;
  txn_count: number;
}

export interface DeviceRow {
  id: string;
  serial_no: string;
  name: string | null;
  location: string | null;
  last_seen_at: string | null;
  firmware: string | null;
}

export interface UnknownUserPunch {
  punch_id: string;
  zk_user_id: string;
  device_serial: string;
  received_at: string;
  occurrences: number;
}

export interface PunchRow {
  id: string;
  zk_user_id: string;
  device_ts: string | null;
  received_at: string;
  verify_mode: string | null;
  claimed: boolean;
}

/** One bucket of M8's consumption report. */
export interface ConsumptionRow {
  bucket_key: string;
  bucket_label: string;
  /** Positive magnitude consumed, as a string — `numeric(12,3)` through a
   *  JavaScript float is how a ledger stops adding up. */
  qty: string;
  value: string;
  txn_count: number;
}

export interface DoorView {
  devices: DeviceRow[];
  unknown_users: UnknownUserPunch[];
  recent_punches: PunchRow[];
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

    health: () => json<Record<string, unknown>>(token, "/api/v1/admin/health"),

    // ── Setup ────────────────────────────────────────────────────────────
    //
    // These endpoints landed on the Rust side before any screen called them,
    // which is §11's dead-wiring failure mode with the halves the other way
    // round from usual. This is the other half.
    //
    // Retirement is `active = false` throughout, never a delete:
    // `stock_ledger` points at every operator, machine and reason code, and
    // §7's claim that the history still answers "who took the forty inserts,
    // on which machine, and why" survives exactly as long as those rows do.

    operators: () => json<Operator[]>(token, "/api/v1/admin/operators"),

    createOperator: (input: OperatorInput & { pin?: string | null }) =>
      json<Operator>(token, "/api/v1/admin/operators", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    /// Only what is sent changes. `pin` absent leaves the PIN alone, `null`
    /// clears it, a string replaces it — the difference between renaming
    /// somebody and locking them out.
    patchOperator: (
      id: string,
      patch: Partial<OperatorInput> & { active?: boolean; pin?: string | null },
    ) =>
      json<Operator>(token, `/api/v1/admin/operators/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),

    deactivateOperator: (id: string) =>
      json<Operator>(token, `/api/v1/admin/operators/${id}`, { method: "DELETE" }),

    machines: () => json<MachineRow[]>(token, "/api/v1/admin/machines"),

    createMachine: (input: { code: string; name: string | null }) =>
      json<MachineRow>(token, "/api/v1/admin/machines", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    /// Also how a retired machine comes back: send `active: true`.
    updateMachine: (id: string, input: { code: string; name: string | null; active?: boolean }) =>
      json<MachineRow>(token, `/api/v1/admin/machines/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),

    deactivateMachine: (id: string) =>
      json<MachineRow>(token, `/api/v1/admin/machines/${id}`, { method: "DELETE" }),

    reasonCodes: () => json<ReasonRow[]>(token, "/api/v1/admin/reason-codes"),

    createReason: (input: {
      code: string;
      label: string;
      applies_to: string;
      sort_order?: number;
    }) =>
      json<ReasonRow>(token, "/api/v1/admin/reason-codes", {
        method: "POST",
        body: JSON.stringify(input),
      }),

    updateReason: (
      id: string,
      input: {
        code: string;
        label: string;
        applies_to: string;
        sort_order?: number;
        active?: boolean;
      },
    ) =>
      json<ReasonRow>(token, `/api/v1/admin/reason-codes/${id}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),

    deactivateReason: (id: string) =>
      json<ReasonRow>(token, `/api/v1/admin/reason-codes/${id}`, { method: "DELETE" }),

    door: () => json<DoorView>(token, "/api/v1/admin/devices"),

    /// M8's consumption report (§11), on the *console's* token rather than the
    /// terminal's. The other admin tabs read through `api.*`, which carries
    /// whatever this browser was enrolled with — fine on a wall tablet, and
    /// "this device is not enrolled" on the laptop an admin actually uses.
    consumption: (params: string) =>
      json<ConsumptionRow[]>(token, `/api/v1/reports/consumption?${params}`),

    /// Fetched rather than linked: the endpoint needs a token, and a bare href
    /// carries no Authorization header — it would answer 401 and the browser
    /// would save the refusal as a file called consumption.csv.
    consumptionCsv: async (params: string): Promise<Blob> => {
      const response = await send(token, `/api/v1/reports/consumption.csv?${params}`);
      return response.blob();
    },
  };
}
