# Cloud port — Vercel + Supabase

> Decided 2026-08-26. This supersedes nothing in `CLAUDE.md` yet; when the port
> lands, §2's locked decisions must be rewritten to match or this file becomes
> the lie §16 warns about.

## What changed and why

The owner asked for a live public site: UI on Vercel, data in Supabase, no
dependency on a PC in the plant.

`store-server` cannot move to Vercel. It is a Rust/Axum process that holds an
SSE stream open, runs two background reapers (90 s unclaimed expiry, 180 s idle
close) and listens for ADMS pushes from the door terminal. Vercel runs
request-scoped serverless functions: no persistent process, no background
timers, Rust not a first-class runtime.

Given that, the owner chose a **TypeScript rewrite of the API on Vercel**, with
Supabase as Postgres. The Rust workspace stays in the repo — it is the
reference implementation, and its migrations are the schema of record.

### What this costs, honestly

- The §7 ledger invariant survives intact, because it was never in Rust: the
  append-only trigger, the negative-stock guard and the `item_stock` read model
  are all SQL, applied to Supabase unchanged.
- The §10 session machine must be rewritten. It was pure Rust with an
  exhaustive match; the port needs the same exhaustiveness or it stops being a
  state machine and becomes a pile of ifs.
- The two reapers have no home. Vercel Cron on hobby runs daily, which is
  useless against a 90 s expiry. **Resolution: derive state on read.** A session
  is EXPIRED if `state = 'UNCLAIMED' and opened_at < now() - 90s`, CLOSED if
  `state = 'ACTIVE' and last_activity_at < now() - 180s`. A cron sweep then
  becomes housekeeping rather than correctness.
- SSE becomes Supabase Realtime, subscribed from the browser.
- The ADMS listener needs a publicly reachable endpoint. A ZK terminal on the
  plant LAN cannot reach Vercel without the plant routing it out.
- **Offline is gone.** §2 chose Postgres on the server PC so the crib keeps
  working when the line's internet drops. Cloud-only means an outage stops all
  stock movement. Deferred decision, not a solved one.

## Supabase

| | |
|---|---|
| Project | `electronix-tool-crib` |
| Ref | `hhpmwnmubibracnwsmos` |
| URL | https://hhpmwnmubibracnwsmos.supabase.co |
| Region | ap-south-1 |

`electronix-store` was **paused** to free a free-tier slot (2 active projects
max). It holds an unrelated webshop schema — 114 products, 5 users, 0 orders —
and is restorable from the dashboard. It also has RLS disabled on all 21
tables; that is a live security hole and a separate job.

### Migrations applied

`0001_catalog` `0002_identity` `0003_ledger` `0004_reference_seed` `0005_auth`
— copied verbatim from `crates/store-db/migrations/`, so the trigger that makes
§7 structural came across with them.

`0006_tool_serials_and_printer` is new (below).

## New in this port

### Running serial numbers

One row per physical sticker, not per item.

```
tool_serial_seq        sequence
serial_settings        prefix + pad width, singleton   → "TC-000001"
next_tool_serial()     allocates the next formatted number
tool_serials           item_id, serial_no UNIQUE, minted, status,
                       print_count, first/last_printed_at
```

`serial_no` is **unique across the crib**, which is what makes "the same number
cannot be assigned to two tools" a database fact rather than a UI courtesy. It
stays editable — a hand-typed serial sets `minted = false` and is still unique.

Reprinting is the same number printed again: `print_count` increments, no new
row, no new number.

### Label printer

```
printer_settings   mode, host, port, dpi, label size, singleton
print_jobs         serial_id | item_id, copies, kind, status
```

`mode` exists because of a hard constraint: **a browser cannot open a raw
socket to a printer, and a serverless function in Vercel's cloud has no route
to a private LAN address.**

- `BROWSER_PDF` — the site renders the label and the operator prints it through
  the OS dialogue. Works everywhere, needs a human tap.
- `LAN_AGENT` — a small agent inside the plant polls `print_jobs` and sends ZPL
  to `host:port` itself. True unattended IP printing; it is a component that
  has to run in the shop.

The settings screen configures both; only one is live at a time.

### Seeding

`cloud/scripts/seed.mts` is `store-cli seed` again, in TypeScript — the Rust one
needs a toolchain and a direct connection, and this database is Supabase behind
a pooler. It reads the *same* `crates/store-cli/catalog/demo-catalog.csv` rather
than a copy, because two catalogs that drift apart is how the demo starts
disagreeing with the reference implementation. The parser is the same one,
including its refusals: quoted fields, a header that does not match, a bad UOM
and a negative opening balance are all errors with a line number.

