-- Tablet and operator tokens (CLAUDE.md §11: "tablets hold a device token;
-- admin uses operator login").
--
-- §6 does not name these tables — it stops at the domain — so this migration
-- adds the minimum the stated auth model needs, and CLAUDE.md §11 has been
-- updated to record it.

create table tablets (
  id           uuid primary key default gen_random_uuid(),
  -- The identifier the tablet reports when claiming a session. Matches
  -- sessions.tablet_id.
  tablet_id    text unique not null,
  name         text,
  location     text,
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  active       boolean not null default true,

  constraint tablets_id_not_blank check (length(btrim(tablet_id)) > 0)
);

-- Bearer tokens.
--
-- Only the hash is stored: a token is a bearer credential, so a database dump
-- must not be a set of working logins. Tokens are 256 bits of randomness, so
-- SHA-256 is the right hash here — a slow KDF protects low-entropy secrets like
-- PINs, and buys nothing against a value that cannot be guessed. Operator PINs
-- go through argon2 in operators.pin_hash for exactly that reason.
create table api_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_hash   text unique not null,
  kind         text not null check (kind in ('TABLET', 'OPERATOR')),
  tablet_id    text references tablets (tablet_id) on delete cascade,
  operator_id  uuid references operators (id) on delete cascade,
  issued_at    timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,

  -- A token belongs to exactly one kind of subject.
  constraint api_tokens_subject_matches_kind check (
    (kind = 'TABLET'   and tablet_id is not null and operator_id is null)
    or (kind = 'OPERATOR' and operator_id is not null and tablet_id is null)
  )
);

create index api_tokens_live on api_tokens (token_hash) where revoked_at is null;
create index api_tokens_tablet on api_tokens (tablet_id) where tablet_id is not null;
create index api_tokens_operator on api_tokens (operator_id) where operator_id is not null;
