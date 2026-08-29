// Typed client for the store-server REST surface (CLAUDE.md §11).
//
// One rule shapes the error handling here: the status codes the spec calls out
// are load-bearing UX, not incidental. A 409 on an issue means "count the bin",
// a 410 means "your session closed, tap your name again". Both must survive the
// trip from Postgres to the operator's screen intact, so `ApiError` keeps the
// status rather than flattening everything into a string.

import { fetchOrThrow } from "./offline";

export const TOKEN_KEY = "electronix.store.token";
export const TERMINAL_KEY = "electronix.store.terminal_id";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** §7 — an ISSUE that would push stock below zero. */
  get isStockConflict() {
    return this.status === 409 && this.code === "conflict";
  }

  /** §10 — the session closed or expired under the operator. */
  get isSessionGone() {
    return this.status === 410;
  }

  /** The device token is missing, wrong or revoked: re-enrol. */
  get isUnauthorized() {
    return this.status === 401;
  }
}

// `OfflineError` lives in `offline.ts` with the deadline and the retry policy
// it belongs to, and is re-exported here because this is where every screen
// already imports it from. It carries *why* — device offline, our deadline, or
// a dropped connection — and how long we waited, because one flat sentence for
// all three is what made the 2026-08-29 screenshot undiagnosable.
export { OfflineError } from "./offline";
export type { OfflineReason } from "./offline";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getTerminalId(): string | null {
  return localStorage.getItem(TERMINAL_KEY);
}

