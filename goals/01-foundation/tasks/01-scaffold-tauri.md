# Task 01.1 — Scaffold Tauri 2.x + React + TypeScript app

Status: todo
Depends on: none

## Objective

Create the Tauri 2.x project (`npm create tauri-app@latest` → React + TypeScript + Vite template) in this repo, initialize version control, and verify the dev loop works on Linux.

## Notes

- App identifier e.g. `com.kdcllc.finapp`; window title "fin-app".
- Linux needs WebKitGTK dev packages (`libwebkit2gtk-4.1-dev` etc.) — document prerequisites in the project README.
- Set up ESLint + Prettier + `cargo fmt`/`clippy` from the start.
- **Version-control bootstrap (local only — user decision 2026-07-28):** `git init` with a proper `.gitignore` (node_modules, target, dist, `*.xlsx` — the workbook is real financial data), initial commit on `main`. No GitHub remote for now; task 05 (CI) stays blocked until the user decides to add one.

## Acceptance criteria

- `npm run tauri dev` opens the app window with hot reload working.
- `npm run tauri build` produces a runnable Linux binary.
- Repo has README with dev-environment setup steps.
- Git repo initialized on `main` with the initial commit made locally (`git log` shows it; `*.xlsx` untracked).
