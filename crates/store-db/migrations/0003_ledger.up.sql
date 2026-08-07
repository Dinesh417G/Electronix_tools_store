-- The stock ledger and its derived read model (CLAUDE.md §7).
--
--   Stock is never stored as a number you update. Stock is the sum of a ledger.
--
-- Everything below exists to make that structurally true rather than merely
-- intended: there is no mutable quantity column anywhere, `item_stock` is
-- maintained only by trigger, and application code has no path to write it.

-- ── The ledger. Append only. ────────────────────────────────────────────
create table stock_ledger (
  id           bigserial primary key,
  item_id      uuid not null references items (id) on delete restrict,
  -- Negative = out, positive = in. Never zero.
  delta_qty    numeric(12, 3) not null check (delta_qty <> 0),
  txn_type     text not null check (txn_type in ('ISSUE', 'RECEIPT', 'ADJUST', 'OPENING', 'SCRAP')),
  -- §11: every write carries an operator. There are no anonymous ledger rows.
  operator_id  uuid not null references operators (id) on delete restrict,
  -- Null for admin-side adjustments, which happen outside any door session.
  session_id   uuid references sessions (id) on delete restrict,
  machine_id   uuid references machines (id) on delete restrict,
  reason_id    uuid references reason_codes (id) on delete restrict,
  note         text,
  -- Snapshot at transaction time. Valuing last year's consumption at today's
  -- price would quietly rewrite last year's reports.
  unit_cost    numeric(12, 2) check (unit_cost is null or unit_cost >= 0),
  device_ts    timestamptz,
  created_at   timestamptz not null default now(),
  -- Set on a correction row, pointing at the row being undone (§7). A mistake
  -- is corrected by inserting the mirror image, never by editing or deleting.
  reverses_id  bigint references stock_ledger (id) on delete restrict,
  -- §12: the tablet's offline outbox generates this before it can reach the
  -- server, so a replayed queue deduplicates instead of double-booking.
  client_txn_uuid uuid unique,

  -- Sign rules, from store-core's TxnType::sign_rule(). A reversal legitimately
  -- runs against its type's rule — undoing an ISSUE puts stock back — so it is
  -- exempt.
  constraint stock_ledger_sign_matches_type check (
    reverses_id is not null
    or (txn_type in ('ISSUE', 'SCRAP') and delta_qty < 0)
    or (txn_type in ('RECEIPT', 'OPENING') and delta_qty > 0)
    or txn_type = 'ADJUST'
  ),
  -- A row cannot undo itself.
  constraint stock_ledger_no_self_reversal check (reverses_id is distinct from id)
);

create index stock_ledger_item_created on stock_ledger (item_id, created_at desc);
create index stock_ledger_created on stock_ledger (created_at desc);
create index stock_ledger_operator on stock_ledger (operator_id, created_at desc);
create index stock_ledger_machine on stock_ledger (machine_id, created_at desc)
  where machine_id is not null;
create index stock_ledger_session on stock_ledger (session_id)
  where session_id is not null;
-- At most one reversal per original row: a correction applied twice would
-- silently double-count.
create unique index stock_ledger_one_reversal_per_row
  on stock_ledger (reverses_id) where reverses_id is not null;

-- Append-only, enforced. This is the structural half of §7 — without it, the
-- rule is a convention that survives exactly as long as everyone remembers it.
create or replace function stock_ledger_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception
    'stock_ledger is append-only (CLAUDE.md §7); correct a mistake with a reversing row'
    using errcode = 'EL003';
end;
$$;

create trigger stock_ledger_no_update
  before update or delete on stock_ledger
  for each row execute function stock_ledger_is_append_only();

-- ── Derived read model. Never written by application code. ──────────────
create table item_stock (
  item_id     uuid primary key references items (id) on delete cascade,
  on_hand     numeric(12, 3) not null default 0,
  last_txn_at timestamptz,
  alert_state text not null default 'OK' check (alert_state in ('OK', 'LOW', 'EMPTY'))
);

create index item_stock_alert_state on item_stock (alert_state)
  where alert_state <> 'OK';

-- ── Alerts ──────────────────────────────────────────────────────────────
create table stock_alerts (
  id              uuid primary key default gen_random_uuid(),
  item_id         uuid not null references items (id) on delete cascade,
  level           text not null check (level in ('LOW', 'EMPTY')),
  raised_at       timestamptz not null default now(),
  resolved_at     timestamptz,
  acknowledged_at timestamptz,
  acknowledged_by uuid references operators (id) on delete set null,

  constraint stock_alerts_ack_has_actor check (
    (acknowledged_at is null) = (acknowledged_by is null)
  )
);

-- One open alert per item at a time. An item cannot be both LOW and EMPTY, and
-- a dashboard listing the same shortage twice is a dashboard nobody trusts.
create unique index stock_alerts_one_open_per_item
  on stock_alerts (item_id) where resolved_at is null;

create index stock_alerts_open on stock_alerts (raised_at desc) where resolved_at is null;

-- ── The rules, in one place ─────────────────────────────────────────────

