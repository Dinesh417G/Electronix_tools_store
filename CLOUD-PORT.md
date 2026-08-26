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

## Live

https://electronix-tool-crib-3il59edm4-dinesh417gs-projects.vercel.app

Serving the UI and answering `/api/v1/version`. Every database-backed endpoint
returns "DATABASE_URL is not set" until the step below is done.

## The two things only the owner can do

Claude does not enter credentials, and cannot read the Supabase password or
service-role key through its tooling. From the repo root:

```sh
npx vercel env add DATABASE_URL preview            # Supabase → Settings → Database
npx vercel env add STORE_ENROLMENT_SECRET preview  # pick a fresh one
npx vercel deploy --yes --scope dinesh417gs-projects
```

Use the **pooled** Supabase connection (port 6543, "Transaction"), not the
direct 5432 one: serverless opens a connection per instance, and `db.ts`
already sets `prepare: false` for that pooler.

The redeploy is not optional — Vercel bakes environment variables into a
deployment, so an existing one will not see them.

`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` need no value: the code falls back to the
request's own hostname and origin. Note that preview URLs change per
deployment, so a passkey registered against one preview will not work on the
next — an argument for a stable domain.

## Then

1. **Seed a catalog.** Supabase currently holds 1 operator, 8 reason codes, and
   **no items or machines** — the terminal will sign an operator in and have
   nothing to issue. Either port `crates/store-cli/catalog/demo-catalog.csv`
   (90 items, 9 machines) or load the real one.
2. **Verify the live loop**: enrol → punch at `/iclock/cdata` → claim → issue →
   ledger row → `reconcile` clean.
3. **Update `CLAUDE.md` §2.** It still describes the Rust deployment and locked
   Postgres to the server PC. §16 says that file wins and must be updated when
   a decision changes; leaving it is exactly the stale spec §16 warns about.
4. **Decide the offline question** (above). It is parked, not solved.
5. Delete the stray empty Vercel project `tools_store`, left by a first attempt
   that built nothing and still reported Ready.

## Deployment notes worth keeping

- `cloud/vercel.json` pins `"framework": "nextjs"`. Without it the project
  builds every route successfully and the edge still answers
  `X-Vercel-Error: NOT_FOUND` for every path, because the routing was never
  told it was Next.
- The project's Root Directory is `cloud`, so `vercel deploy` runs from the
  **repo root**; running it inside `cloud/` makes Vercel look for `cloud/cloud`.
  The root `.vercelignore` keeps the Rust workspace out of the upload.
- Read the build log before believing a deployment. A build that completes in
  264 ms installed nothing and built nothing, and still says `● Ready`.
