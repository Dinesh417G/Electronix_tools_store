# CLAUDE.md — ElectronIx Tool Store

> Build spec for Claude Code. **Read this file completely before writing any code.**
> Work milestone-by-milestone (§13). Never advance past a milestone whose acceptance gate fails.
> Where this file and your instincts disagree, this file wins. Where this file is silent, ask.

---

## 1. What this is

**ElectronIx Tool Store** is a tool-crib management system for a CNC tooling store —
carbide inserts, end mills, drills, taps, holders and shop consumables.

The physical loop it digitises:

```
Operator puts finger on the door terminal
        → terminal verifies and unlocks the door itself
        → terminal pushes "user 1042 verified at 14:32:11" to our server
        → tablet inside the store wakes with "Welcome, R. Kumar" and an IN / OUT panel
        → operator scans a bin barcode (or searches), enters qty, optionally taps
          machine + reason, submits
        → stock ledger updated, on-hand recalculated, low-stock alert raised if crossed
```

Everything else in the product — reports, alerts, admin — is a read of that ledger.

Two implementations of one system (§2):

1. **`cloud/`** — **the deployed one.** A Next.js app on Vercel holding the REST
   API, the ZKTeco ADMS endpoints, the session state machine, the terminal, the
   live view and the admin console, with Supabase Postgres behind it.
2. **`crates/`** — **the reference one.** A Cargo workspace: `store-server`
   (Axum, ADMS listener, REST + SSE), `store-web` (the same terminal, embedded),
   `store-cli`, `store-label`. Its migrations are the schema of record, and an
   on-prem install would be built from it.

`store-cli` is the one thing with no full cloud twin: seeding and operator
management have equivalents (`npm run seed`, `npm run operator`, §2), but
`reconcile`, `backup`, `export` and `device-probe` are Rust-only and are run
against the same database.

The original plan was three binaries — `store-server`, a Tauri Android
`store-tablet` and a Tauri desktop `store-admin`. All three decisions changed;
§2 records each and why.

---

## 2. Locked decisions — do not relitigate

| Decision | Value | Why |
|---|---|---|
| Backend language | **TypeScript, Next.js, on Vercel** (`cloud/`) — *changed, see below*. Rust/Axum/tokio (`crates/`) stays as the reference implementation | House stack was Rust; the deployment target is now a cloud with no Rust runtime and no persistent process |
| Database | **Supabase Postgres** (managed, `ap-south-1`) — *changed, see below* | Multiple tablets write concurrently; SQLite's single-writer model is wrong here. Postgres 16 on the server PC was right while there was a server PC to own it |
| DB access | **Raw SQL through `postgres.js`** in `cloud/`; `sqlx` with compile-time checked queries in `crates/` | The Rust queries are checked against a schema at build time. The TypeScript ones are not — see what this costs, below |
| Migrations | **`crates/store-db/migrations/` is the schema of record**, applied to Supabase verbatim | One schema, two clients. A migration written for the cloud that never lands here is how the two implementations start to disagree |
| Door hardware | Standalone **ZKTeco (or eSSL rebadge) terminal speaking ADMS "Push"** | Device pushes over plain HTTP — no vendor DLL, no Windows-only SDK |
| Who unlocks the door | **The terminal, on its own.** Never our software | Door must work when the server PC is off — and now, when the line's internet is down. We are observers, not the lock |
| Tablet client | **Responsive web app (PWA), served by the cloud app** — *changed twice, see below* | Runs on the phone in your pocket today and the wall tablet later; updates over the air with no signing key, no store review and no device visits |
| Tool lifecycle | **Consumed only.** No return, regrind or tool-life tracking | Scope decision |
| Item selection | **Both** barcode/QR scan **and** manual search-and-enter | Scope decision |
| Issue fields | Quantity mandatory. Machine/job + reason **optional, with a Skip button** | Scope decision |
| Stock inward | **Storekeeper enters IN on the tablet.** No PO/GRN, no Tally/ERP import | Scope decision |
| Alerts | **In-app only** — tablet banner + admin dashboard. No email, SMS or WhatsApp | Scope decision |
| Stock representation | **Append-only ledger.** No mutable `qty` column, ever | §7 — this is the core invariant |

> **Decision changed (M5).** The tablet client was originally locked to Tauri 2
> Mobile / Android. It is now a mobile-first responsive web app (`store-web`),
> built with React + TypeScript + Tailwind and embedded in the `store-server`
> binary.
>
> Why: the wall tablet does not exist yet, and waiting for hardware to validate
> the flow was blocking everything downstream of it. A web terminal runs on a
> phone today and scales to the tablet unchanged. It also gives the product a
> genuine OTA story for free — a new build reaches every device on its next
> load, with no key to lose (see `OTA-SETUP.md`).
>
> What this costs, honestly: barcode scanning uses the browser's
> `BarcodeDetector`, which Android Chrome has and iOS Safari does not. Where it
> is missing the terminal opens on search instead of pretending the camera will
> work. §12.4's rule that both paths land on the same item card is what makes
> that acceptable rather than crippling.
>
> Not abandoned: if a native shell is ever wanted — for a kiosk lock, a
> hardware scanner wedge, or an iOS device — it wraps this same UI. The REST and
> SSE contract does not change.

> **Decision changed (M7).** `store-admin` was locked to a Tauri 2 desktop app
> on the server PC. The admin console is now a section of `store-web`, reached
> by an operator PIN login and gated to `ADMIN`/`STOREKEEPER` roles.
>
> Same reasoning as M5, and one more: the admin runs *on the server PC*, which
> is where `store-server` already listens. A separate desktop binary would mean
> a second artifact, a second installer and a second OTA channel to reach the
> one machine that is by definition already running the thing being updated.
>
> Label printing is unaffected by this — it was always a server endpoint (§11),
> and the PDF opens in the browser's print dialogue.

