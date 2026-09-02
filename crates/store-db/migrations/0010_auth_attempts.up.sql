-- A brake on guessing a four-digit PIN.
--
-- What is actually true without this table, on the deployment as it stands:
-- `POST /api/v1/auth/operator` and `POST /api/v1/sessions/manual` both take an
-- employee code and a PIN, both are reachable from the public internet, and
-- neither counts how often they have been wrong. `operators.pin_hash` is
-- argon2 over four digits — 0008's own header says reading that hash is
-- equivalent to reading the PIN, given an afternoon — but nobody needs the
-- hash. Ten thousand combinations against an endpoint that answers every one
-- of them is the same afternoon without the dump.
--
-- argon2 is not the control people assume it is here. It costs the attacker
-- one verify per guess, which is real but small, and Vercel will happily run
-- those guesses concurrently across instances. The control has to be a count.
--
-- ── Why a table, and why append-only ────────────────────────────────────
--
-- There is nowhere else to put it. A serverless function has no memory the
-- next request can see, this deployment has no Redis, and a counter held in an
-- instance is a counter an attacker resets by making one request too many. So
-- the count lives in Postgres, and it is written as a log rather than a
-- counter: the same shape as §7's ledger, for the same reason. "Which codes
-- were tried, from where, how often, and did any of them work" is a question
-- somebody will eventually ask after the fact, and a column holding the number
-- 11 cannot answer it.
--
-- Successes are recorded too, and not for the audit trail alone: the per-code
-- count is failures *since that code's last success*, so a storekeeper who
-- fat-fingers the pad four times and then gets in is back to zero rather than
-- four from a lockout.
--
-- ── What is NOT stored ──────────────────────────────────────────────────
--
-- Never the PIN, and never a hash of it. A failed attempt is worth keeping;
-- what was typed is not, and a log of near-miss PINs is a gift to whoever
-- reads it. The employee code is stored as supplied — an attempt against a
-- code that does not exist is exactly what this is here to notice.
--
-- ── Retention ───────────────────────────────────────────────────────────
--
-- Nothing prunes this. The window that matters is fifteen minutes and the
-- table is written once per login attempt, so on this system's traffic it
-- grows by a handful of rows a day; a crib with two tablets is not a login
-- service. `store-cli` is where a prune belongs if it ever earns one, and
-- Vercel's daily cron would be the other home. Until then the rows are the
-- audit trail and are meant to stay.

create table auth_attempts (
  id         bigserial primary key,
  emp_code   text        not null,
  route      text        not null,   -- OPERATOR_LOGIN | MANUAL_SESSION
  client_ip  text,                   -- null when no forwarding header reached us
  succeeded  bool        not null,
  at         timestamptz not null default now(),
  constraint auth_attempts_route_known
    check (route in ('OPERATOR_LOGIN', 'MANUAL_SESSION'))
);

-- The two lookups the throttle makes, and it makes both on every attempt, in
-- front of an argon2 verify. Both are (key, time) so the window is a range
-- scan off the end of the index rather than a filter over the table's history.
create index auth_attempts_by_code on auth_attempts (emp_code, at desc);
create index auth_attempts_by_ip   on auth_attempts (client_ip, at desc)
  where client_ip is not null;

-- §6: RLS on, no policies. Same reasoning as 0008, and this table has its own:
-- over PostgREST, a readable `auth_attempts` tells an attacker which codes are
-- real and how close to a lockout each one is, and a writable one lets them
-- lock every storekeeper out of the console by inserting failures.
alter table auth_attempts enable row level security;
