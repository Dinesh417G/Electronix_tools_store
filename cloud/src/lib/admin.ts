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

    health: () => json<Record<string, unknown>>(token, "/api/v1/admin/health"),
  };
}
