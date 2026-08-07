drop trigger if exists items_reevaluate_alert_on_reorder_change on items;
drop trigger if exists items_create_stock_row on items;
drop trigger if exists stock_ledger_maintain_item_stock on stock_ledger;
drop trigger if exists stock_ledger_no_update on stock_ledger;

drop function if exists items_after_reorder_level_change();
drop function if exists items_after_insert();
drop function if exists stock_ledger_after_insert();
drop function if exists stock_ledger_is_append_only();
drop function if exists sync_stock_alert(uuid, text, text);
drop function if exists evaluate_alert_level(numeric, numeric);

drop table if exists stock_alerts;
drop table if exists item_stock;
drop table if exists stock_ledger;
