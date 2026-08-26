// Persisting what the door terminal pushed, and turning it into a session
// offer (CLAUDE.md §9, §10).

import { sql } from "./db";
import type { AttlogRecord } from "./adms";

export type SessionOffer =
  | { kind: "OPENED"; sessionId: string; operatorId: string }
  | { kind: "ALREADY_OFFERED"; sessionId: string }
  | { kind: "UNKNOWN_OPERATOR" };

/** A device announces itself by serial; we have never met it before its first push. */
export async function upsertDevice(serial: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into devices (serial_no, last_seen_at)
    values (${serial}, now())
    on conflict (serial_no) do update set last_seen_at = now()
    returning id
  `;
  return rows[0].id;
}

/**
 * Record one punch.
 *
 * §9.1: the device retries on any non-OK response, so a retried batch must be a
 * no-op rather than a second punch. `punches_dedup` is what makes that true —
 * ON CONFLICT DO NOTHING returns no row for a duplicate, and the caller counts
 * it as accepted anyway, because from the device's point of view it was.
 *
 * §9.4: a punch whose user maps to no operator is still recorded. We never drop
 * data because the operator master is incomplete — that is how you end up
 * unable to explain a gap six months later.
 */
export async function recordPunch(
  deviceId: string,
  record: AttlogRecord,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    insert into punches (device_id, zk_user_id, device_ts, verify_mode, raw)
    values (${deviceId}, ${record.userId}, ${record.deviceTs},
            ${record.verifyMode}, ${record.raw})
    on conflict do nothing
    returning id
  `;
  return rows[0]?.id ?? null;
}

/**
 * Offer a session for a punch.
 *
 * The `punch_id` unique constraint means a replayed punch cannot offer a second
 * session, so this is safe — and meaningful — to call more than once.
 */
export async function openFromPunch(punchId: string): Promise<SessionOffer> {
  return sql.begin(async (tx) => {
    const existing = await tx<{ id: string }[]>`
      select id from sessions where punch_id = ${punchId}
    `;
    if (existing[0]) {
      return { kind: "ALREADY_OFFERED", sessionId: existing[0].id } as SessionOffer;
    }

    const operator = await tx<{ id: string }[]>`
      select o.id from punches p
        join operators o on o.zk_user_id = p.zk_user_id and o.active
       where p.id = ${punchId}
    `;
    if (!operator[0]) {
      return { kind: "UNKNOWN_OPERATOR" } as SessionOffer;
    }

    const session = await tx<{ id: string }[]>`
      insert into sessions (operator_id, punch_id, state, manual_identity)
      values (${operator[0].id}, ${punchId}, 'UNCLAIMED', false)
      returning id
    `;

    await tx`update punches set claimed = true where id = ${punchId}`;

    return {
      kind: "OPENED",
      sessionId: session[0].id,
      operatorId: operator[0].id,
    } as SessionOffer;
  }) as Promise<SessionOffer>;
}
