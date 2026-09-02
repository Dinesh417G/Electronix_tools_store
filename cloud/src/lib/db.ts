// Postgres access.
//
// The connection is created on first query, never at module load. Next
// evaluates route modules while collecting build configuration, with none of
// the deployment's environment present — connecting eagerly there fails the
// build for a database the build never needed to touch.
//
// One connection per lambda instance, reused across invocations. `prepare:
// false` is not optional against Supabase's pooler: in transaction pooling mode
// prepared statements are not shared between checkouts, and postgres.js will
// otherwise fail on its second query with "prepared statement already exists".

import postgres, { type Sql } from "postgres";
import { QueryDeadlineError } from "./api-error.ts";

declare global {
  var __toolCribSql: Sql | undefined;
}

/**
 * How long this process will wait on a query before deciding the connection is
 * not coming back.
 *
 * Deliberately **above** `statement_timeout` (15 s below), because it is not a
 * second copy of it. Postgres reports what it can see: a query it is executing
 * dies at 15 s as 57014, and 503 goes back to the terminal. This number exists
 * for the failure Postgres cannot see at all.
 *
 * On 2026-08-31 the console's Door screen showed "did not answer within 25.2s"
 * and then, worse, an empty terminal list. `pg_stat_activity` on the live
 * database explained both:
 *
 *   state   wait_event   xact_age   query
 *   active  ClientRead   00:04:55   select t.id, t.kind … from api_tokens t …
 *
 * `active` with `ClientRead` means the backend has our statement and is waiting
 * for *us* to send the rest of the protocol exchange. It is not executing, so
 * `statement_timeout` never counts; it is not `idle in transaction`, so
 * `idle_in_transaction_session_timeout` never counts either. Both bounds this
 * file added after the 2026-08-28 outage are blind to it by construction.
 *
 * With `max: 1` that one socket is the instance's only connection, so every
 * later request queued behind a conversation neither side would ever continue,
 * until Vercel killed the function at 300 s. The instance stayed poisoned for
 * its whole life, which is why Refresh never helped: a retry landing on the
 * same warm instance found the same dead socket.
 *
 * So: wait longer than any bound the database owns, then stop waiting and
 * throw the connection away.
 */
export const DB_DEADLINE_MS = 20_000;

/**
 * Drop the shared connection so the next caller builds a fresh one.
 *
 * Unconditional, not "if it looks broken": we only get here because a query
 * outlived every database-side bound, and there is no state in which that
 * socket is still worth keeping. Closing it also releases the backend parked on
 * `ClientRead`, which otherwise sits there holding an open transaction until
 * the platform kills us.
 */
export function discardConnection(): void {
  const wedged = globalThis.__toolCribSql;
  globalThis.__toolCribSql = undefined;
  // `timeout: 0` destroys rather than draining. Draining is exactly what is
  // not going to happen here.
  void wedged?.end({ timeout: 0 }).catch(() => {});
}

/**
 * Race `work` against the deadline, throwing the connection away if it wins.
 *
 * Used by `handler()` on every route. It is exported from this file rather
 * than written there because the number and the connection it discards both
 * belong to the database, and a second copy of either is how they drift apart.
 */
export function withDbDeadline<T>(work: PromiseLike<T>, what: string): Promise<T> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      discardConnection();
      reject(new QueryDeadlineError(what, Date.now() - startedAt));
    }, DB_DEADLINE_MS);
  });

  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Which Postgres schema this deployment reads and writes.
 *
 * Unset in production, where the role's own default search_path is what it has
 * always been. Preview deployments set it to `preview` — a schema in the same
 * database carrying the same migrations, because the free tier allows two
 * active projects and both are spoken for. Without it a preview deployment has
 * no database at all, so every database-backed route 500s there and a preview
 * proves only that the UI renders.
 *
 * The name is interpolated into a startup parameter, so it is checked against
 * the shape of an unquoted identifier rather than trusted.
 */
