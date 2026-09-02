-- Pin `search_path` on the eight functions that enforce §7.
--
-- What was true before this migration, verified against the live Supabase
-- project rather than assumed:
--
--   public.stock_ledger_after_insert          proconfig = null
--   public.stock_ledger_is_append_only        proconfig = null
--   public.evaluate_alert_level               proconfig = null
--   public.sync_stock_alert                   proconfig = null
--   public.items_after_insert                 proconfig = null
--   public.items_after_reorder_level_change   proconfig = null
--   public.next_tool_serial                   proconfig = null
--   public.set_updated_at                     proconfig = null
--
-- while the same eight functions in the `preview` schema were all pinned to
-- `preview, public, extensions`. The copies were made by hand during the cloud
-- port and someone pinned them there; the migrations that create them never
-- did, so the schema of record was the unpinned one.
--
-- ── Why this matters here specifically ──────────────────────────────────
--
-- The bodies of these functions name `items`, `item_stock` and `stock_alerts`
-- without a schema, so they resolve against the **caller's** `search_path`,
-- not the function's own. §7 says `item_stock.on_hand` is a cached read model
-- maintained by a trigger and that application code only ever reads it — and
-- the trigger deciding *which schema's* read model to maintain based on who
-- called it is a way for that to be quietly untrue.
--
-- This is not hypothetical on this deployment. `cloud/src/lib/db.ts` sets
-- `search_path` from `DATABASE_SCHEMA` so preview deployments run against the
-- `preview` schema in the same database as production. A session whose path is
-- `preview, public` that inserts into `public.stock_ledger` — a psql window, a
-- script pointed at the wrong variable, the Rust CLI with a search_path set —
-- gets its ledger row in `public` and its `item_stock` update in `preview`.
-- Both tables satisfy their constraints. Both triggers fire. The ledger and
-- the read model it is supposed to summarise now disagree, in two schemas at
-- once, and `reconcile` is the only thing that would ever say so.
--
-- None of the eight is SECURITY DEFINER, so this is not the privilege
-- escalation the Supabase advisor's `function_search_path_mutable` warning
-- usually means. It is the same root cause pointed at the invariant instead of
-- at permissions, which for this product is worse.
--
-- ── Why it is written this way ──────────────────────────────────────────
--
-- `current_schema()` rather than a literal `public`: this file is applied
-- verbatim into the `preview` schema too, and a pin that names the wrong
-- schema is worse than no pin at all. Signatures come from `pg_proc` because
-- two of the eight take arguments and `alter function` needs them.
--
-- `pg_temp` last, deliberately. A schema left off the list is not searched at
-- all, but `pg_temp` is searched *first* unless it appears explicitly — so
-- listing it last is what stops a temporary table shadowing `items`.

do $$
declare
  target text := current_schema();
  fn record;
  pinned int := 0;
begin
  for fn in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = target
       and p.proname in (
         'set_updated_at',
         'stock_ledger_after_insert',
         'stock_ledger_is_append_only',
         'evaluate_alert_level',
         'sync_stock_alert',
         'items_after_insert',
         'items_after_reorder_level_change',
         'next_tool_serial'
       )
  loop
    -- `public` is in the list for the extensions that live there — pg_trgm is
    -- in `public` on this project, whatever the Supabase default is — but not
    -- twice when it is already the target.
    execute format(
      'alter function %s set search_path = %s',
      fn.signature,
      case when target = 'public' then 'public, pg_temp'
           else format('%I, public, pg_temp', target) end);
    pinned := pinned + 1;
  end loop;

  -- A migration that silently pins nothing is how this comes back. The eight
  -- are created by 0003, 0006 and 0009, all of which run before this file.
  if pinned <> 8 then
    raise exception 'expected to pin 8 functions in %, pinned %', target, pinned;
  end if;
end $$;
