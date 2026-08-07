// The offline outbox (CLAUDE.md §12).
//
// > Writes queue to a local store and flush when the LAN returns. Queued rows
// > are visibly marked pending. Server deduplicates on a client-generated
// > `txn_uuid`.
//
// IndexedDB rather than localStorage: a flush interrupted halfway must not be
// able to lose the rest of the queue, and localStorage has no transactions.
//
// The `client_txn_uuid` is generated **before** the first send attempt and
// never regenerated. That is the whole safety property — a retry of a request
// the server already committed resolves to the same row instead of a second
// deduction. The server enforces it with a unique index; this side just has to
// not be clever.

const DB_NAME = "electronix-store-outbox";
const DB_VERSION = 1;
const STORE = "pending";

export type QueuedKind = "issue" | "receipt";

export interface QueuedTxn {
  /** Also the `client_txn_uuid` sent to the server. */
  id: string;
  kind: QueuedKind;
  body: Record<string, unknown>;
  /** For showing the operator what is still pending. */
  itemCode: string;
  qty: string;
  queuedAt: number;
  attempts: number;
  lastError?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = fn(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

export function newTxnId(): string {
  // crypto.randomUUID needs a secure context. A store terminal on plain HTTP
  // over the LAN is a real deployment, so fall back rather than break there.
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function enqueue(txn: QueuedTxn): Promise<void> {
  await tx("readwrite", (store) => store.put(txn));
}

export async function list(): Promise<QueuedTxn[]> {
  const all = await tx<QueuedTxn[]>("readonly", (store) => store.getAll());
  return all.sort((a, b) => a.queuedAt - b.queuedAt);
}

export async function remove(id: string): Promise<void> {
  await tx("readwrite", (store) => store.delete(id));
}

export async function count(): Promise<number> {
  return tx<number>("readonly", (store) => store.count());
}

export async function markFailed(txn: QueuedTxn, error: string): Promise<void> {
  await enqueue({ ...txn, attempts: txn.attempts + 1, lastError: error });
}

export interface FlushResult {
  sent: number;
  /** Rows the server refused outright — they will never succeed on retry. */
  rejected: QueuedTxn[];
  remaining: number;
}

/**
 * Try to send everything queued, oldest first.
 *
 * `send` should throw `OfflineError` when the request never reached the server
 * (keep the row and try again later) and `ApiError` when the server answered
 * with a refusal.
 *
 * A refusal is dropped from the queue rather than retried forever: a `409` on
 * an issue means the bin really is short, and re-sending it every thirty
 * seconds for a week helps nobody. The operator is shown what was dropped, so
 * it is a visible outcome rather than a silent loss.
 *
 * Flushing stops at the first row that could not reach the server — sending
 * later rows past a stuck one would reorder the shop's history for no benefit.
 */
export async function flush(
  send: (txn: QueuedTxn) => Promise<void>,
  isOffline: (err: unknown) => boolean,
): Promise<FlushResult> {
  const queued = await list();
  const rejected: QueuedTxn[] = [];
  let sent = 0;

  for (const txn of queued) {
    try {
      await send(txn);
      await remove(txn.id);
      sent += 1;
    } catch (err) {
      if (isOffline(err)) {
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      await remove(txn.id);
      rejected.push({ ...txn, lastError: message });
    }
  }

  return { sent, rejected, remaining: await count() };
}
