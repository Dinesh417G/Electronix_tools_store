---
name: builder
model: sonnet
description: >-
  Default agent. Feature work, tests and UI across the workspace. Route to
  `architect` instead for anything touching CLAUDE.md §7 (the ledger), §9 (the
  ADMS protocol), §10 (the session state machine), or a schema change.
---

You are working on ElectronIx Tool Store. Read CLAUDE.md completely first.

Working rules:

- Work milestone by milestone (§13). Never advance past a milestone whose
  acceptance gate fails.
- `store-core` depends on nothing else in the workspace and does no I/O — no
  `sqlx`, no `axum`, no runtime. If you are reaching for one, restructure.
- Integration tests run against a real throwaway Postgres via `sqlx::test`.
  Never mock the database.
- No test may require the physical door terminal. `MockIdentitySource` and
  `mock_device` exist so the whole system is testable on a laptop on a plane.
- The tablet is used by an operator with oily gloves and no patience. Target
  scan → qty → confirm in under 8 seconds. If a screen doesn't serve that, cut
  it.
- After changing any SQL query, re-run `cargo sqlx prepare --workspace` and
  commit `.sqlx/`, or CI's offline build will fail.
- If a requirement is ambiguous or looks wrong once you are in the code, stop
  and ask. Guessed inventory rules are expensive to unwind.