```sh
cd cloud
npm run seed -- --sql          # prints the SQL, touches nothing
npm run seed                   # applies it; needs DATABASE_URL
npm run seed -- --catalog /path/to/real-catalog.csv
```

Everything it emits is idempotent, and an opening balance is booked only for an
item with no ledger history at all — so a re-run on a store that has since
issued stock does not re-open its balances. Opening stock is an `OPENING` ledger
row (§7), never a written quantity, attributed to the store's storekeeper or, if
there is none, its admin. `--demo-operators` adds the four demo logins; it is
off by default because their PINs are published in this repo and this
deployment is publicly reachable.

**Supabase now holds** 90 items across 8 categories, 9 machines, 9 vendor
barcodes and 88 `OPENING` rows — 80 items OK, 8 LOW, 2 EMPTY, which is what
gives the alert console and the tablet banner something to show. Verified by
digesting the DB rows and the CSV independently and comparing the hashes, and
`item_stock.on_hand` matches `sum(delta_qty)` for every item.

### Measuring the deployment

`cloud/scripts/probe-live.mts` answers the one §13 question the e2e test cannot:
the e2e proves the code and the schema, but it runs against a local
`next start`, where cold starts, Supavisor and the internet are all absent —
and those are exactly what §9's ~200 ms ADMS budget is exposed to. A device
that does not get `OK: <n>` fast enough retries, and a retried batch is a
duplicate punch unless the dedup index catches it.

```sh
cd cloud
.\scripts\probe-live.ps1              # read only, 5 rounds, prompts for the password
.\scripts\probe-live.ps1 -Write       # adds ONE real ATTLOG push
DATABASE_URL=... npm run probe -- --base https://...   # the script itself
```

The `.ps1` exists because `DATABASE_URL` is the Supabase connection string and
only the owner has it: it prompts non-echoing, percent-encodes the password
(a `%` in it is the documented `URI malformed` trap), builds the **pooler**
string on port 6543, and clears the variable from the shell afterwards. Passing
it as an argument would put it in the process list and in shell history.

It reports p50/p95/max per endpoint against the budgets §9, §11 and §4 state,
and holds the first request of the run out of the percentiles and prints it
separately — averaging a cold start away is how a cold-start problem stays
invisible. Exit code 1 on a breach or a failed request, so CI could run it.

Read-only by default, and still not zero-write: §11 auth guards every endpoint
being measured, and `STORE_ENROLMENT_SECRET` is stored Sensitive and cannot be
read back, so a tablet token is minted straight into `api_tokens` the way
`tests/e2e.mjs` does — inactive tablet row, 30-minute expiry, revoked when the
run ends. `--write` additionally leaves a punch and the session it offers,
which expires unclaimed after 90 s (§10); it never claims or issues, so it
writes no ledger rows.