export function saveCredentials(terminalId: string, token: string) {
  localStorage.setItem(TERMINAL_KEY, terminalId);
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearCredentials() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TERMINAL_KEY);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  { auth = true }: { auth?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");

  if (auth) {
    const token = getToken();
    if (!token) throw new ApiError(401, "unauthorized", "This device is not enrolled.");
    headers.set("authorization", `Bearer ${token}`);
  }

  // The deadline, the retry policy and the classification of a failure all
  // live in `offline.ts`, because the admin console and the passkey ceremony
  // need exactly the same three and used to have none of them.
  //
  // An abort lands in the same branch as an unreachable server and becomes an
  // `OfflineError`, which is exactly right for a write: §12 queues it under the
  // `client_txn_uuid` it already minted, and if the request did commit before
  // we stopped listening, the replay resolves to that same row instead of a
  // second deduction (§7). That is the case M9 names — "the request commits
  // and the acknowledgement is lost".
  const response = await fetchOrThrow(path, { ...init, headers });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body = text ? safeJson(text) : null;

  if (!response.ok) {
    const code = (body?.code as string) ?? "error";
    const message = (body?.message as string) ?? `Request failed (${response.status}).`;
    throw new ApiError(response.status, code, message);
  }

  return body as T;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Types mirroring the server's response shapes ────────────────────────
//
// Quantities are strings, not numbers. Postgres `numeric(12,3)` does not fit
// an IEEE double without rounding, and a tool crib that quietly loses a
// thousandth of a litre of coolant per transaction is exactly the kind of drift
// §7 exists to prevent. Format for display; never do arithmetic on these.

export interface UnclaimedSession {
  session_id: string;
  operator_id: string;
  emp_code: string;
  full_name: string;
  department: string | null;
  opened_at: string;
  expires_in_secs: number;
}

export interface SessionResponse {
  session_id: string;
  operator_id: string;
  emp_code: string;
  full_name: string;
  state: string;
  manual_identity: boolean;
  tablet_id: string | null;
}

export interface Item {
  id: string;
  item_code: string;
  description: string;
  uom: string;
  category_id: string | null;
  category_name: string | null;
  iso_code: string | null;
  grade: string | null;
  manufacturer: string | null;
  mfr_part_no: string | null;
  bin_location: string | null;
  unit_cost: string | null;
  reorder_level: string;
  max_level: string | null;
  reorder_qty: string | null;
  allow_negative: boolean;
  active: boolean;
  on_hand: string;
  alert_state: "OK" | "LOW" | "EMPTY";
}

export interface TxnResponse {
  ledger_id: number;
  /** Every row the request wrote — one per machine for a split issue. */
  ledger_ids: number[];
  item_id: string;
  item_code: string;
  description: string;
  delta_qty: string;
  on_hand: string;
  alert_state: string;
  crossed_threshold: boolean;
}

export interface LedgerRow {
  id: number;
  item_id: string;
  item_code: string;
  description: string;
  delta_qty: string;
  txn_type: string;
  operator_id: string;
  operator_name: string;
  session_id: string | null;
  machine_code: string | null;
  reason_code: string | null;
  note: string | null;
  unit_cost: string | null;
  created_at: string;
  reverses_id: number | null;
}

export interface AlertRow {
  id: string;
  item_id: string;
  item_code: string;
  description: string;
  bin_location: string | null;
  level: "LOW" | "EMPTY";
  on_hand: string;
  reorder_level: string;
  max_level: string | null;
  reorder_qty: string | null;
  raised_at: string;
  acknowledged_at: string | null;
}

export interface AlertSummary {
  low: number;
  empty: number;
}

export interface Machine {
  id: string;
  code: string;
  name: string | null;
}

export interface ReasonCode {
  id: string;
  code: string;
  label: string;
  applies_to: "ISSUE" | "RECEIPT";
  sort_order: number;
}

export interface UnknownPunch {
  id: string;
  zk_user_id: string;
  device_serial: string;
  received_at: string;
  device_ts: string | null;
  verify_mode: string | null;
}

export interface VersionInfo {
  version: string;
  git_sha: string;
  built_at: string;
}

export interface IssueBody {
  session_id: string;
  item_id: string;
  qty: string;
  machine_id?: string | null;
  reason_id?: string | null;
  note?: string | null;
  client_txn_uuid: string;
  /** §11: one item going to several machines. When present the server writes
   *  one ledger row per split, all in one transaction, and ignores
   *  `machine_id`. */
  splits?: IssueSplitBody[];
}

export interface IssueSplitBody {
  machine_id: string;
  qty: string;
  client_txn_uuid: string;
}

export interface ReceiptBody {
  session_id: string;
  item_id: string;
  qty: string;
  unit_cost?: string | null;
  reason_id?: string | null;
  note?: string | null;
  client_txn_uuid: string;
}

// ── Endpoints ───────────────────────────────────────────────────────────

export const api = {
  version: () => request<VersionInfo>("/api/v1/version", {}, { auth: false }),

  enrol: (terminalId: string, name: string, secret: string) =>
    request<{ tablet_id: string; token: string }>(
      "/api/v1/auth/tablet",
      {
        method: "POST",
        body: JSON.stringify({
          tablet_id: terminalId,
          name,
          enrolment_secret: secret,
        }),
      },
      { auth: false },
    ),

  unclaimed: () => request<UnclaimedSession[]>("/api/v1/sessions/unclaimed"),

  claim: (sessionId: string, terminalId: string) =>
    request<SessionResponse>(`/api/v1/sessions/${sessionId}/claim`, {
      method: "POST",
      body: JSON.stringify({ tablet_id: terminalId }),
    }),

  manualSession: (empCode: string, pin: string, terminalId: string) =>
    request<SessionResponse>("/api/v1/sessions/manual", {
      method: "POST",
      body: JSON.stringify({ emp_code: empCode, pin, tablet_id: terminalId }),
    }),

  /** §10: tell the server the operator is still working, so the 180 s idle
   *  timeout measures idleness rather than elapsed time. Everything between
   *  claiming and confirming happens on the tablet, so without this the server
   *  sees silence from somebody standing right in front of it. */
  touchSession: (sessionId: string) =>
    request<SessionResponse>(`/api/v1/sessions/${sessionId}/touch`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  closeSession: (sessionId: string) =>
    request<SessionResponse>(`/api/v1/sessions/${sessionId}/close`, {
      method: "POST",
      body: JSON.stringify({ reason: "DONE" }),
    }),

  lookup: (barcode: string) =>
    request<Item>(`/api/v1/items/lookup?barcode=${encodeURIComponent(barcode)}`),

  search: (q: string) =>
    request<Item[]>(`/api/v1/items/search?q=${encodeURIComponent(q)}&limit=25`),

  issue: (body: IssueBody) =>
    request<TxnResponse>("/api/v1/txn/issue", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  receipt: (body: ReceiptBody) =>
    request<TxnResponse>("/api/v1/txn/receipt", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  stock: (params = "") => request<Item[]>(`/api/v1/stock?${params}`),

  ledger: (params = "limit=50") => request<LedgerRow[]>(`/api/v1/ledger?${params}`),

  alerts: () => request<AlertRow[]>("/api/v1/alerts"),

  alertSummary: () => request<AlertSummary>("/api/v1/alerts/summary"),

  machines: () => request<Machine[]>("/api/v1/machines"),

  reasonCodes: (appliesTo?: "ISSUE" | "RECEIPT") =>
    request<ReasonCode[]>(
      appliesTo ? `/api/v1/reason-codes?applies_to=${appliesTo}` : "/api/v1/reason-codes",
    ),

  /** §12.4's Browse all, paged — 90 items is already too many to scroll blind. */
  browse: (offset = 0, limit = 25) =>
    request<Item[]>(`/api/v1/items/browse?offset=${offset}&limit=${limit}`),

  /** §9.4: fingers the door accepted that we cannot put a name to. */
  unknownPunches: (since?: string) =>
    request<UnknownPunch[]>(
      since
        ? `/api/v1/punches/unknown?since=${encodeURIComponent(since)}`
        : "/api/v1/punches/unknown",
    ),
};

/** Format a server decimal string for display, trimming pointless zeros. */
export function formatQty(raw: string): string {
  if (!raw.includes(".")) return raw;
  const trimmed = raw.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}
