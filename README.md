# ElectronIx Tool Store

Tool-crib management for a CNC tooling store — carbide inserts, end mills,
drills, taps, holders and shop consumables.

The build spec is [`CLAUDE.md`](CLAUDE.md). **Read it before changing anything**;
where this README and that file disagree, that file wins.

## What works today

Milestones **M0–M6** are complete and passing their acceptance gates (§13), plus
the server half of **M8** and the CI/CD + OTA work (**M10**). The physical loop
runs end to end:

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
| `store-cli` | `seed`, `reconcile`, `export`, `device-probe`, `update`. |
| `store-web` | Mobile-first terminal + live view. Embedded in `store-server`. |
| `store-admin` | **Not built.** M7 — Tauri 2 desktop. |

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

### The one rule to internalise

Stock is never a number you update. Stock is the sum of a ledger (§7).

`item_stock.on_hand` is a cached read model maintained by a trigger; there is no
`UPDATE item_stock` anywhere in application code, and `stock_ledger` refuses
`UPDATE` and `DELETE` outright. `store-cli reconcile` proves the two agree, and
**any drift is a bug** — not a data-entry problem to be corrected by hand.

That single decision is what makes "log history" and "current stock" the same
object rather than two things that quietly disagree after six months.
