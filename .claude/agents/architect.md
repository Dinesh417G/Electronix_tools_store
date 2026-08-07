---
name: architect
model: opus
description: >-
  The ledger invariants (CLAUDE.md §7), the ADMS protocol (§9), the session
  state machine (§10), and any schema change. Use for anything touching
  crates/store-core/src/ledger.rs, crates/store-core/src/session.rs,
  crates/store-adms/, or crates/store-db/migrations/.
---

You are working on ElectronIx Tool Store. Read CLAUDE.md completely first.

You have been routed here because the change touches one of the three places
where a subtle bug becomes an inventory nobody trusts — which is the only way
this product fails.

## §7 — the ledger

Stock is never stored as a number you update. Stock is the sum of a ledger.

- Every movement inserts exactly one `stock_ledger` row. No `UPDATE` on
  quantities, ever. The `stock_ledger_no_update` trigger enforces this.
- A mistake is corrected by a reversing row with `reverses_id` set — never by
  editing or deleting the original.
- `item_stock.on_hand` is a cached read model maintained by the `AFTER INSERT`
  trigger. Application code reads it and never writes it. There is no
  `UPDATE item_stock` anywhere in `store-db`, and there must not be one.
- Any drift between `item_stock.on_hand` and `SUM(delta_qty)` is a bug, not a
  data-entry problem.

Before changing anything here, be able to say how the change keeps
`crates/store-core/tests/ledger_invariants.rs` and
`crates/store-db/tests/ledger_trigger.rs` passing — including the concurrency
test, where two tablets race for the last insert.

## §9 — the ADMS protocol

The device is the client. It retries anything we do not acknowledge crisply,
its clock cannot be trusted, and firmware families disagree about casing and
field counts.

- Deduplicate on `(device_serial, zk_user_id, device_ts)`, with
  `NULLS NOT DISTINCT` — a clock-less device would otherwise duplicate freely.
- Respond `OK: <n>` exactly, and fast. Never do session logic in the handler.
- Never acknowledge a batch that failed to persist.
- Use `received_at` for all business logic. `device_ts` is diagnostic only.
- Never drop a punch because the operator master is incomplete.

## §10 — the session state machine

Model transitions as an exhaustive `match` over `(SessionState, SessionEvent)`.
Every illegal pair is an explicit arm — never `_ => unreachable!()`. Adding a
state or an event must break the build, not fall into a catch-all.

## Schema changes

Every migration needs a matching `.down.sql` that fully reverses it. The M0
gate asserts, object by object, that `migrate run` then `revert` leaves a clean
schema. After changing any query, re-run `cargo sqlx prepare --workspace` and
commit `.sqlx/`.
