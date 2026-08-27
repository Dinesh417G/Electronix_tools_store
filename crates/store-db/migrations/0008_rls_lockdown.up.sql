-- Close PostgREST. Every table in this schema is reachable with a key that is
-- designed to be published, and none of them should be.
--
-- What was actually true before this migration, verified against the live
-- Supabase project rather than assumed:
--
--   GET  /rest/v1/operators    → returned the ADMIN row including pin_hash
--   GET  /rest/v1/stock_ledger → returned ledger rows
--   POST /rest/v1/items        → 201. It inserted.
--
-- The publishable key is not a secret — it is meant to sit in a browser — so
-- "nobody has leaked it yet" is not a control. On a Supabase project the only
-- thing standing between that key and the tables is RLS, and this schema was
-- written for a Postgres nobody could reach except our own server. It moved to
-- a database with an HTTP front door attached and the assumption came with it.
--
-- Why this matters more here than the usual "enable RLS" advisory:
--
--   §7 says stock is the sum of an append-only ledger, that every movement is
--   attributed to an operator, and that an ISSUE past zero is refused. All
--   three are enforced by the application and by triggers reached through it.
--   A direct INSERT into stock_ledger over PostgREST satisfies the triggers —
--   item_stock is dutifully recalculated — while bypassing the negative-stock
--   guard's context, the session binding and the operator attribution that
--   make the ledger evidence. The audit trail would still balance. It would
--   just no longer be true.
--
--   And operators.pin_hash is argon2 over a four-digit PIN. Reading it is
--   equivalent to reading the PIN, given an afternoon.
--
-- Why this is safe for both implementations, and why it needs no policies:
--
--   RLS applies to a table's owner only when FORCE ROW LEVEL SECURITY is set,
--   and it never applies to a role with BYPASSRLS. On Supabase the tables are
--   owned by `postgres`, which also has BYPASSRLS, and that is the role behind
--   DATABASE_URL — so cloud/ sees no change whatsoever. The Rust reference
--   implementation connects as the database owner too, and has no PostgREST in
--   front of it at all, so this is inert there. Deliberately NOT forced: the
--   point is to remove the HTTP path, not to constrain our own server.
--
--   No policies are added on purpose. A table with RLS on and no policy denies
--   everything to anon and authenticated, which is exactly the intent. Adding
--   a policy would be re-opening the door a crack, and nothing in this system
--   talks to the database through supabase-js.
--
-- If a table is added in a later migration, it needs its own line here-equivalent
-- in that migration. There is no default that turns this on.

alter table operators            enable row level security;
alter table item_categories      enable row level security;
alter table items                enable row level security;
alter table item_barcodes        enable row level security;
alter table machines             enable row level security;
alter table reason_codes         enable row level security;
alter table devices              enable row level security;
alter table punches              enable row level security;
alter table sessions             enable row level security;
alter table stock_ledger         enable row level security;
alter table item_stock           enable row level security;
alter table stock_alerts         enable row level security;
alter table tablets              enable row level security;
alter table api_tokens           enable row level security;
alter table serial_settings      enable row level security;
alter table tool_serials         enable row level security;
alter table printer_settings     enable row level security;
alter table print_jobs           enable row level security;
alter table webauthn_credentials enable row level security;
alter table webauthn_challenges  enable row level security;
