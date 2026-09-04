// PATCH  /api/v1/admin/operators/{id}   edit, including setting or clearing a PIN
// DELETE /api/v1/admin/operators/{id}   deactivate
//
// DELETE deactivates rather than deletes, for the same reason retiring an item
// does: `stock_ledger.operator_id` is NOT NULL and points here, and §7's whole
// claim is that the history can still answer "who took the forty inserts" years
// later. A person who has left is `active = false` — out of the pickers, still
// attached to everything they signed.
//
// Both verbs refuse to remove the last active ADMIN. §11 already notes that the
// first admin cannot come from this API; without this guard the last one can
// leave through it, and then nobody can create the person who would fix that.
//
// The check runs inside the transaction that made the change, and behind an
// advisory lock. **The transaction alone is not enough**, which this comment
// used to claim: two admins demoting *each other* touch two different rows, so
// nothing conflicts, and at READ COMMITTED each counts the other as still
// active until it commits. Both see one admin left, both commit, and the crib
// has none. `crates/store-server/tests/admin_console.rs` proves the same fix on
// the Rust side, by holding the lock and watching both writers wait.

import { NextResponse } from "next/server";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { hashPin, requireRole } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ApiError, handler } from "@/lib/errors";
import { OperatorBody } from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PatchBody = OperatorBody.partial().extend({ active: z.boolean().optional() });

/**
 * The advisory-lock key that serialises every change to who can administer the
 * crib. One arbitrary constant, taken by both verbs before either touches a
 * row.
 *
 * Advisory rather than `select … for update` on the admin rows, because the two
 * writers would acquire their locks in opposite orders — demote A then read B,
 * demote B then read A — which is a deadlock Postgres resolves by aborting one
 * of them. A lock taken *first*, by everyone, cannot be taken out of order. It
 * is held for the transaction, so the commit or the rollback releases it.
 */
const ADMIN_SET_LOCK = 0x454c454354; // "ELECT"

/** Take {@link ADMIN_SET_LOCK} for the rest of the transaction. */
async function lockAdminSet(tx: TransactionSql): Promise<void> {
  await tx`select pg_advisory_xact_lock(${ADMIN_SET_LOCK}::bigint)`;
}

/** Throws if the crib has been left with nobody who can administer it. */
async function refuseIfLastAdminGone(tx: TransactionSql): Promise<void> {
  const [{ admins }] = await tx<{ admins: number }[]>`
    select count(*)::int as admins from operators where active and role = 'ADMIN'
  `;
  if (admins === 0) {
    throw ApiError.conflict(
      "LAST_ADMIN",
      "That would leave the store with no active ADMIN, and the console cannot create one. Promote somebody else first.",
    );
  }
}

export const PATCH = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "ADMIN");
    const { id } = await ctx.params;

    const parsed = PatchBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw ApiError.badRequest("invalid operator", parsed.error.issues);
    const b = parsed.data;

    // Only what was sent. A PATCH that omits `pin` must not clear it, which is
    // the difference between "I renamed somebody" and "I locked them out".
    const updates: Record<string, string | boolean | null> = {};
    if (b.emp_code !== undefined) updates.emp_code = b.emp_code;
    if (b.full_name !== undefined) updates.full_name = b.full_name;
    if (b.role !== undefined) updates.role = b.role;
    if (b.zk_user_id !== undefined) updates.zk_user_id = b.zk_user_id?.trim() || null;
    if (b.department !== undefined) updates.department = b.department?.trim() || null;
    if (b.active !== undefined) updates.active = b.active;
    if (b.pin !== undefined) updates.pin_hash = b.pin === null ? null : await hashPin(b.pin);

    if (Object.keys(updates).length === 0) throw ApiError.badRequest("nothing to update");

    try {
      return NextResponse.json(
        await sql.begin(async (tx) => {
          await lockAdminSet(tx);

          const rows = await tx`
            update operators set ${tx(updates)}
             where id = ${id}
            returning id, emp_code, full_name, role, zk_user_id, department, active,
                      (pin_hash is not null) as has_pin
          `;
          if (!rows[0]) throw ApiError.notFound("no such operator");

          await refuseIfLastAdminGone(tx);

          // Losing the role or the account should not leave a live token behind
          // it. `authenticate` already refuses an inactive operator, so this is
          // belt and braces for the demotion case, where the token is still
          // valid and now carries a role its holder no longer has.
          if (updates.active === false || updates.role !== undefined) {
            await tx`
              update api_tokens set revoked_at = now()
               where operator_id = ${id} and revoked_at is null
            `;
          }

          return rows[0];
        }),
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw ApiError.conflict(
          "OPERATOR_EXISTS",
          "That employee code or terminal user id already belongs to somebody else.",
        );
      }
      throw e;
    }
  },
);

export const DELETE = handler(
  async (request: Request, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(request, "ADMIN");
    const { id } = await ctx.params;

    return NextResponse.json(
      await sql.begin(async (tx) => {
        await lockAdminSet(tx);

        const rows = await tx`
          update operators set active = false
           where id = ${id}
          returning id, emp_code, full_name, role, active
        `;
        if (!rows[0]) throw ApiError.notFound("no such operator");

        await refuseIfLastAdminGone(tx);

        await tx`
          update api_tokens set revoked_at = now()
           where operator_id = ${id} and revoked_at is null
        `;

        return rows[0];
      }),
    );
  },
);