> **Decision changed (cloud port, 2026-08-27).** The system was locked to a Rust
> service on a PC inside the plant, owning a Postgres on the same machine. The
> deployed system is now a Next.js app on Vercel talking to Supabase Postgres.
> The Rust workspace stays in this repo: it still builds, CI still tests it, and
> its migrations are the schema both implementations run.
>
> Why: the owner asked for a live public site — UI on Vercel, data in Supabase,
> nothing depending on a PC in the plant. `store-server` could not move as-is.
> It holds an SSE stream open, runs two background reapers and listens for ADMS
> pushes; Vercel runs request-scoped functions with no persistent process, no
> background timers and no first-class Rust.
>
> What this costs, honestly:
>
> - **Offline is gone, and this is the one decision here that is not settled.**
>   The original §2 chose Postgres on the server PC precisely so the crib kept
>   working when the line's internet dropped. Cloud-only means an internet
>   outage stops all stock movement — the door still opens, and nothing can be
>   booked. The terminal's IndexedDB outbox (§12) narrows this to "the tablet
>   keeps accepting work and flushes later", which is not the same as the store
>   being able to operate. Decide this before commissioning a real crib.
> - **The ADMS listener must be publicly reachable.** A ZK terminal on the plant
>   LAN cannot reach Vercel unless the plant routes it out (§9's endpoints are
>   unchanged; where they listen is not).
> - **No compile-time query checking in `cloud/`.** `sqlx` proved every Rust
>   query against a real schema at build time. The TypeScript side has raw SQL
>   and a typecheck that cannot see the database, so a column rename passes CI
>   and fails at runtime. The migrations being shared is what limits the damage;
>   it does not remove it.
> - **The reapers become derive-on-read.** §10's 90 s expiry and 180 s idle
>   close were background timers. In the cloud they are computed when a session
>   is read — a session is EXPIRED if `UNCLAIMED` and older than 90 s, CLOSED if
>   `ACTIVE` and idle past 180 s. The state machine's transitions are unchanged;
>   what changed is who notices. Vercel Cron on the hobby plan runs daily, so a
>   sweep is housekeeping, never correctness.
> - **SSE becomes a 2 s poll** (`cloud/src/lib/events.ts`). The §11 event names
>   are unchanged, and that file is the only one Supabase Realtime would touch.
> - Preview URLs change per deployment, and a passkey is bound to an origin, so
>   passkey sign-in needs a stable domain before it is worth trusting.
>
> Not abandoned: the Rust workspace is the reference implementation and an
> on-prem install is still buildable from it. If the offline question is
> answered "the store must work without internet", that is the path back.
>
> The rest of this file was rewritten with it. Where the two implementations
> differ, both are described and labelled — §4's two topologies, §11's table of
> what the cloud does not serve, §13's split status. `CLOUD-PORT.md` remains the
> cloud's own map: deployment, environment, and what only the owner can do.

---

## 3. Physical setup this software assumes

- **1× ZKTeco access terminal** at the store door (IN01-A / F18 / iClock class):
  fingerprint + RFID, TCP/IP, ADMS push, and its own relay outputs for the EM lock,
  exit button and door sensor.
- **An outbound route to the internet** from whatever network the terminal is on.
  This is the one thing the cloud deployment added to the shopping list: the ADMS
  host is a public URL now, not a PC on the same switch.
- **1–2 Android tablets** wall-mounted inside the store — or any phone. They need
  to reach the deployment, not a particular LAN.
- Optional **label printer** for bin barcodes (Code 128 of `item_code`). Printing
  unattended over the LAN needs the small in-plant agent described in
  `CLOUD-PORT.md`; a browser cannot open a socket to a printer, and a function in
  Vercel's cloud has no route to a private address.

The terminal is configured to point its ADMS server address at our `/iclock`
endpoints. That is still the entire integration surface; only the address changed.

**No server PC.** The deployed system needs nothing running inside the plant.
The Rust reference implementation still assumes one — static LAN IP, Postgres and
`store-server` on it — and that is the shape to return to if the offline question
(§2) is answered "the store must work without internet".

---

## 4. Topology

**Deployed.** Nothing runs in the plant but the door and the browsers:

```
 ┌──────────────────┐  ADMS/HTTP push      ┌──────────────────────────────┐
 │  ZK door terminal│  over the internet   │  Vercel — Next.js functions  │
 │  (owns the lock) │ ───────────────────► │  /iclock/*   /api/v1/*       │
 └──────────────────┘                      │                              │
                                           │  session state machine       │
 ┌──────────────────┐  REST + 2 s poll     │  ledger service              │
 │  terminal        │ ◄──────────────────► │  alert evaluation            │
 │  live view       │                      └───────────────┬──────────────┘
 │  admin console   │                                      │
 │  (any browser)   │                              ┌───────▼─────────────┐
 └──────────────────┘                              │ Supabase Postgres   │
                                                   │ (pooled, :6543)     │
                                                   └─────────────────────┘
```

There is no `GET /api/v1/sessions/stream` in this deployment. SSE needs a process
that stays alive holding the socket; Vercel gives request-scoped functions with a
duration cap, so an open stream is a countdown to a reconnect rather than a
subscription. `cloud/src/lib/events.ts` polls every 2 s instead — one cheap
indexed query while the claim screen is up, which is the only moment freshness
matters — and keeps the §11 event shapes unchanged so Supabase Realtime can
replace it without touching anything else.

**Reference (`crates/`).** One Axum process on a PC in the plant, owning
Postgres on localhost, and a real SSE stream:

```
 ┌──────────────────┐   ADMS/HTTP push    ┌───────────────────────────────┐
 │  ZK door terminal│ ──────────────────► │  store-server (Axum, :8080)   │
 │  (owns the lock) │  POST /iclock/cdata │                               │
 └──────────────────┘                     │  ┌─────────────────────────┐  │
                                          │  │ adms listener           │  │
 ┌──────────────────┐   REST + SSE        │  │ session state machine   │  │
 │  store-web       │ ◄─────────────────► │  │ ledger service          │  │
 │  (browser, LAN)  │                     │  │ alert engine + reapers  │  │
 └──────────────────┘                     │  └───────────┬─────────────┘  │
                                          └──────────────┼────────────────┘
                                                   ┌─────▼─────┐
                                                   │ Postgres  │
                                                   └───────────┘
```

There, tablets subscribe to `GET /api/v1/sessions/stream` (SSE). When a punch
arrives the server emits `session.opened` and the tablet foregrounds the IN/OUT
panel, with no polling.

---

## 5. Repo layout

```
electronix-tool-store/
├── CLAUDE.md                  ← this file
├── CLOUD-PORT.md              ← the deployed app's own map: what it runs on,
│                                what only the owner can do, what is left
├── Cargo.toml                 ← workspace
├── cloud/                     ← THE DEPLOYED APP. Next.js on Vercel
│   ├── src/app/api/v1/        ← REST routes, one directory per endpoint
│   ├── src/app/iclock/        ← the ADMS endpoints (§9)
│   ├── src/screens/           ← Terminal, LiveView, Admin, AdminLogin, Enrol,
│   │                            Serials, PrinterSettings
│   ├── src/lib/               ← the domain and the database. ledger, session,
│   │                            sessions, punches, txn, items, adms, auth,
│   │                            passkey, webauthn, labels, serials, events,
│   │                            outbox, admin, api, errors, db
│   ├── scripts/seed.mts       ← catalog seed; reads the CSV under store-cli
│   └── tests/                 ← label round-trip (M7's software half)
├── crates/
│   ├── store-core/            ← domain library. NO I/O, NO sqlx, NO axum
│   │   ├── item.rs            ← Item, Category, Uom, barcode rules
│   │   ├── ledger.rs          ← LedgerEntry, TxnType, apply(), invariants
│   │   ├── session.rs         ← SessionState machine (pure)
│   │   ├── alert.rs           ← reorder evaluation
│   │   └── error.rs
│   ├── store-adms/            ← ZKTeco ADMS protocol. Depends on store-core only
│   │   ├── protocol.rs        ← request/response parsing (plain text, NOT json)
│   │   ├── routes.rs          ← axum Router for /iclock/*
│   │   ├── commands.rs        ← outbound command queue to device
│   │   └── mock_device.rs     ← test harness that behaves like a real terminal
│   ├── store-db/              ← sqlx repositories + migrations
│   │   └── migrations/
│   ├── store-server/          ← binary: composes adms + db + api
│   ├── store-cli/             ← binary: seed, reconcile, export, device probe
│   ├── store-label/           ← Code128 + a minimal PDF writer. Depends on
│   │                            store-core only. `scan-verify` feature adds a
│   │                            reader, used only to test our own labels
│   └── store-web/             ← the terminal, live view and admin console.
│       │                        React + TS + Tailwind, built by Vite,
│       │                        embedded into store-server
│       ├── src/screens/       ← Terminal (§12), LiveView, Admin, Enrol
│       └── src/lib/           ← api, admin, events (SSE), outbox, scanner
└── .claude/agents/            ← §15
```

