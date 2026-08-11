# ElectronIx Tool Store

Tool-crib management for a CNC tooling store — carbide inserts, end mills,
drills, taps, holders and shop consumables.

The build spec is [`CLAUDE.md`](CLAUDE.md). **Read it before changing anything**;
where this README and that file disagree, that file wins.

Putting it into a real store for the first time?
**[`COMMISSIONING.md`](COMMISSIONING.md)** is the ordered checklist for that —
Postgres through to the first watched transaction, with what you should see at
each step.

## What works today

All ten milestones (**M0–M10**) are complete and passing their acceptance gates
(§13). The physical loop runs end to end:

```
door terminal pushes a punch  →  server persists it and offers a session
      →  tablet claims it  →  scan  →  qty  →  confirm
      →  ledger row appended, on-hand recalculated, alert raised if crossed
```

| Crate | State |
|---|---|
| `store-core` | Complete. Ledger invariants (§7), session machine (§10), `IdentitySource` (§8). |
| `store-adms` | Complete. ADMS protocol, command queue, mock device. |
| `store-db` | Complete. Migrations, repositories, auth. |
| `store-server` | REST + SSE + ADMS listener, session service, reaper. |
| `store-cli` | `seed`, `operator`, `reconcile`, `export`, `device-probe`, `backup`, `update`. |
| `store-label` | Code128 + PDF bin labels. |
| `store-web` | Terminal, live view and admin console. Embedded in `store-server`. |

### The terminal is a web app now

`CLAUDE.md` §2 originally locked the tablet client to Tauri 2 / Android. That
decision changed, and the file records why: the wall tablet does not exist yet,
and a web terminal runs on a phone today, scales to the tablet unchanged, and
updates over the air with no signing key and no device visits.

Open the server's address on any phone on the plant LAN, enrol it once with the
shared secret, and it is a terminal. Add it to the home screen and it behaves
like an app.

Barcode scanning uses the browser's `BarcodeDetector` — present on Android
Chrome, absent on iOS Safari. Where it is missing the terminal opens on search
instead of a camera that will not work.

## Running it

Needs Rust (1.82+) and PostgreSQL 16.

```sh
createdb electronix_store
export DATABASE_URL=postgres://localhost/electronix_store
export STORE_ENROLMENT_SECRET=pick-something-long

cd crates/store-web && npm ci && npm run build && cd ../..
cargo run -p store-cli -- seed        # demo catalog, operators, machines
cargo run -p store-server             # migrates on boot, listens on :8080
```

For a **real** store, skip `seed` — it inserts a demo catalog and four fictional
people. Start the server first so it creates the schema, then make the first
admin, who can do everything else from the console:

```sh
echo 8341 | store-cli operator add --emp-code E9001 --name "S. Rao" --role ADMIN --zk-user-id 9001
store-cli operator list
```

That command exists because the console cannot bootstrap itself: creating an
operator needs an admin token, and on a fresh database there is no admin. It
grants nothing extra — it needs `DATABASE_URL`, and whoever has that already
owns every row.

Then open `http://<server-ip>:8080` on a phone on the same network, enrol it with
the secret above, and you have a terminal. The ⚙ button in the corner switches
between the terminal and the live view.

Point the door terminal's ADMS server address at the server PC and port 8080.
That is the entire integration surface — the terminal owns the lock and opens
it on its own (§2), so the door keeps working when this software does not.

### Walking through it without hardware

```sh
# The terminal's boot handshake
curl "localhost:8080/iclock/cdata?SN=ZK-01&options=all"

# A fingerprint punch for terminal user 1042
printf '1042\t2026-08-07 14:32:11\t0\t2\t0\t0' \
  | curl -X POST --data-binary @- "localhost:8080/iclock/cdata?SN=ZK-01&table=ATTLOG"

# Register a tablet, then look at the claim screen
TOKEN=$(curl -s -X POST -H 'content-type: application/json' \
  -d '{"tablet_id":"TAB-1","enrolment_secret":"pick-something-long"}' \
  localhost:8080/api/v1/auth/tablet | jq -r .token)

curl -H "authorization: Bearer $TOKEN" localhost:8080/api/v1/sessions/unclaimed
```

## Before trusting the ADMS notes

§9 carries a warning worth repeating: ZK firmware families differ in casing,
parameter names and stamp semantics. Before going live, capture real traffic:

```sh
cargo run -p store-cli -- device-probe --listen 8080 --out-dir adms-capture
```

Point a real terminal at it, punch a few times, then reconcile §9 against what
the capture actually contains and update `CLAUDE.md` if they differ. Keep the
capture as a CI fixture (§14) — when firmware changes, that fixture is how you
find out.

