# Task 01.4 — App shell: navigation, settings, book file management

Status: done (judge PASS 4/5, 2026-07-29)
Depends on: 03-data-access-layer

## Objective

The application frame everything else plugs into: sidebar navigation (Dashboard, Bills Grid, Payments, Reports, Import, GnuCash, Settings), a settings store, and book-file management. The first-run book-location prompt introduced here **supersedes task 02's fixed default dev path** (existing default-path DBs are picked up or moved).

## Notes

- First-run flow: choose where the book (SQLite file) lives — user-visible, easy-to-back-up location, not buried in app-data (research: local-only, user-owned data).
- Settings persisted (book path, default year, backup preferences).
- Light/dark theme following OS preference.

## Acceptance criteria

- First run prompts for book location and creates the DB there; subsequent runs open it.
- "Open book folder" action reveals the file in the OS file manager.
- Navigation between placeholder pages works; settings survive restart.