**Dependency rule:** `store-core` depends on nothing in this workspace. Everything depends
inward toward it. If you find yourself importing `sqlx` into `store-core`, you have made a
mistake — stop and restructure.

The same rule in `cloud/`, without a compiler to enforce it: a route file parses
its input, authorises the caller and calls into `src/lib/`. Ledger arithmetic or
a session transition written inside `src/app/api/…/route.ts` is the same mistake
as `sqlx` in `store-core`, and it is the one the type system will not catch.

---

## 6. Data model

Postgres. All timestamps `timestamptz`. All money `numeric(12,2)`. All quantities
`numeric(12,3)` (inserts are whole numbers, but coolant and bar stock are not).

```sql
-- ── People ──────────────────────────────────────────────────────────
operators(
  id            uuid pk,
  emp_code      text unique not null,
  full_name     text not null,
  zk_user_id    text unique,          -- the PIN/user id programmed into the terminal
  pin_hash      text,                 -- argon2, for the fallback path only
  role          text not null,        -- OPERATOR | STOREKEEPER | ADMIN
  department    text,
  active        bool not null default true
)

-- ── Catalog ─────────────────────────────────────────────────────────
item_categories(id uuid pk, name text unique not null, sort_order int)

items(
  id             uuid pk,
  item_code      text unique not null,   -- our internal code; the barcode payload
  description    text not null,
  category_id    uuid fk,
  uom            text not null,          -- NOS | SET | BOX | LTR | KG
  -- tooling-specific, all nullable:
  iso_code       text,                   -- e.g. CNMG120408
  grade          text,                   -- e.g. TN2000
  manufacturer   text,
  mfr_part_no    text,
  diameter_mm    numeric(8,3),
  flutes         int,
  -- stock control:
  reorder_level  numeric(12,3) not null default 0,
  reorder_qty    numeric(12,3),
  bin_location   text,                   -- rack/shelf, printed on the label
  unit_cost      numeric(12,2),
  allow_negative bool not null default false,
  active         bool not null default true,
  created_at, updated_at
)

item_barcodes(id uuid pk, item_id uuid fk, code text unique not null, kind text)
-- kind: OWN | MFR_EAN | VENDOR. Lets a vendor's printed barcode resolve to our item.

machines(id uuid pk, code text unique not null, name text, active bool)
reason_codes(id uuid pk, code text unique, label text, applies_to text, sort_order int)
-- seed: NEW_JOB, BREAKAGE, WEAR, TRIAL, REWORK  (applies_to = ISSUE)
--       PURCHASE, RETURN_FROM_SHOP, FOUND       (applies_to = RECEIPT)

-- ── The ledger. Append only. ────────────────────────────────────────
stock_ledger(
  id           bigserial pk,
  item_id      uuid fk not null,
  delta_qty    numeric(12,3) not null,   -- negative = out, positive = in. NEVER zero
  txn_type     text not null,            -- ISSUE | RECEIPT | ADJUST | OPENING | SCRAP
  operator_id  uuid fk not null,
  session_id   uuid fk,                  -- null for admin-side adjustments
  machine_id   uuid fk,                  -- optional
  reason_id    uuid fk,                  -- optional
  note         text,
  unit_cost    numeric(12,2),            -- snapshot at txn time
  device_ts    timestamptz,              -- what the terminal claimed
  created_at   timestamptz not null default now(),   -- what the server observed
  reverses_id  bigint fk stock_ledger(id),           -- set on correction rows
  client_txn_uuid uuid unique            -- §12 outbox dedup; added at M4
)
create index on stock_ledger(item_id, created_at desc);
-- Enforced by trigger, not convention: UPDATE and DELETE on stock_ledger are
-- refused outright. A mistake is corrected by a reversing row (§7).
-- At most one reversal per row, so a correction applied twice cannot
-- silently double-count.

-- ── Derived, trigger-maintained. Never written by application code. ─
item_stock(
  item_id      uuid pk fk,
  on_hand      numeric(12,3) not null default 0,
  last_txn_at  timestamptz,
  alert_state  text not null default 'OK'   -- OK | LOW | EMPTY
)

-- ── Door / identity ─────────────────────────────────────────────────
devices(id uuid pk, serial_no text unique, name text, location text,
        last_seen_at timestamptz, firmware text, timezone_offset_min int)

punches(id uuid pk, device_id uuid fk, zk_user_id text not null,
        device_ts timestamptz, received_at timestamptz not null default now(),
        verify_mode text, raw text, claimed bool not null default false)

sessions(id uuid pk, operator_id uuid fk, punch_id uuid fk unique,
         state text not null,          -- UNCLAIMED | ACTIVE | CLOSED | EXPIRED
         manual_identity bool not null default false,  -- §10; added at M4
         last_activity_at timestamptz not null,        -- idle timeout is measured
                                                       -- from here, not opened_at
         opened_at, claimed_at, closed_at, tablet_id text, close_reason text)
-- punch_id is null exactly when manual_identity is true, and the state/timestamp
-- combinations the machine can produce are pinned by check constraints, so a
-- row the state machine could not have produced cannot be stored.

-- ── Auth (§11). Added at M4; §6 stopped at the domain. ───────────────
tablets(id uuid pk, tablet_id text unique not null, name text, location text,
        registered_at timestamptz, last_seen_at timestamptz, active bool)

api_tokens(id uuid pk, token_hash text unique not null,
           kind text not null,          -- TABLET | OPERATOR
           tablet_id text fk, operator_id uuid fk,
           issued_at, last_used_at, expires_at, revoked_at timestamptz)
-- Only the hash is stored. Tokens are 256 bits of randomness, so SHA-256 is
-- right for them; operator PINs are short and guessable, so those go through
-- argon2 in operators.pin_hash. Using a slow KDF for the first would cost
-- latency for nothing; using a fast hash for the second would be a real hole.

-- ── Alerts ──────────────────────────────────────────────────────────
stock_alerts(id uuid pk, item_id uuid fk, level text,     -- LOW | EMPTY
             raised_at timestamptz, resolved_at timestamptz,
             acknowledged_at timestamptz, acknowledged_by uuid fk)

-- ── Serials and label printing (0006). Added during the cloud port. ──
serial_settings   -- prefix + pad width, singleton  → "TC-000001"
tool_serials      -- one row per physical sticker, NOT per item.
                  -- item_id, serial_no unique across the crib, minted,
                  -- status, print_count, first/last_printed_at.
                  -- Reprinting is the same number again: print_count
                  -- increments, no new row, no new number.
printer_settings  -- mode, host, port, dpi, label size, singleton
print_jobs        -- serial_id | item_id, copies, kind, status

-- ── Passkeys (0007) ─────────────────────────────────────────────────
webauthn_credentials  -- per operator: credential id, public key, sign count
webauthn_challenges   -- short-lived, single-use

sessions.identity_source text not null  -- PUNCH | WEBAUTHN | PIN  (§8)

-- ── Row Level Security (0008) ───────────────────────────────────────
-- Every table above has RLS enabled and no policies, which denies the roles
-- Supabase's PostgREST uses and leaves both implementations untouched: the
-- tables are owned by `postgres`, which carries BYPASSRLS, and that is the
-- role behind DATABASE_URL. Not FORCEd, deliberately.
--
-- This is not decoration. Supabase publishes an HTTP endpoint over this
-- schema, reachable with a key meant to live in a browser, and before 0008 it
-- served operators.pin_hash and accepted an INSERT into stock_ledger — which
-- satisfies the triggers while bypassing every §7 guard the application
-- enforces. A table added by a later migration is NOT covered; enable it in
-- the migration that creates it.
```

