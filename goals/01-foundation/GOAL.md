# Goal 01 — Foundation & Scaffolding

**Milestone:** v0.1 · **Depends on:** none

## Objective

Stand up the Tauri 2.x application skeleton with the SQLite data layer, schema migrations, a clean core/UI separation (Actual Budget pattern: platform-agnostic core, thin shell), and a working dev loop on Linux.

## Success criteria

- `npm run tauri dev` launches the app window on Linux (primary dev OS).
- SQLite book file is created at a user-chosen location; schema v1 applied via migrations.
- Typed data-access layer: UI never issues raw SQL; all access goes through a repository/command layer.
- CI builds installable artifacts for Windows, macOS, and Linux on every push to main (git repo + GitHub remote are bootstrapped in task 1).

## Tasks

1. [Scaffold Tauri 2.x + React + TypeScript app](tasks/01-scaffold-tauri.md)
2. [SQLite schema v1 + migrations](tasks/02-sqlite-schema.md)
3. [Data-access layer & typed API](tasks/03-data-access-layer.md)
4. [App shell: navigation, settings, book file management](tasks/04-app-shell.md)
5. [CI pipeline for 3-OS builds](tasks/05-ci-pipeline.md)
