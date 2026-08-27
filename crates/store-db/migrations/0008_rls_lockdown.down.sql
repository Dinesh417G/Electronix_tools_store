-- Reverting this re-opens PostgREST on every table, including operators.pin_hash
-- and a writable stock_ledger. It exists because M0's gate is `migrate run` then
-- `revert` leaving a clean schema, not because there is a reason to run it.

alter table webauthn_challenges  disable row level security;
alter table webauthn_credentials disable row level security;
alter table print_jobs           disable row level security;
alter table printer_settings     disable row level security;
alter table tool_serials         disable row level security;
alter table serial_settings      disable row level security;
alter table api_tokens           disable row level security;
alter table tablets              disable row level security;
alter table stock_alerts         disable row level security;
alter table item_stock           disable row level security;
alter table stock_ledger         disable row level security;
alter table sessions             disable row level security;
alter table punches              disable row level security;
alter table devices              disable row level security;
alter table reason_codes         disable row level security;
alter table machines             disable row level security;
alter table item_barcodes        disable row level security;
alter table items                disable row level security;
alter table item_categories      disable row level security;
alter table operators            disable row level security;