---

## 7. The ledger rule — the most important thing in this spec

**Stock is never stored as a number you update. Stock is the sum of a ledger.**

- Every movement inserts exactly one `stock_ledger` row. No `UPDATE` on quantities, ever.
- A mistake is corrected by inserting a **reversing row** with `reverses_id` pointing at the
  original — never by editing or deleting the original.
- `item_stock.on_hand` is a cached read model maintained by an `AFTER INSERT` trigger on
  `stock_ledger`. Application code **reads** it and never writes it.
- `store-cli reconcile` recomputes `SUM(delta_qty) GROUP BY item_id` and compares against
  `item_stock.on_hand`. **Any drift is a bug, not a data-entry problem.**

This single decision is what makes "log history" and "current stock" the same object rather
than two things that quietly disagree after six months. It is also what makes the audit
trail defensible when someone asks where forty inserts went.

Guard: an `ISSUE` that would push `on_hand` below zero is rejected with `409 Conflict`
unless `items.allow_negative` is true. The tablet surfaces this as *"Only 3 left in system —
count the bin and adjust"*, not as a silent failure.

---

## 8. Identity: the `IdentitySource` trait

Do **not** wire the ADMS listener directly into the session service. Put it behind a trait,
exactly as ElectronIx DNC puts FTP and raw-TCP behind `Transport`:

```rust
#[async_trait]
pub trait IdentitySource: Send + Sync {
    /// Stream of verified-identity events from a physical reader.
    async fn subscribe(&self) -> BoxStream<'static, IdentityEvent>;
    fn source_id(&self) -> &str;
}

pub struct IdentityEvent {
    pub external_user_id: String,   // zk_user_id
    pub device_serial: String,
    pub device_ts: Option<DateTime<Utc>>,
    pub verify_mode: VerifyMode,    // Fingerprint | Card | Face | Password
    pub raw: String,
}
```

Three implementations in v1:

| Impl | Use |
|---|---|
| `AdmsIdentitySource` | The real terminal |
| `ManualPinSource` | Fallback — operator types emp code + PIN on the tablet when the push never arrives |
| `MockIdentitySource` | Tests and demos. Must be able to drive a full issue flow with no hardware present |

A fourth arrived with the cloud port: **passkeys** (`/api/v1/auth/webauthn/*`),
where the operator unlocks a registered device with its own fingerprint sensor
and it signs our challenge. Sessions record which of the three it was, because
they are not equal evidence:

| `identity_source` | What actually happened |
|---|---|
| `PUNCH` | the terminal matched a finger against enrolled templates and decided whose it was |
| `WEBAUTHN` | a device the operator registered was unlocked by someone that device trusts |
| `PIN` | somebody typed an employee code and four digits |

`manual_identity` stays **true** for a passkey session. It means "this did not
come from the door", and that is what the reports and the terminal's badge are
reading. A passkey is stronger than a typed PIN and still weaker than the
reader — flattening those three into one flag would be the lie that makes the
audit trail undefensible.

Every integration test runs against `MockIdentitySource`. **No test may require a physical
door terminal.**

---

## 9. ZKTeco ADMS protocol notes

The device is the client; our server is the ADMS host. It is plain HTTP with `key=value` and
tab-separated bodies — **not** REST, **not** JSON. Do not try to make it pretty.

Endpoints to implement in `store-adms`:

```
GET  /iclock/cdata?SN=<serial>&options=all&pushver=...
     → device handshake on boot. Respond with a plain-text option block:
       GET OPTION FROM: <SN>
       ATTLOGStamp=0
       OPERLOGStamp=0
       ErrorDelay=30
       Delay=10
       TransTimes=00:00;14:00
       TransInterval=1
       TransFlag=111111111111
       Realtime=1
       ServerVer=3.0.1
       TimeZone=<offset>

POST /iclock/cdata?SN=<serial>&table=ATTLOG
     → body is one record per line, tab-separated:
       <userid>\t<yyyy-MM-dd HH:mm:ss>\t<status>\t<verify>\t<workcode>\t<reserved>
     → MUST respond with exactly:  OK: <n>
       (a non-OK or slow response makes the device retry and duplicate records)

GET  /iclock/getrequest?SN=<serial>
     → device polls for queued commands. Respond "OK" when nothing queued,
       or a command line such as:
       C:<cmdid>:DATA UPDATE USERINFO PIN=<id>\tName=<name>\tPri=0

POST /iclock/devicecmd?SN=<serial>
     → device reports command results: ID=<cmdid>&Return=0&CMD=DATA
```

Hard requirements:

1. **Idempotency.** The device retries on any non-`OK`. Deduplicate on
   `(device_serial, zk_user_id, device_ts)` with a unique index. A retried batch must be a
   no-op, not a second punch.
2. **Respond fast.** Persist-then-acknowledge, but keep the handler under ~200 ms. Never do
   session logic inline in the ADMS handler — push onto a channel and return.
