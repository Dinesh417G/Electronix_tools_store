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

declare global {
  // eslint-disable-next-line no-var
  var __toolCribSql: Sql | undefined;
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
      // `public` stays on the path so a preview still reaches anything shared,
      // and `extensions` because Supabase installs pg_trgm there and the
      // catalog's trigram indexes are built on its operator class.
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
 */
export const sql: Sql = new Proxy(function noop() {} as unknown as Sql, {
  apply(_target, _thisArg, args: Parameters<Sql>) {
    return (client() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_target, property, receiver) {
    return Reflect.get(client() as object, property, receiver);
  },
}) as Sql;
