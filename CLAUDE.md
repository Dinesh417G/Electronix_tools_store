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

Three binaries in one Cargo workspace:

1. **`store-server`** — Rust/Axum service on the store's server PC. Owns Postgres, the
   ZKTeco ADMS listener, the session state machine and the REST API.
2. **`store-tablet`** — Tauri 2 **Android** app. The issue/receipt terminal mounted in the store.
3. **`store-admin`** — Tauri 2 **desktop** app (Windows, runs on the server PC). Catalog,
   barcode labels, stock dashboard, reports, alert console.

---

## 2. Locked decisions — do not relitigate

| Decision | Value | Why |
|---|---|---|
| Backend language | Rust, Axum, tokio | House stack (ElectronIx DNC / MES) |
| Database | **PostgreSQL 16** on the server PC | Multiple tablets write concurrently; SQLite's single-writer model is wrong here |
| DB access | `sqlx` with compile-time checked queries, `sqlx::migrate!` | Same as DNC |
| Door hardware | Standalone **ZKTeco (or eSSL rebadge) terminal speaking ADMS "Push"** | Device pushes over plain HTTP — no vendor DLL, no Windows-only SDK |
| Who unlocks the door | **The terminal, on its own.** Never our software | Door must work when the server PC is off. We are observers, not the lock |
| Tablet client | **Responsive web app (PWA), served by `store-server`** — *changed, see below* | Runs on the phone in your pocket today and the wall tablet later; updates over the air with no signing key, no store review and no device visits |
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

---

## 3. Physical setup this software assumes

- **1× ZKTeco access terminal** at the store door (IN01-A / F18 / iClock class):
  fingerprint + RFID, TCP/IP, ADMS push, and its own relay outputs for the EM lock,
  exit button and door sensor.
- **1× server PC** inside the plant, static LAN IP, running Postgres + `store-server` + `store-admin`.
- **1–2 Android tablets** wall-mounted inside the store, on the same LAN.
- Optional **label printer** for bin barcodes (Code 128 of `item_code`).

The terminal is configured to point its ADMS server address at the server PC's IP and
our listener port. That is the entire integration surface.

---

## 4. Topology

```
 ┌──────────────────┐   ADMS/HTTP push    ┌───────────────────────────────┐
 │  ZK door terminal│ ──────────────────► │  store-server (Axum, :8080)   │
 │  (owns the lock) │  POST /iclock/cdata │                               │
 └──────────────────┘                     │  ┌─────────────────────────┐  │
                                          │  │ adms listener           │  │
 ┌──────────────────┐   REST + SSE        │  │ session state machine   │  │
 │  store-tablet    │ ◄─────────────────► │  │ ledger service          │  │
 │  (Android, LAN)  │                     │  │ alert engine            │  │
 └──────────────────┘                     │  └───────────┬─────────────┘  │
                                          └──────────────┼────────────────┘
 ┌──────────────────┐   REST                             │
 │  store-admin     │ ◄──────────────────────────────────┤
 │  (Windows)       │                              ┌─────▼─────┐
 └──────────────────┘                              │ Postgres  │
                                                   └───────────┘
```

Tablets subscribe to `GET /api/v1/sessions/stream` (SSE). When a punch arrives the server
emits an `session.opened` event and the tablet foregrounds the IN/OUT panel. No polling.

---

## 5. Repo layout

```
electronix-tool-store/
├── CLAUDE.md                  ← this file
├── Cargo.toml                 ← workspace
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

> ⚠️ **Verify before you trust this section.** Firmware families vary in casing, parameter
> names and stamp semantics. At M2, run `store-cli device-probe --listen 8080`, point a real
> terminal at it, and dump every raw request to disk. Reconcile this spec against that
> capture and update this file if they differ. Do not assume.

---

## 10. Session claim state machine (pure, in `store-core`)

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
- `ACTIVE` closes on submit, on explicit Done, or after 180 s idle.
- Transactions submitted after close are rejected `410 Gone`. The tablet then re-opens the
  claim screen rather than silently discarding the operator's typing.
- If no punch arrives (device down, network down), the tablet offers **"Enter manually"** →
  emp code + PIN via `ManualPinSource`. Those sessions are flagged `manual_identity = true`
  and shown distinctly in reports, because they are weaker evidence.

Model this as an exhaustive `match` over `(SessionState, SessionEvent)` returning
`Result<SessionState, TransitionError>`. Every illegal pair must be an explicit arm, not a
`_ => unreachable!()`.

---

## 11. API surface (`store-server`)

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
POST   /api/v1/sessions/{id}/close

GET    /api/v1/items/lookup?barcode=       resolve scan → item + on_hand + bin  (must be <100ms)
GET    /api/v1/items/search?q=             typeahead across item_code, description, iso_code, grade
GET    /api/v1/items/{id}

POST   /api/v1/txn/issue                   { session_id, item_id, qty, machine_id?, reason_id?, note? }
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

# store-cli — operations, not HTTP
store-cli seed | reconcile | export | device-probe | backup | update
```

Auth: tablets hold a device token; admin uses operator login. Every write carries an
`operator_id` — there are no anonymous ledger rows.

A tablet is **not** an operator: it acts *for* whoever claimed the session, so a ledger
write from a tablet takes its `operator_id` from the session, never from the token. The
`Auth` extractor returns `None` for a tablet's operator id to force this at compile time.

Status codes the tablet UX depends on:

| Situation | Code | What the tablet does |
|---|---|---|
| ISSUE past zero (§7) | `409` | *"Only 3 left in system — count the bin and adjust"* |
| Submit after close (§10) | `410` | re-opens the claim screen, keeps the typing |
| Second tablet claims (§10) | `409` | shows which tablet holds it |

---

## 12. Terminal UX (`store-web`)

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
updating off the SSE stream. It is how the store is demonstrated and audited before the
wall tablet exists, and it moves no stock.

---

## 13. Milestones — each gated by its acceptance test

Status as of the current branch: **M0–M10 complete and gated.** What remains is
not code: the ADMS capture against real firmware (§9's warning), and printing a
label sheet to close M7's optical half. See the README.

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

---

## 15. Claude Code model routing (`.claude/agents/`)

| Agent | Model | Scope |
|---|---|---|
| `scaffolder` | haiku | Boilerplate, migrations, CRUD handlers, React form components |
| `builder` | sonnet | Default. Feature work, tests, UI |
| `architect` | opus | The ledger invariants (§7), the ADMS protocol (§9), the session state machine (§10), and any schema change |

Anything touching §7, §9 or §10 goes to `architect`. Those three sections are where a subtle
bug becomes an inventory that nobody trusts — which is the only way this product fails.

---

## 16. Working agreement

- Small commits, conventional commit messages, one milestone per branch.
- Update this file when a decision changes. A stale spec is worse than no spec.
- If a requirement here is ambiguous or looks wrong once you're in the code, **stop and ask**
  rather than guessing. Guessed inventory rules are expensive to unwind.