3. **Distrust device clocks.** Indian half-hour offsets are a known trouble spot on some ZK
   firmwares; a device on Wi-Fi can silently drift off +05:30. Always store `received_at`
   alongside `device_ts`, and **use `received_at` for all business logic and reporting.**
   `device_ts` is diagnostic only.
4. **Unknown users.** A punch whose `zk_user_id` maps to no operator is still recorded, and
   raises an admin notice. Never drop data because the master is incomplete.
5. **Where this listens changed; what it must do did not.** These are Vercel
   functions at a public origin now, so the device needs an outbound route (§3)
   and the ~200 ms budget has the internet inside it. The dedup key, the exact
   `OK: <n>` acknowledgement and the rule against session logic in the handler
   are unchanged, because the retry behaviour that makes them necessary belongs
   to the device, not the network. A cold function start is now one more way to
   be slow enough to cause a duplicate batch.

> ⚠️ **Verify before you trust this section.** Firmware families vary in casing, parameter
> names and stamp semantics. At M2, run `store-cli device-probe --listen 8080`, point a real
> terminal at it, and dump every raw request to disk. Reconcile this spec against that
> capture and update this file if they differ. Do not assume.

---

## 10. Session claim state machine (pure: `store-core`, `cloud/src/lib/session.ts`)

The problem: two people can walk in on one punch, and a punch can arrive with no one at the
tablet. So a punch does not *become* a session — it *offers* one.

```
              punch received
                    │
                    ▼
             ┌─────────────┐   no claim in 90s    ┌─────────┐
             │  UNCLAIMED  │ ───────────────────► │ EXPIRED │
             └──────┬──────┘                      └─────────┘
              tablet claims
                    │
                    ▼
             ┌─────────────┐  submit / cancel /   ┌─────────┐
             │   ACTIVE    │  180s idle           │ CLOSED  │
             └─────────────┘ ───────────────────► └─────────┘
```

Rules:

- The tablet's home screen lists **all `UNCLAIMED` punches from the last 90 s** as name
  cards. Tailgating is solved socially: each person taps their own card.
- A claimed session is bound to one `tablet_id`. A second tablet cannot claim it.
- `ACTIVE` closes on submit, on explicit Done, or after 180 s idle. **Idle means idle**: the
  tablet posts `/touch` as the operator moves between steps, because scanning, keying a
  quantity and picking machines are all local to the tablet. Without that the server cannot
  tell somebody working from somebody who walked away, and 180 s becomes a deadline on the
  whole transaction rather than a timeout on abandonment.
- Transactions submitted after close are rejected `410 Gone`. The tablet then re-opens the
  claim screen rather than silently discarding the operator's typing.
- If no punch arrives (device down, network down), the tablet offers **"Enter manually"** →
  emp code + PIN via `ManualPinSource`. Those sessions are flagged `manual_identity = true`
  and shown distinctly in reports, because they are weaker evidence.

Model this as an exhaustive `match` over `(SessionState, SessionEvent)` returning
`Result<SessionState, TransitionError>`. Every illegal pair must be an explicit arm, not a
`_ => unreachable!()`. The TypeScript port (`cloud/src/lib/session.ts`) owes the
same exhaustiveness; without a compiler that demands it, a missing pair is a
silent `undefined` rather than a build failure.

**Who notices a timeout, in the cloud.** `store-server` runs two background
reapers — 90 s unclaimed expiry, 180 s idle close. Vercel has no process to run
them in, and cron on the hobby plan runs daily, which is useless against a 90 s
deadline. So the deployed system **derives state on read**: a session is EXPIRED
if it is stored `UNCLAIMED` and older than 90 s, CLOSED if stored `ACTIVE` and
idle past 180 s. `GET /api/v1/sessions/{id}` reports the *effective* state, and
a write against a session that has aged out is refused exactly as if a reaper
had closed it.

The transitions above are unchanged by this, and that is the point: what moved
is who observes the clock, not what the machine does. A stored row may lag the
truth; no read of it may. Any new query that filters on `state` directly, rather
than through the helper that applies these two rules, reintroduces the bug —
a session that everyone can see is dead and the database still calls `ACTIVE`.

---

## 11. API surface

```
POST   /api/v1/auth/tablet                 register tablet, get long-lived token
POST   /api/v1/auth/operator               emp_code + PIN → 12h token (admin app login)
GET    /api/v1/sessions/stream             SSE: session.opened | session.claimed |
                                                session.closed | alert.raised |
                                                punch.unknown_user | heartbeat
GET    /api/v1/sessions/unclaimed          name cards for the claim screen
GET    /api/v1/sessions/{id}
POST   /api/v1/sessions/{id}/claim         body: { tablet_id }
POST   /api/v1/sessions/manual             body: { emp_code, pin, tablet_id } → session
POST   /api/v1/sessions/{id}/touch         operator is still working; pushes back the 180s idle
POST   /api/v1/sessions/{id}/close

GET    /api/v1/items/lookup?barcode=       resolve scan → item + on_hand + bin  (must be <100ms)
GET    /api/v1/items/search?q=             typeahead across item_code, description, iso_code, grade
GET    /api/v1/items/{id}

POST   /api/v1/txn/issue                   { session_id, item_id, qty, machine_id?, reason_id?, note? }
                                           or { session_id, item_id, reason_id?, note?,
                                                splits: [{ machine_id, qty }] } — one item for
                                           several machines: one ledger row each, one transaction,
                                           so the §7 guard applies to the total (§11)
POST   /api/v1/txn/receipt                 { session_id, item_id, qty, unit_cost?, reason_id?, note? }
POST   /api/v1/txn/{id}/reverse            admin only; inserts the reversing row

GET    /api/v1/stock                       filters: low, empty, category, bin
GET    /api/v1/ledger                      filters: item, operator, machine, date range; paginated
GET    /api/v1/alerts                      + POST /api/v1/alerts/{id}/ack
GET    /api/v1/alerts/summary              counts by level — the tablet idle banner
GET    /api/v1/machines, /reason-codes     pickers for the optional step (§12.6)
GET    /api/v1/reports/consumption         group_by: item | machine | operator | category | month
GET    /api/v1/reports/consumption.csv

# admin
CRUD   /api/v1/admin/items, /operators, /machines, /devices, /reason-codes
GET    /api/v1/admin/categories            picker for the item form
POST   /api/v1/admin/labels/print          Code128 label batch → PDF
                                           body: { item_ids[], copies? }
                                           storekeeper or admin; max 500 labels
GET    /api/v1/admin/health                DB, device last-seen, ledger reconciliation status

# store-cli — operations, not HTTP. Rust-only; point it at whichever database
# is live, including Supabase.
store-cli seed | reconcile | export | device-probe | backup | update
store-cli operator add | set-pin | list
# cloud equivalents (cd cloud): npm run seed  (--sql to print it)
#                                npm run operator -- add | set-pin | list
# reconcile, backup, export and device-probe stay Rust-only.
```

