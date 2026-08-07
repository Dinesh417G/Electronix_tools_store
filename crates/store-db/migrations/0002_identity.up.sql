-- Door terminals, the punches they push, and the sessions those punches offer
-- (CLAUDE.md §6, §9, §10).

create table devices (
  id                 uuid primary key default gen_random_uuid(),
  serial_no          text unique not null,
  name               text,
  location           text,
  last_seen_at       timestamptz,
  firmware           text,
  timezone_offset_min integer,

  constraint devices_serial_not_blank check (length(btrim(serial_no)) > 0)
);

-- Every verified identity the terminal reported.
--
-- §9.4: a punch whose zk_user_id maps to no operator is still recorded. We
-- never drop data because the operator master is incomplete — that is how you
-- end up unable to explain a gap six months later.
create table punches (
  id          uuid primary key default gen_random_uuid(),
  device_id   uuid not null references devices (id) on delete restrict,
  zk_user_id  text not null,
  -- What the terminal claimed. Diagnostic only (§9.3): device clocks drift,
  -- and Indian half-hour offsets are a known trouble spot on some ZK firmware.
  device_ts   timestamptz,
  -- What the server observed. This is the business timestamp.
  received_at timestamptz not null default now(),
  verify_mode text,
  raw         text not null,
  -- Set once a session has been opened from this punch.
  claimed     boolean not null default false
);

-- §9.1: the device retries on any non-OK response, so a retried batch must be
-- a no-op rather than a second punch. This index is what makes the ADMS
-- handler's ON CONFLICT DO NOTHING correct.
--
-- device_ts is nullable, and NULLs are distinct under a plain unique index —
-- which would let a clock-less device duplicate freely. NULLS NOT DISTINCT
-- closes that hole.
create unique index punches_dedup
  on punches (device_id, zk_user_id, device_ts) nulls not distinct;

create index punches_received_at on punches (received_at desc);
create index punches_unclaimed on punches (received_at desc) where not claimed;

-- The session claim state machine (§10). store-core owns the transition rules;
-- this table only stores the result.
create table sessions (
  id           uuid primary key default gen_random_uuid(),
  operator_id  uuid not null references operators (id) on delete restrict,
  -- Unique so one punch can never offer two sessions. Null for the manual
  -- fallback path, where there was no punch at all.
  punch_id     uuid unique references punches (id) on delete restrict,
  state        text not null check (state in ('UNCLAIMED', 'ACTIVE', 'CLOSED', 'EXPIRED')),
  -- §10: manual sessions are weaker evidence than a fingerprint at the door,
  -- so they are flagged and shown distinctly in reports.
  manual_identity boolean not null default false,

  opened_at    timestamptz not null default now(),
  claimed_at   timestamptz,
  closed_at    timestamptz,
  -- The idle timeout is measured from here, not from opened_at.
  last_activity_at timestamptz not null default now(),

  tablet_id    text,
  close_reason text check (close_reason in ('SUBMITTED', 'DONE', 'IDLE_TIMEOUT')),

  -- The state machine's invariants, restated where the database can enforce
  -- them. A row that violates one of these is a bug in the session service.
  constraint sessions_tablet_set_when_claimed check (
    (state = 'UNCLAIMED' and tablet_id is null)
    or (state = 'EXPIRED' and tablet_id is null)
    or (state in ('ACTIVE', 'CLOSED') and tablet_id is not null)
  ),
  constraint sessions_close_reason_only_when_closed check (
    (state = 'CLOSED') = (close_reason is not null)
  ),
  constraint sessions_closed_at_matches_state check (
    (state in ('CLOSED', 'EXPIRED')) = (closed_at is not null)
  ),
  constraint sessions_claimed_at_matches_state check (
    (state in ('ACTIVE', 'CLOSED')) = (claimed_at is not null)
  ),
  -- A manual session has no punch; a punch-backed session is not manual.
  constraint sessions_manual_has_no_punch check (
    manual_identity = (punch_id is null)
  )
);

create index sessions_unclaimed on sessions (opened_at desc) where state = 'UNCLAIMED';
create index sessions_active on sessions (last_activity_at) where state = 'ACTIVE';
create index sessions_operator on sessions (operator_id, opened_at desc);