function schemaFromEnv(): string | undefined {
  const schema = process.env.DATABASE_SCHEMA?.trim();
  if (!schema) return undefined;
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(
      `DATABASE_SCHEMA must be a lowercase unquoted identifier, got ${JSON.stringify(schema)}.`,
    );
  }
  return schema;
}

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Supabase → Settings → Database → Connection string.",
    );
  }

  const schema = schemaFromEnv();

  return postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    // A connection that outlives a pooler restart is a socket this process
    // still believes in and nothing is listening to. Retiring them on a clock
    // means the damage from one is bounded by this number rather than by how
    // long the instance happens to stay warm.
    max_lifetime: 60 * 10,
    // Nothing above this line bounds a *query*. `connect_timeout` covers
    // opening a connection, not waiting on one already open, and on
    // 2026-08-28 that distinction cost the deployment its core loop: Supabase
    // reloaded its configuration at 15:34:03 and reset the connections under
    // us, after which every `POST /api/v1/txn/issue` hung until Vercel killed
    // the function at 300 s. The terminal showed "Saving…" for five minutes
    // and the ledger stayed empty. Supavisor's own log named it exactly —
    // "Client socket closed while state was idle (transaction)".
    //
    // The database's defaults do not save us either. `statement_timeout` on
    // this role is the 2 min database default, and `lock_timeout` is unset, so
    // a row-lock wait is bounded only by that two minutes. Supabase gives its
    // own `authenticator` role 8 s of each; the role behind DATABASE_URL gets
    // neither.
    //
    // So bound them here, where they apply to every query both the routes and
    // the scripts make. Each is far longer than any query this app has a right
    // to run — a lookup's budget is 100 ms (§11) — and far shorter than the
    // platform's patience. A slow query now fails as a mapped error the
    // terminal can show and the outbox can retry (§12), instead of a spinner
    // that ends when the function is killed.
    connection: {
      statement_timeout: 15_000,
      lock_timeout: 5_000,
      // The state Supavisor logged. A transaction that opens and then stops
      // being driven holds row locks the rest of the shop queues behind.
      idle_in_transaction_session_timeout: 15_000,
      // `public` is not decoration on this list. Migration 0001 runs
      // `create extension if not exists pg_trgm` with no schema, so the
      // extension lands in `public` on every database these migrations have
      // built — checked on Supabase and on the local Docker Postgres, both of
      // which report `pg_trgm -> public`. Take `public` off this path and
      // `gin_trgm_ops` stops resolving, which takes §11's typeahead with it.
      // `extensions` is where Supabase puts the rest (pgcrypto, uuid-ossp).
      ...(schema ? { search_path: `${schema}, public, extensions` } : {}),
    },
    // Numerics come back as strings on purpose. Quantities are numeric(12,3)
    // and money is numeric(12,2); routing either through a float would put
    // rounding error into a ledger whose whole point is that it adds up.
    types: {},
  });
}

function client(): Sql {
  if (!globalThis.__toolCribSql) {
    globalThis.__toolCribSql = connect();
  }
  return globalThis.__toolCribSql;
}

/**
 * Tagged-template entry point, indistinguishable from postgres.js's own — the
 * proxy forwards the call and every property (`.begin`, `.unsafe`, `.json`…)
 * to a client built on first use.
 *
 * Nothing is wrapped here, and that is a correction rather than an omission.
 * The deadline was tried at this layer first and broke the app immediately:
 * a query object is not only a promise, it is also postgres.js's **fragment**,
 * and `items.ts` composes with it — `sql\`${select()} where i.id = ${id}\``.
 * Returning a real promise from the call turns that fragment into a bound
 * parameter, and Postgres answers `syntax error at or near "$1"`. So the bound
 * lives one layer out, in `handler()`, where a request is a request and no
 * driver protocol runs through it.
 */
export const sql: Sql = new Proxy(function noop() {} as unknown as Sql, {
  apply(_target, _thisArg, args: Parameters<Sql>) {
    return (client() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, property, receiver) {
    return Reflect.get(client() as object, property, receiver);
  },
}) as Sql;