Auth: tablets hold a device token; admin uses operator login. Every write carries an
`operator_id` — there are no anonymous ledger rows.

A tablet is **not** an operator: it acts *for* whoever claimed the session, so a ledger
write from a tablet takes its `operator_id` from the session, never from the token. The
`Auth` extractor returns `None` for a tablet's operator id to force this at compile time.

> **The first admin cannot come from this API.** `/api/v1/admin/operators` requires an
> `ADMIN` token, which requires an `ADMIN` operator with a PIN, which on a fresh database
> does not exist — so the console is unreachable and nothing can create the person who
> would fix that. `store-cli operator add` is that bootstrap, and `seed` is not a
> substitute: it also inserts a demo catalog, and nobody should commission a real store by
> deleting a fake one. This grants no privilege the caller lacked — running it needs
> `DATABASE_URL`, and whoever holds that already owns every row.
>
> `npm run operator -- add` is the same command on the cloud side, and it exists
> because `store-cli` needs a Rust toolchain and a direct connection that a
> machine deploying only `cloud/` has neither of. Without it the deployed system
> had no way to reach its own console. The PIN is read from a hidden prompt, or
> from stdin when there is no terminal, so it never lands in shell history or the
> process list.

### Where the two implementations differ

| Endpoint | `crates/` | `cloud/` |
|---|---|---|
| `GET /reports/consumption`, `.csv` | yes | yes |
| `GET`, `POST /admin/operators` | yes | yes |
| `PATCH`, `DELETE /admin/operators/{id}` | — | yes |
| `GET /admin/devices` | yes | yes |
| `CRUD /admin/machines` | — | yes |
| `CRUD /admin/reason-codes` | — | yes |
| `GET /sessions/stream` | yes | **deliberately not** — §4's 2 s poll |
| `/auth/webauthn/*` (§8) | — | yes |
| serials, printer settings, `/labels/sheet`, `/items/browse`, `/version` | — | yes |

Two rules the cloud side adds, both of which exist because the console can now
reach places the CLI used to guard:

- **Deactivate, never delete** — operators, machines and reason codes all retire
  by `active = false`. Every one of them is pointed at by `stock_ledger`, and
  §7's claim that the history still answers "who took the forty inserts, on
  which machine, and why" survives exactly as long as those rows do.
- **The last active ADMIN cannot be removed or demoted**, by either verb, and
  the check runs inside the same transaction as the change so two admins cannot
  remove each other simultaneously. §11 already says the first admin cannot come
  from this API; without the guard, the last one can leave through it, and then
  nothing can create the person who would fix that.

Every one of these is reachable from the console: a **Reports** tab, and
**Setup → People / Machines / Reasons / Door**. An endpoint with no screen is
this project's known failure mode — built at both ends, never connected — so a
new endpoint is not finished until something can call it.

Status codes the tablet UX depends on:

| Situation | Code | What the tablet does |
|---|---|---|
| ISSUE past zero (§7) | `409` | *"Only 3 left in system — count the bin and adjust"* |
| Submit after close (§10) | `410` | re-opens the claim screen, keeps the typing |
| Second tablet claims (§10) | `409` | shows which tablet holds it |

---

## 12. Terminal UX (`cloud/src/screens/`, `crates/store-web/`)

Design for a shop-floor operator with oily gloves and no patience.

1. **Idle** — clock, store name, on-screen keyboard hidden. Low-stock banner if any EMPTY items.
2. **Claim** — punch arrives → large name cards, photo if available. Auto-advance if only one card.
3. **Direction** — two enormous buttons: **TAKE OUT** (red) / **PUT IN** (green). Nothing else.
4. **Item** — camera opens immediately for scanning (browser `BarcodeDetector`).
   A permanent **"Search instead"** button switches to typeahead. Both paths land on the
   same item card showing description, bin location and current on-hand. Where the
   browser has no barcode detector, the screen opens on search rather than on a
   camera that will not work.
5. **Quantity** — big numeric pad, `+1 / +5 / +10` chips. Default 1.
6. **Optional** — machine picker and reason chips, with a prominent **SKIP** button. Skipping
   must never be slower than filling.
7. **Confirm** — one line summary, big CONFIRM. Success screen shows the new on-hand and,
   if it crossed the reorder level, a clear *"This item is now LOW — storekeeper notified."*
8. Auto-return to idle after 15 s.

Target: **scan → qty → confirm in under 8 seconds.** If a screen doesn't serve that, cut it.

Offline: writes queue to a local **IndexedDB** outbox and flush when the LAN returns.
Queued rows are visibly marked pending. Server deduplicates on a client-generated
`txn_uuid`, generated once before the first attempt and never regenerated.

**Live view.** The same app serves a read-only dashboard — activity, stock, alerts —
updating off the event stream: SSE in `crates/`, the 2 s poll in the cloud (§4).
It is how the store is demonstrated and audited before the wall tablet exists,
and it moves no stock.

**Offline, in the cloud.** The outbox still works — the terminal accepts scans
and quantities with no network and flushes them when one returns, deduplicated
on `client_txn_uuid`. What it cannot do is *read*: a lookup, an on-hand figure
or a claim screen all need the server, which is now across the internet rather
than across the room. That is the §2 offline question in its concrete form.

---

## 13. Milestones — each gated by its acceptance test

Status as of the current branch. **In `crates/`: M0–M10 complete and gated.**
**In `cloud/`: M1, M3, M4 and M8 are now gated too** — each by a test that runs
in CI against a real Postgres with these migrations applied. What is left is
named below rather than buried:

- **M1 is gated by `cloud/tests/ledger-property.mjs`.** 10 000 random ledger
  ops through `src/lib/ledger.ts`, with `item_stock.on_hand` compared against
  `sum(delta_qty)` — by Postgres, in `numeric` — after every single one. Not a
  port of the Rust property test, because there is no fold on this side to
  check: what is unprovable anywhere else is that the TypeScript service drives
  the trigger correctly, appends one row per movement, and rolls back cleanly
  when the guard fires. Non-vacuity has its own deterministic issue-heavy run;
  the random walk cannot be trusted to hit zero, because the guard reflects it
  off zero and it then drifts upward.
- **M3 is gated by `cloud/tests/session-transitions.mjs`.** All 20 (state,
  event) pairs, with the same 12-legal / 8-refused split the Rust sweep
  asserts, plus the half that has no Rust counterpart at all: `effectiveState`,
  the derive-on-read rule that replaced the two reapers (§10). It needs no
  database, so it runs before Postgres is even up.
- **M4 is gated by `cloud/tests/e2e.mjs`.** Punch → claim → issue → on-hand
  falls → reversal, over HTTP against a real Postgres in CI, plus the §11
  status codes.
