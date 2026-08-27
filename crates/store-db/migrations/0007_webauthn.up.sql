-- Passkeys: the phone's own fingerprint sensor as an identity source (§8).
--
-- What this is, precisely, because the difference from the door reader matters
-- and will be forgotten otherwise:
--
--   The door terminal does biometric *matching*. It compares a finger against
--   enrolled templates and decides who it belongs to. WebAuthn does not. The
--   sensor unlocks a private key held in the device's secure enclave, and we
--   receive a signature. It proves "this device, unlocked by someone the device
--   trusts" — not "this is R. Kumar's finger".
--
--   On a personal phone that distinction is academic: the phone has one owner
--   and it is far stronger evidence than an employee code and a four-digit PIN.
--   On a *shared wall tablet* it is not: Android allows several fingerprints
--   enrolled at OS level and any of them unlocks the credential, so a passkey
--   registered there identifies the tablet, not the operator holding it.
--
-- Hence §10's identity strength becomes three-valued rather than two, and the
-- registration endpoint refuses to enrol a credential on a shared device.
--
-- No biometric data is stored here. A public key and a counter, nothing that
-- could be replayed against another system or leak a fingerprint.

create table webauthn_credentials (
  id            uuid primary key default gen_random_uuid(),
  operator_id   uuid not null references operators (id) on delete cascade,
  -- The credential id the authenticator generated, base64url. Unique across the
  -- table: one credential belongs to exactly one operator.
  credential_id text unique not null,
  -- COSE public key, base64url. This is the whole secret we hold, and it is not
  -- secret — it verifies signatures and can do nothing else.
  public_key    text not null,
  -- Replay defence. An authenticator that has ever reported a non-zero counter
  -- must never report a lower one; going backwards means the credential has
  -- been cloned.
  sign_count    bigint not null default 0,
  -- "usb", "internal", "hybrid"… diagnostic only, and absent on some platforms.
  transports    text,
  -- A name the operator recognises, because revoking the right one requires
  -- telling them apart: "R. Kumar's phone".
  device_label  text,
  -- True when the platform syncs this credential to the account's cloud
  -- keychain. It is convenience for the operator and a caveat for us: a synced
  -- passkey exists on every device that account owns.
  backed_up     boolean not null default false,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,

  constraint webauthn_credentials_id_not_blank check (length(btrim(credential_id)) > 0)
);

create index webauthn_credentials_operator on webauthn_credentials (operator_id)
  where revoked_at is null;
create index webauthn_credentials_live on webauthn_credentials (credential_id)
  where revoked_at is null;

-- Challenges have to be stored, not held in memory.
--
-- A WebAuthn ceremony is two requests: we issue a random challenge, the
-- authenticator signs it, we verify the signature covers the challenge we
-- issued. On a long-lived server that value sits in memory between the two. A
-- serverless function has no between — the second request may reach a different
-- instance in a different region — so it goes in the database and is deleted on
-- use.
create table webauthn_challenges (
  id          uuid primary key default gen_random_uuid(),
  challenge   text not null,
  -- REGISTER challenges belong to a known operator; AUTHENTICATE ones do not
  -- yet, because discoverable credentials tell us who they are afterwards.
  purpose     text not null check (purpose in ('REGISTER', 'AUTHENTICATE')),
  operator_id uuid references operators (id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- Short on purpose: a challenge is single-use and a ceremony takes seconds.
  expires_at  timestamptz not null default now() + interval '5 minutes',

  constraint webauthn_challenges_register_has_operator check (
    purpose <> 'REGISTER' or operator_id is not null
  )
);

create index webauthn_challenges_lookup on webauthn_challenges (challenge);
create index webauthn_challenges_expiry on webauthn_challenges (expires_at);

-- ── §10: identity strength becomes three-valued ─────────────────────────
--
-- `manual_identity` keeps its meaning — "this session did not come from a door
-- punch" — because that is what the existing check constraint, the reports and
-- the terminal's "typed in" badge all rely on. What it cannot say is *how*
-- identity was established when it wasn't the door, and a passkey is not a
-- typed PIN.
alter table sessions
  add column identity_source text not null default 'PUNCH'
    check (identity_source in ('PUNCH', 'WEBAUTHN', 'PIN'));

-- Existing rows first: everything without a punch was the PIN fallback, because
-- it was the only other way in before this migration. The column defaults to
-- PUNCH, so those rows are wrong until this runs — and the constraint below
-- would refuse to be added while they are.
update sessions set identity_source = 'PIN' where punch_id is null;

-- A punch-backed session is exactly a PUNCH-sourced one. Stated here so a
-- future writer cannot record a passkey session that also claims a punch.
alter table sessions
  add constraint sessions_identity_source_matches_punch check (
    (identity_source = 'PUNCH') = (punch_id is not null)
  );
