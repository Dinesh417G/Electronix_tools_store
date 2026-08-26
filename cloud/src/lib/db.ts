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

function connect(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Supabase → Settings → Database → Connection string.",
    );
  }

  return postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
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