- **M8 is now gated on both halves.** `tests/reports-csv.mjs` checks the
  rendering against a hand-computed fixture; `tests/reports-db.mjs` checks the
  aggregation against a ledger it builds itself — receipts excluded from
  consumption, a reversal netting out, a fully-reversed item dropping out under
  `having`, and the month coming from `created_at` while `device_ts` claims six
  months later. It must run before the catalog seed, and asserts that
  precondition rather than assuming it.
  **It also found a real defect, since fixed:** `reverse()` did not copy the
  original row's `machine_id`, so reversing an issue booked to a machine left
  the machine charged for stock that came back and filed the credit under "no
  machine recorded" — which drove that bucket negative. Totals still
  reconciled, which is why nothing caught it. The reference implementation had
  it right (`crates/store-db/src/ledger.rs` passes both `machine_id` and
  `reason_id`), so the fix was parity rather than a new rule; the same commit
  refuses reversing a reversal, which `crates/` also refuses and the cloud
  allowed. `tests/reports-db.mjs` now asserts the reversing *row*, not only the
  report arithmetic, so the fix cannot migrate into the SQL.
- **M9's `reconcile` and `backup` are Rust-only.** They work, and they point at
  the same database, so the invariant is still checkable; it is checkable from a
  laptop with the connection string rather than from the deployment.
  `cloud/tests/e2e.mjs` now runs the reconciliation query itself as its ninth
  step, so CI fails on drift even though the CLI that reports it is Rust.

- **§8's passkey path is gated by `cloud/tests/webauthn.mjs`.** A CDP virtual
  authenticator stands in for the operator's phone, so `create()` and `get()`
  run through Chrome's real WebAuthn stack: register from Setup → Passkeys,
  sign in on the terminal with the credential, revoke it, and prove the revoked
  credential can no longer open a session. The session it opens records
  `identity_source = WEBAUTHN` with `manual_identity` still true, which is the
  §8 distinction the reports depend on. What it does not prove is a particular
  phone's secure enclave, the platform's own prompt, or a passkey bound to a
  public origin rather than localhost.