## The admin console

Same address, ⚙ → Admin, then an employee code and PIN (`ADMIN` or
`STOREKEEPER` only). Catalog CRUD, stock views, the alert console, the ledger
with one-tap reversal, and Code128 bin labels as a printable PDF.

`CLAUDE.md` §2 originally put this in a Tauri desktop app. It moved here for the
same reason the terminal did, plus one: the admin runs *on the server PC*, which
is already running `store-server` — a second binary would mean a second
installer and a second OTA channel to reach the one machine that is by
definition already up to date.

### About the label gate

M7's gate is "create item → print label → scan that printed label → correct item
resolves". The software half is proven in CI: the label PDF is rastered into a
scan line at 203–1200 dpi and decoded by an independent Code128 reader, then fed
back through `/api/v1/items/lookup`.

**The optical half is not proven.** Toner spread, printer calibration and camera
focus need a real sheet and a real scan. Print one before trusting it in
production — that is a ten-minute job and it is the only thing between here and
a closed gate.

## Installing on a store PC

```sh
# Linux
sudo deploy/linux/install.sh

# Windows (elevated PowerShell, with WinSW beside the script)
.\deploy\windows\Install-StoreServer.ps1 -WinSwPath .\WinSW-x64.exe
```

Both install the server as a service, generate an enrolment secret, and schedule
the nightly backup for 02:15. Neither touches PostgreSQL — a tool crib's database
should be set up deliberately, with a password somebody chose.

Re-running upgrades in place and keeps `store-server.old`, so a rollback is one
rename. Uninstalling leaves the database, the config and the backups alone.

## Backups

```sh
store-cli backup --out-dir /var/backups/electronix-store --keep 14
```

More than a `pg_dump`: it reconciles the ledger first (a drifted database is
still backed up, but the filename says `DRIFTED`), restores the dump into a
scratch database, and checks the restored ledger against the original before
rotating. A backup nobody has ever restored is a hope, not a backup.

Installed as a systemd timer or a scheduled task, nightly at 02:15.

## Updates

Two channels, documented in full in [`OTA-SETUP.md`](OTA-SETUP.md):

```sh
store-cli update --check        # what's available
sudo systemctl stop store-server
store-cli update --apply        # verifies sha256, swaps, keeps store-server.old
sudo systemctl start store-server
```

Phones and tablets need nothing: the terminal is embedded in the server binary,
so replacing the server replaces the UI, and each device is offered a reload on
its next load. Rollback is one rename.

## Development

```sh
# The web terminal (store-server embeds the built bundle)
cd crates/store-web && npm ci && npm run build

cargo test --workspace          # needs DATABASE_URL; creates throwaway databases
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p store-cli -- reconcile
```

`store-server` builds without Node installed — it then serves a page saying
which command is missing, rather than failing to compile. The API and the door
listener do not depend on the UI.

For UI work, `npm run dev` in `crates/store-web` proxies to a `store-server` on
:8080 with hot reload.

Queries are compile-time checked (§2). After changing any SQL, regenerate the
offline data or CI's no-database build will fail:

```sh
cargo sqlx prepare --workspace -- --all-targets
```

### The offline outbox

§12 queues writes to IndexedDB when the LAN drops and flushes them when it
returns. The failure that matters is not the request that never arrives — it is
the one that **arrives, commits, and whose acknowledgement is lost**. The tablet
cannot tell those apart, so it retries.

The server answers such a retry from the ledger, *before* it authorises the
session. That ordering is load-bearing: §10 closes a session on submit, so every
replay arrives at a closed session, and authorising first would answer `410 Gone`
for a transaction already recorded. The operator would be told it was not saved
and would re-enter it by hand — a real duplicate, created by the mechanism meant
to prevent one.

Proven both ways: `crates/store-server/tests/outbox_soak.rs` for the server
property, and `crates/store-web/tests/outbox-soak.mjs`, which drives a real
browser through a real cut including a deliberately discarded acknowledgement.

### The one rule to internalise

Stock is never a number you update. Stock is the sum of a ledger (§7).

`item_stock.on_hand` is a cached read model maintained by a trigger; there is no
`UPDATE item_stock` anywhere in application code, and `stock_ledger` refuses
`UPDATE` and `DELETE` outright. `store-cli reconcile` proves the two agree, and
**any drift is a bug** — not a data-entry problem to be corrected by hand.

That single decision is what makes "log history" and "current stock" the same
object rather than two things that quietly disagree after six months.
