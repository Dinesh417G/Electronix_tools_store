// What the terminal says when the server never answered.
//
// On 2026-08-29 a screenshot arrived showing the admin console reading "The
// store server is not reachable." beside a terminal stuck on "Checking…". The
// deployment was healthy in that same minute — 5/5 manual sign-ins at ~190 ms,
// 60/60 lookups at a p95 of 179 ms, from the same machine — and the picture
// could not settle what had happened, because one sentence stood for three
// different faults: a device with no network, our own deadline firing, and a
// connection that dropped part-way.
//
// So this pins the distinction, and two policies that ride along with it:
//
//   - **A write is never retried.** A POST that threw may still have been
//     received and committed; §7 does not allow a second ledger row on a
//     guess. That is what the outbox and `client_txn_uuid` are for.
//   - **A device that is off the air is not retried either**, however cheap
//     the request — there is nothing to reach.
//
// No database, no browser, no server. `fetch` and `navigator` are stubbed,
// because what is under test is our classification and our retry policy, not
// the platform's implementation of `AbortSignal.timeout`.
//
//   node --experimental-strip-types tests/offline-classify.mjs

import {
  OfflineError,
  READ_TIMEOUT_MS,
  WRITE_TIMEOUT_MS,
  classifyOffline,
  fetchOrThrow,
  isRetryable,
  offlineMessage,
  timeoutFor,
} from "../src/lib/offline.ts";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

// ── Stubs ───────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** Replace `navigator.onLine` for one call, then put the global back. */
async function withOnline(online, fn) {
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine: online },
    configurable: true,
    writable: true,
  });
  try {
    return await fn();
  } finally {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else delete globalThis.navigator;
  }
}

/** A `fetch` that always throws `err`, counting how many times it was called. */
function throwingFetch(err) {
  const calls = { n: 0, signals: [] };
  globalThis.fetch = async (_path, init) => {
    calls.n += 1;
    calls.signals.push(init?.signal);
    throw err;
  };
  return calls;
}

const timeoutError = () => new DOMException("The operation timed out.", "TimeoutError");
const abortError = () => new DOMException("The operation was aborted.", "AbortError");
const networkError = () => new TypeError("Failed to fetch");

// ── 1. Classification ───────────────────────────────────────────────────

check("offline device beats every cause", () => {
  equal(classifyOffline(timeoutError(), false), "device-offline", "reason");
  equal(classifyOffline(networkError(), false), "device-offline", "reason");
  equal(classifyOffline(undefined, false), "device-offline", "reason");
});

check("our deadline is a timeout", () => {
  equal(classifyOffline(timeoutError(), true), "timeout", "TimeoutError");
  equal(classifyOffline(abortError(), true), "timeout", "AbortError");
});

check("anything else is a network fault", () => {
  equal(classifyOffline(networkError(), true), "network", "TypeError");
  equal(classifyOffline(undefined, true), "network", "no cause");
  equal(classifyOffline("a string", true), "network", "non-object cause");
});

// ── 2. The sentence on the screen ───────────────────────────────────────
//
// A photograph of the screen is the only diagnostic that reliably reaches us
// from a shop floor, so the wait has to be legible in it.

check("three faults, three different sentences", () => {
  const messages = new Set([
    offlineMessage("device-offline", 120),
    offlineMessage("timeout", 8_000),
    offlineMessage("network", 3_400),
  ]);
  equal(messages.size, 3, "distinct messages");
});

check("the wait is on the screen", () => {
  assert(offlineMessage("timeout", 8_000).includes("8.0s"), "timeout names the seconds");
  assert(offlineMessage("network", 3_400).includes("3.4s"), "network names the seconds");
});

check("a device with no network is not told a number it cannot use", () => {
  const message = offlineMessage("device-offline", 120);
  assert(!/\d/.test(message), `no digits expected, got: ${message}`);
  assert(/device/i.test(message), `should name the device, got: ${message}`);
});

// ── 3. The budgets ──────────────────────────────────────────────────────

check("reads are retried, writes are not", () => {
  assert(isRetryable("GET"), "GET");
  assert(isRetryable("head"), "head, lowercased");
  assert(!isRetryable("POST"), "POST");
  assert(!isRetryable("PATCH"), "PATCH");
  assert(!isRetryable("DELETE"), "DELETE");
});

