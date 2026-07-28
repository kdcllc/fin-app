# Task 01.3 — Data-access layer & typed API

Status: done (judge PASS 4/5, 2026-07-28)
Depends on: 02-sqlite-schema

## Objective

Actual Budget's core lesson (research §3): keep domain logic platform-agnostic and separate from the UI shell. Build a repository layer so React components never issue raw SQL.

## Notes

- TypeScript `core/` package: entity types, repository functions (`payments.list({from, to, payeeId})`, `payees.upsert(...)`, …), all SQL centralized here.
- Decide and document the boundary: business logic in TS over `tauri-plugin-sql` (default), Rust commands only where Rust is genuinely needed (xlsx parsing, GnuCash file access).
- Unit-test repositories against an in-memory/temp SQLite DB. **Test strategy:** repositories are written against a minimal DB interface (`execute`/`select`); the app wires a `tauri-plugin-sql` adapter, while Vitest wires a Node SQLite driver (better-sqlite3) — so `npm test` runs without the Tauri runtime.

## Acceptance criteria

- UI imports only from `core/` — no SQL strings outside it (lint rule or convention documented).
- Repository unit tests run with `npm test` and pass in CI.
