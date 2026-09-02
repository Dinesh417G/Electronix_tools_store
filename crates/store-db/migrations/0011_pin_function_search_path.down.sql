-- Back to a mutable search_path, which is what M0's gate asks of a down
-- migration: leave the schema as it was found.
do $$
declare
  target text := current_schema();
  fn record;
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
    execute format('alter function %s reset search_path', fn.signature);
  end loop;
end $$;
