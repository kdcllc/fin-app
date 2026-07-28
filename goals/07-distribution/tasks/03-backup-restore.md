# Task 07.3 — Backup & restore of the book file

Status: todo

## Objective

The app owns responsibility for the user's data file: automatic rotating backups of the fin-app SQLite book (before every schema migration, plus scheduled), and one-click restore.

## Notes

- Backup = timestamped copy in a `backups/` folder next to the book (visible, user-owned — consistent with local-only philosophy); retention configurable (default: last 20).
- Always back up before applying schema migrations (hook into Task 01.2's migration runner).
- Restore flow: pick a backup → current book is itself backed up first → replace → reopen.
- Settings surface: backup location, retention, last-backup time.

## Acceptance criteria

- Migration on a seeded book leaves a pre-migration backup; restoring it returns the app to the prior version's data (and re-migrates on next open).
- Scheduled backup fires and rotates correctly past the retention limit.
