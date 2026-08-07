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
  };
}