check("a write gets longer than a read", () => {
  equal(timeoutFor("GET"), READ_TIMEOUT_MS, "read budget");
  equal(timeoutFor("POST"), WRITE_TIMEOUT_MS, "write budget");
  assert(WRITE_TIMEOUT_MS > READ_TIMEOUT_MS, "write budget exceeds read budget");
  // Far below the platform's 300 s cap — the whole point of putting a number
  // here rather than inheriting one from a cloud.
  assert(WRITE_TIMEOUT_MS < 300_000, "write budget below the platform cap");
});

// ── 4. The error the screens actually receive ───────────────────────────

check("OfflineError carries why, how long, and how many tries", () => {
  const err = new OfflineError(timeoutError(), { waitedMs: 8_012, attempts: 1, online: true });
  assert(err instanceof Error, "is an Error");
  equal(err.name, "OfflineError", "name");
  equal(err.reason, "timeout", "reason");
  equal(err.waitedMs, 8_012, "waitedMs");
  equal(err.attempts, 1, "attempts");
  assert(err.isTimeout, "isTimeout");
  assert(!err.isDeviceOffline, "not device-offline");
  assert(err.message.includes("8.0s"), `message names the wait: ${err.message}`);
});

check("a device with no network says so", () => {
  const err = new OfflineError(networkError(), { waitedMs: 30, online: false });
  equal(err.reason, "device-offline", "reason");
  assert(err.isDeviceOffline, "isDeviceOffline");
});

// ── 5. The retry policy, driven ─────────────────────────────────────────

await checkAsync("a read is attempted three times", async () => {
  const calls = throwingFetch(networkError());
  const err = await withOnline(true, async () => {
    try {
      await fetchOrThrow("/api/v1/items/lookup?barcode=X");
      throw new Error("expected a throw");
    } catch (caught) {
      return caught;
    }
  });
  assert(err instanceof OfflineError, `expected OfflineError, got ${err?.name}`);
  equal(calls.n, 3, "fetch calls");
  equal(err.attempts, 3, "reported attempts");
  equal(err.reason, "network", "reason");
});

await checkAsync("a write is attempted once, whatever happens (§7)", async () => {
  const calls = throwingFetch(networkError());
  const err = await withOnline(true, async () => {
    try {
      await fetchOrThrow("/api/v1/txn/issue", { method: "POST", body: "{}" });
      throw new Error("expected a throw");
    } catch (caught) {
      return caught;
    }
  });
  assert(err instanceof OfflineError, `expected OfflineError, got ${err?.name}`);
  equal(calls.n, 1, "fetch calls — a committed write must not be repeated");
  equal(err.attempts, 1, "reported attempts");
});

await checkAsync("a device off the air is not retried", async () => {
  const calls = throwingFetch(networkError());
  const err = await withOnline(false, async () => {
    try {
      await fetchOrThrow("/api/v1/alerts/summary");
      throw new Error("expected a throw");
    } catch (caught) {
      return caught;
    }
  });
  equal(calls.n, 1, "fetch calls");
  equal(err.reason, "device-offline", "reason");
});

await checkAsync("every attempt carries a deadline", async () => {
  const calls = throwingFetch(timeoutError());
  await withOnline(true, async () => {
    try {
      await fetchOrThrow("/api/v1/stock");
    } catch {
      /* expected */
    }
  });
  assert(calls.signals.length > 0, "at least one attempt");
  for (const signal of calls.signals) {
    assert(signal instanceof AbortSignal, "an AbortSignal was passed to fetch");
  }
});

// Non-vacuity: the happy path must still pass straight through, or every
// assertion above is measuring a function that only ever throws.
await checkAsync("a healthy response is returned untouched", async () => {
  const marker = { ok: true, status: 200 };
  globalThis.fetch = async () => marker;
  const response = await withOnline(true, () => fetchOrThrow("/api/v1/version"));
  assert(response === marker, "the response object is passed through");
});

globalThis.fetch = realFetch;

// ── Report ──────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exit(1);
}

console.log(`offline classification: ${passed} assertions passed`);