What remains beyond those: the live loop verified end to end against **Supabase**
— the e2e test proves the code and the schema, but runs against a local
`next start`, so cold starts, the pooler and internet latency are all absent, and
§9's ~200 ms budget is untested where it actually has to hold. Then the ADMS
capture against real firmware (§9's warning), printing a label sheet to close
M7's optical half, and the offline decision in §2. `DATABASE_URL` is set on
Vercel **Production only**. Preview deployments now have a schema to talk to —
`preview`, inside the production project, carrying these same migrations and
selected by `DATABASE_SCHEMA` (`cloud/src/lib/db.ts`), because the free
Supabase tier allows two active projects and both are spoken for. The
connection string itself still has to be pasted by whoever holds the Supabase
password, so until then a preview remains UI-only. See `CLOUD-PORT.md` and the
README.

| # | Deliverable | Acceptance gate |
|---|---|---|
| **M0** | Workspace, Postgres via Docker, sqlx migrations, CI (fmt, clippy `-D warnings`, test) | `cargo test` green; `migrate run` then `revert` leaves a clean schema |
| **M1** | `store-core`: items, ledger, invariants | Property test: 10 000 random ledger ops — `item_stock.on_hand` equals `SUM(delta_qty)` after every single one. Negative-stock guard holds |
| **M2** | `store-adms` + `mock_device` + `store-cli device-probe` | Mock device completes handshake, pushes 500 ATTLOG rows including a full duplicate retry batch → exactly 500 punches persisted |
| **M3** | Session state machine | Exhaustive transition tests: tailgating (2 unclaimed, 2 claims), expiry, double-claim rejection, post-close submit → `410` |
| **M4** | `store-server`: REST, auth, SSE | End-to-end integration test: mock punch → claim → issue 5 → on-hand drops by 5 → ledger row correct → SSE events observed in order |
| **M5** | `store-web` issue flow (scan + search) | Terminal loads on a phone; full issue against a live server over LAN; scan-to-confirm timed under 8 s |
| **M6** | Receipt (PUT IN) flow | Storekeeper adds 100 inserts; on-hand rises; ledger shows `RECEIPT` with unit cost |
| **M7** | Admin console: catalog CRUD, Code128 labels, stock views | Create item → print label → scan that printed label on the tablet → correct item resolves. **Software half proven** (label rastered at print resolution and decoded back through `/items/lookup`); the optical half needs a real printer and a real scan |
| **M8** | Alerts + reports | Issuing past the reorder level raises `LOW`, then `EMPTY` at zero; both appear on the dashboard and as a tablet banner; consumption-by-machine CSV matches a hand-computed fixture |
| **M9** | Hardening | Terminal offline outbox survives a LAN cut with zero duplicates — including the case where the request commits and the acknowledgement is lost; `store-cli backup` dumps, restores into a scratch database and compares before rotating; `store-cli reconcile` reports zero drift; installers for Linux (systemd) and Windows (WinSW) |
| **M10** | CI/CD + OTA | Tagged release publishes a draft to the public releases repo; `store-cli update --apply` verifies sha256, swaps and keeps `.old`; a new build reaches every device on next load. See `OTA-SETUP.md` |

Deferred to v2 — do not build: tool return/regrind, tool life, PO/GRN, Tally/ERP sync,
WhatsApp/email alerts, multi-store, vending-machine integration, mobile app for non-tablet phones.

---

## 14. Testing rules

- `store-core` is pure and must reach high coverage with unit and property tests (`proptest`).
- Integration tests use `sqlx::test` against a real throwaway Postgres. No mocked database.
- **No test may require the physical door terminal.** `MockIdentitySource` and `mock_device`
  exist so the whole system is testable on a laptop on a plane.
- Keep the raw ADMS capture from M2 as a fixture and replay it in CI forever. When firmware
  changes, that fixture is how you find out.

**The cloud app is still the thinner half of this, and pretending otherwise
would be the expensive mistake.** Its CI job is `typecheck`, `build`, the label
round-trip, the consumption CSV, the session sweep — and then, against a real
Postgres with `crates/store-db/migrations` applied verbatim, the report
aggregation, the ledger property test and `cloud/tests/e2e.mjs`.
That test drives M4's gate over HTTP: ADMS handshake, a punch and its identical
retry, claim, a second tablet refused, lookup, issue, `on_hand` falling by
exactly that much, a reversal, reconcile over every item, and `UPDATE`/`DELETE`
on `stock_ledger` refused by the trigger. It also pins the three status codes
§11 hangs terminal behaviour on — `409` past zero, `410` after close, `409` on a
second claim — because each is a branch in the UI where a wrong code fails
silently.

The e2e test is one path through the system, not a suite, and the three tests
written alongside it are what stop that from being the whole story:

| Test | Gate | Database |
|---|---|---|
| `tests/session-transitions.mjs` | M3 | none — the machine is pure |
| `tests/reports-db.mjs` | M8's aggregation half | yes, and it must run on an **empty ledger** |
| `tests/ledger-property.mjs` | M1 | yes |
| `tests/e2e.mjs` | M4 | yes |
| `tests/webauthn.mjs` | §8's passkey path | yes, and a headless Chrome |
| `tests/terminal-flow.mjs` | §12's issue flow, through the screens | yes, and a headless Chrome |
| `tests/db-schema.mjs` | the preview schema's isolation from `public` | yes |
| `tests/split-issue.mjs` | §11's split issue, and §7's guard on the total | yes |
| `tests/receipt-and-alerts.mjs` | M6, and M8's OK → LOW → EMPTY → OK ladder | yes |
| `tests/session-expiry.mjs` | §10's derive-on-read, through the routes | yes |
| `tests/adms-edges.mjs` | §9's rules 3 and 4 | yes |
| `tests/admin-guards.mjs` | §11's console rules | yes |

Two things about them are worth stating, because both were learned the hard
way rather than designed in:

- **A property test that never exercises its guard passes for the wrong
  reason.** The random ledger walk cannot be relied on to hit zero: §7's guard
  refuses the step that would cross it, which makes zero a reflecting barrier,
  so the balance drifts upward and refusals bunch into the first few dozen ops.
  One seed ran 200 operations without a single refusal. Non-vacuity therefore
  gets its own deterministic issue-heavy sequence, exactly as the Rust test
  does, and the random run's refusal count is reported but not asserted.
- **A report test that does not own the ledger is measuring the seed.** The
  consumption queries aggregate the whole table with no item filter, so
  `tests/reports-db.mjs` runs after `migrate` and before `npm run seed`, and
  asserts that the ledger is empty before it starts. Reordering the workflow
  fails it loudly instead of quietly changing every number.

- **§12's operator flow is gated by `cloud/tests/terminal-flow.mjs`.** Manual
  sign-in, TAKE OUT, search, quantity, skip, confirm — driven through the
  screens, then checked against the ledger, because a screen that says "done"
  and a row that exists are different claims. It found two defects on its first
  run, both invisible to every API-level test: manual sign-in was refused
  outright by the `sessions_identity_source_matches_punch` constraint 0007 added
  (the writer was never updated, so §10's only fallback — and the only way in
  before a reader is installed — had never worked), and the quantity pad
  appended to its default of 1, so tapping 2 booked 12.

- **§10's derive-on-read is enforced by the routes, not only defined.** The
  five files above were written after a coverage sweep found that the split
  issue, `POST /txn/receipt`, the alert ladder, §9's unknown-user and
  clock-drift rules, and §11's console guards had no test anywhere. Four of the
  five confirmed the code was right. The fifth found a real defect, since
  fixed, and it is the exact one §10 predicts in as many words:

  > *"Any new query that filters on `state` directly, rather than through the
  > helper that applies these two rules, reintroduces the bug — a session that
  > everyone can see is dead and the database still calls ACTIVE."*

  `touchSession` was `update sessions set last_activity_at = now() where id = $1
  and state = 'ACTIVE'`, and its own comment claimed this stopped a late
  keepalive resurrecting a closed session. It did the opposite. There are no
  reapers here, so a session idle for an hour is *stored* ACTIVE; the guard
  matched exactly the rows it was meant to exclude and pushed
  `last_activity_at` to now(). Observed: an issue answered `410`, one `/touch`
  answered `200`, and the next identical issue answered `200` and wrote a
  ledger row. The terminal fires that keepalive every 60 s and on every step,
  so the 180 s idle close could not close anything, and stock could be booked
  to an operator who had walked away. The same route also authenticated the
  caller without authorising the *session*, so any tablet could extend a
  session claimed at another one. Both fixed by putting `/touch` through
  `authoriseSession` like every other write, and by bounding the UPDATE with
  the same `IDLE_TIMEOUT_MS` the state machine reads.

- **A query that is not awaited can outlive the request, and on this platform
  that wedges the connection.** `authenticate` used to touch `last_used_at` and
  `last_seen_at` with `void sql\`…\`.catch(() => {})`. A serverless instance is
  frozen the moment its response is delivered, so an unawaited query can be
  suspended part-way through its protocol exchange; the backend is then left
  `active` on `ClientRead` holding an open transaction, and with `max: 1`
  (`db.ts`) that is the instance's only connection. `statement_timeout` cannot
  see it — nothing is executing — and neither can
  `idle_in_transaction_session_timeout`, because the session is not idle. Every
  later request on that instance queued until Vercel killed the function at
  300 s. Observed on 2026-08-31 as `GET /api/v1/admin/devices` hanging five
  times out of five, `pg_stat_activity` showing that SELECT parked for 4m55s,
  and the console reading *"did not answer within 25.2s"*. The rule is now
  gated by `tests/write-path.mjs`: **no `void sql` anywhere the server runs**,
  and `db.ts` bounds every query and transaction at `QUERY_DEADLINE_MS`, set
  above `statement_timeout` because it exists for what the database cannot
  report.

What is still not covered: `typecheck` cannot see the database, so a column
rename passes CI and fails at runtime anywhere these paths do not go. And
nothing asserts that a table added by a later migration enables RLS (§6) —
0008 covered the twenty that existed, and there is no default that turns it on
for the twenty-first.

The shared migrations remain what makes the rest survivable: the §7 trigger, the
negative-stock guard and the append-only constraint are the same objects in both
implementations, so the Rust suite proving them proves them for the cloud too.

---

## 15. Claude Code model routing (`.claude/agents/`)

| Agent | Model | Scope |
|---|---|---|
| `scaffolder` | haiku | Boilerplate, migrations, CRUD handlers, React form components |
| `builder` | sonnet | Default. Feature work, tests, UI |
| `architect` | opus | The ledger invariants (§7), the ADMS protocol (§9), the session state machine (§10), and any schema change |

Anything touching §7, §9 or §10 goes to `architect`. Those three sections are where a subtle
bug becomes an inventory that nobody trusts — which is the only way this product fails.

By path, that means `crates/store-core/src/{ledger,session}.rs`, `crates/store-adms/`,
`crates/store-db/migrations/` — **and their cloud counterparts**, which carry the
same rules with none of the compiler's help:
`cloud/src/lib/{ledger,session,sessions,punches,txn,adms}.ts` and anything that
changes the schema. A migration is an `architect` job wherever it is written,
because it is the one artefact both implementations share.

---

## 16. Working agreement

- Small commits, conventional commit messages, one milestone per branch.
- Update this file when a decision changes. A stale spec is worse than no spec.
- If a requirement here is ambiguous or looks wrong once you're in the code, **stop and ask**
  rather than guessing. Guessed inventory rules are expensive to unwind.
