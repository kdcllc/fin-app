# Goal 01 — Foundation & Scaffolding

**Milestone:** v0.1 · **Depends on:** none

## Objective

Stand up the Tauri 2.x application skeleton with the SQLite data layer, schema migrations, a clean core/UI separation (Actual Budget pattern: platform-agnostic core, thin shell), and a working dev loop on Linux.

## Success criteria

- `npm run tauri dev` launches the app window on Linux (primary dev OS).
- SQLite book file is created at a user-chosen location; schema v1 applied via migrations.
- Typed data-access layer: UI never issues raw SQL; all access goes through a repository/command layer.
- CI builds installable artifacts for Windows, macOS, and Linux on every push to main (git repo + GitHub remote are bootstrapped in task 1).

## Scoped execution note (2026-07-29)

By explicit user directive, orchestration was scoped to tasks 01.1-01.4 only.
Task 01.5 (CI) was deferred until a GitHub remote existed.

## Scoped execution note (2026-08-17)

GitHub remote now exists. User confirmed this cycle of 01.5 is **quality-checks Linux WebKitGTK/GTK deps only** so `cargo test` / `clippy` can compile on `ubuntu-latest`. 3-OS installable artifacts remain deferred (rest of 01.5 / Goal 07).

## Scoped execution note (2026-08-17, task 01.6)

User confirmed: fix all current `tsc` errors; add `tsc --noEmit` in a JS quality job **before** Rust work; parallelize JS vs Rust quality jobs; cheap Rust debug info in CI (`CARGO_PROFILE_*_DEBUG=0`). **Keep** the 3-OS Tauri matrix on every push/PR (do not move it to tags-only). Downloadable installers remain deferred.

## Tasks

1. [Scaffold Tauri 2.x + React + TypeScript app](tasks/01-scaffold-tauri.md)
2. [SQLite schema v1 + migrations](tasks/02-sqlite-schema.md)
3. [Data-access layer & typed API](tasks/03-data-access-layer.md)
4. [App shell: navigation, settings, book file management](tasks/04-app-shell.md)
5. [CI pipeline for 3-OS builds](tasks/05-ci-pipeline.md)
6. [Typecheck in CI and faster quality jobs](tasks/06-ci-typecheck-and-speed.md)