What it does not answer: whether a real ZK terminal can reach the deployment at
all (§3's outbound route), or whether its firmware agrees with §9's parameter
names. Only the capture against real hardware settles those.

## Built

- [x] Next.js app, 35+ API routes ported from `crates/store-server/src/api/`
- [x] Session state machine in TS, exhaustive over (state, event)
- [x] Auth: tablet enrolment, operator PIN (argon2), SHA-256 token hashes
- [x] ADMS endpoints (`/iclock/*`), plain text, tab-separated
- [x] QR + Code128 label rendering (replaces the `store-label` crate)
- [x] Camera scanning with a torch toggle where the browser exposes it
- [x] Mobile audit of every screen at 390 px, admin included
- [x] Running serial numbers and label printer settings
- [x] Passkey sign-in (`0007`), a third identity source between door and PIN
- [x] A `cloud (next.js)` CI job — typecheck, build, label round-trip
- [x] Deployed to Vercel as a preview
- [x] Catalog seeded into Supabase from the CSV the Rust CLI reads
- [x] Consumption reports (M8) with CSV, and a fixture test in CI
- [x] Admin screens for people, machines, reasons and the door — every endpoint
      §11 asks for is now reachable from the console rather than by curl
- [x] `cloud/tests/e2e.mjs` — M4's gate against a real Postgres in CI, closing
      the §14 gap where no cloud test touched a database
- [x] `npm run operator` — the §11 bootstrap, which on a cloud-only machine did
      not exist (`store-cli` needs a Rust toolchain)

## Live

https://electronix-tool-crib.vercel.app

A stable alias, which matters beyond tidiness: a passkey is bound to an origin,
so sign-in was untrustworthy while every deployment had its own URL. Production
is on the database and answering database-backed routes.

## Environment — one variable left

**`STORE_ENROLMENT_SECRET` is set** on Production, Preview and Development
(2026-08-27, 32 random bytes, generated and pushed through `vercel env add`
without ever being printed). It is stored **Sensitive**, which means write-only:
`vercel env pull` returns the literal string `[SENSITIVE]`, and nobody — the
owner included — can read the value back. To enrol a tablet, set a new value and
redeploy, or mint the token directly against the database the way
`cloud/tests/e2e.mjs` does.

**`DATABASE_URL` is set on Production** (2026-08-27) and the site is live at
a stable alias, https://electronix-tool-crib.vercel.app. It is **not set on
Preview**, so preview deployments still answer "DATABASE_URL is not set" for
every database-backed route — harmless, but it means a preview cannot be used
to check anything real.

Setting it was the one step a person had to take, and it is worth recording why.
Claude drove the Supabase dashboard as far as the reset-password dialog and
stopped: typing or pasting a password into a credential field is refused, and
the rule holds even when the owner has asked for it, because it is the same
action whether the intent is good or not. Two attempts were blocked. The value
is stored **Sensitive**, so it cannot be read back to check — only replaced.

Three failures on the way in, each of which looked like a different problem:

| Symptom | Cause |
|---|---|
| `The specified Root Directory "cloud" does not exist` | `vercel deploy` run from inside `cloud/`. Root Directory is already `cloud`, so it looked for `cloud/cloud`. Deploy from the **repo root**. |
| `password authentication failed for user "postgres"` | The **direct** connection string (`db.….supabase.co:5432`) instead of the pooler. Supavisor strips the tenant suffix, so the error names plain `postgres` either way — it does not tell you which string you used. |
| `URI malformed` | A `%` in the password, unescaped. `%` is the URI escape character, so a bare one, or a `%` not followed by two hex digits, makes the decoder throw. |

Use the **pooled** string — port 6543, "Transaction", user
`postgres.hhpmwnmubibracnwsmos` — not the direct 5432 one: serverless opens a
connection per instance, and `db.ts` already sets `prepare: false` for that
pooler. Percent-encode the password rather than hand-editing it;
`[uri]::EscapeDataString($pw)` in PowerShell handles `%` first, which doing it
by hand usually does not.

The redeploy is not optional — Vercel bakes environment variables into a
deployment, so an existing one will not see them.

`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` need no value: the code falls back to the
request's own hostname and origin. Note that preview URLs change per
deployment, so a passkey registered against one preview will not work on the
next — an argument for a stable domain.

## Then

1. **Verify the live loop against Supabase.** `cloud/tests/e2e.mjs` now drives
   the whole loop — handshake → punch and its retry → claim → lookup → issue →
   on-hand falls → reversal → reconcile → the §11 status codes — but against a
   local `next start` and a throwaway Postgres, which is what CI runs. That
   proves the code and the schema. It does not prove the deployment: cold
   starts, the pooler and internet latency are all absent, and §9's ~200 ms
   ADMS budget is exactly the thing that only fails in their presence. Pointing
   the same test at the live origin needs a token minted against Supabase.
2. **Set `DATABASE_URL` on Preview**, or accept that previews are UI-only.
3. **Decide the offline question** (above). It is parked, not solved, and
   `CLAUDE.md` §2 now says so in as many words.

The catalog is loaded (see **Seeding** above), and `CLAUDE.md` §2 was rewritten
to describe where this actually runs.

## Deployment notes worth keeping

- `cloud/vercel.json` pins `"framework": "nextjs"`. Without it the project
  builds every route successfully and the edge still answers
  `X-Vercel-Error: NOT_FOUND` for every path, because the routing was never
  told it was Next.
- The project's Root Directory is `cloud`, so `vercel deploy` runs from the
  **repo root**; running it inside `cloud/` makes Vercel look for `cloud/cloud`.
  The root `.vercelignore` keeps the Rust workspace out of the upload.
- Read the build log before believing a deployment. A build that completes in
  264 ms installed nothing and built nothing, and still says `● Ready`. The
  project that first attempt created, `tools_store`, 404’d on every path and
  posted a green check on every PR regardless; it was deleted on 2026-08-27.