-- Mirror of store-core's alert::evaluate(). Two rules worth restating:
-- EMPTY wins over LOW and is decided by on-hand alone; a reorder_level of zero
-- disables the LOW band rather than making every item permanently low.
create or replace function evaluate_alert_level(
  p_on_hand       numeric,
  p_reorder_level numeric
) returns text
language sql immutable as $$
  select case
    when p_on_hand <= 0 then 'EMPTY'
    when p_reorder_level > 0 and p_on_hand <= p_reorder_level then 'LOW'
    else 'OK'
  end;
$$;

-- Open, escalate or resolve the alert row for an item after its level moved.
create or replace function sync_stock_alert(
  p_item_id    uuid,
  p_prev_level text,
  p_next_level text
) returns void
language plpgsql as $$
begin
  if p_prev_level is not distinct from p_next_level then
    return;
  end if;

  -- Any move out of the previous level closes the row that described it.
  if p_prev_level <> 'OK' then
    update stock_alerts
       set resolved_at = now()
     where item_id = p_item_id and resolved_at is null;
  end if;

  if p_next_level <> 'OK' then
    insert into stock_alerts (item_id, level) values (p_item_id, p_next_level);
  end if;
end;
$$;

-- The single place stock changes.
create or replace function stock_ledger_after_insert() returns trigger
language plpgsql as $$
declare
  v_reorder_level  numeric(12, 3);
  v_allow_negative boolean;
  v_on_hand        numeric(12, 3);
  v_prev_level     text;
  v_next_level     text;
begin
  select i.reorder_level, i.allow_negative
    into v_reorder_level, v_allow_negative
    from items i
   where i.id = new.item_id
     for share;

  if not found then
    raise exception 'stock_ledger row references unknown item %', new.item_id
      using errcode = 'EL404';
  end if;

  -- The upsert takes a row lock on item_stock, which serialises concurrent
  -- ledger inserts for the same item. That lock is precisely what makes the
  -- guard below safe when two tablets issue the last insert simultaneously:
  -- the second transaction blocks here, then re-reads the balance the first
  -- one left.
  insert into item_stock as s (item_id, on_hand, last_txn_at, alert_state)
  values (new.item_id, new.delta_qty, new.created_at,
          evaluate_alert_level(new.delta_qty, v_reorder_level))
  on conflict (item_id) do update
     set on_hand     = s.on_hand + excluded.on_hand,
         last_txn_at = greatest(s.last_txn_at, excluded.last_txn_at)
  returning s.on_hand, s.alert_state into v_on_hand, v_prev_level;

  -- §7's guard. Raising here rolls the insert back, so a refused ISSUE leaves
  -- no trace in the ledger — which is what makes "the ledger is what happened"
  -- true rather than "the ledger is what was attempted".
  if v_on_hand < 0 and not v_allow_negative and new.delta_qty < 0 then
    raise exception
      'insufficient stock for item %: % on hand, % requested',
      new.item_id, v_on_hand - new.delta_qty, -new.delta_qty
      using errcode = 'EL001';
  end if;

  v_next_level := evaluate_alert_level(v_on_hand, v_reorder_level);

  if v_next_level is distinct from v_prev_level then
    update item_stock set alert_state = v_next_level where item_id = new.item_id;
    perform sync_stock_alert(new.item_id, v_prev_level, v_next_level);
  end if;

  return null;
end;
$$;

create trigger stock_ledger_maintain_item_stock
  after insert on stock_ledger
  for each row execute function stock_ledger_after_insert();

-- Every item gets a stock row at birth, so an item that has never moved still
-- appears on the stock views at zero instead of vanishing from them.
--
-- Note it does *not* raise an alert row: an alert is raised by a movement
-- crossing a threshold, and creating a catalog entry is not a movement.
-- Bulk-loading a catalog should not hand the storekeeper 500 alerts.
create or replace function items_after_insert() returns trigger
language plpgsql as $$
begin
  insert into item_stock (item_id, on_hand, alert_state)
  values (new.id, 0, evaluate_alert_level(0, new.reorder_level))
  on conflict (item_id) do nothing;
  return null;
end;
$$;

create trigger items_create_stock_row
  after insert on items
  for each row execute function items_after_insert();

-- Raising or lowering a reorder level changes what "low" means. Without this,
-- a policy change would only surface on the item's next movement — which for a
-- slow-moving item could be months.
create or replace function items_after_reorder_level_change() returns trigger
language plpgsql as $$
declare
  v_on_hand    numeric(12, 3);
  v_prev_level text;
  v_next_level text;
begin
  select s.on_hand, s.alert_state into v_on_hand, v_prev_level
    from item_stock s where s.item_id = new.id for update;

  if not found then
    return null;
  end if;

  v_next_level := evaluate_alert_level(v_on_hand, new.reorder_level);

  if v_next_level is distinct from v_prev_level then
    update item_stock set alert_state = v_next_level where item_id = new.id;
    perform sync_stock_alert(new.id, v_prev_level, v_next_level);
  end if;

  return null;
end;
$$;

create trigger items_reevaluate_alert_on_reorder_change
  after update of reorder_level on items
  for each row when (old.reorder_level is distinct from new.reorder_level)
  execute function items_after_reorder_level_change();
