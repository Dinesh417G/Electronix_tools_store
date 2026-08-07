-- Reason codes (CLAUDE.md §6). Seeded rather than left to the admin, because
-- an empty reason list on day one means every issue for the first month has no
-- reason on it, and consumption-by-reason is unrecoverable after the fact.
--
-- Idempotent so a re-run on a live database is harmless.

insert into reason_codes (code, label, applies_to, sort_order) values
  ('NEW_JOB',          'New job setup',      'ISSUE',   10),
  ('BREAKAGE',         'Broken in cut',      'ISSUE',   20),
  ('WEAR',             'Worn out',           'ISSUE',   30),
  ('TRIAL',            'Trial / proving',    'ISSUE',   40),
  ('REWORK',           'Rework',             'ISSUE',   50),
  ('PURCHASE',         'Purchase inward',    'RECEIPT', 10),
  ('RETURN_FROM_SHOP', 'Returned from shop', 'RECEIPT', 20),
  ('FOUND',            'Found in store',     'RECEIPT', 30)
on conflict (code) do nothing;
