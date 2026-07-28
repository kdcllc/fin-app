# Task 06.1 — Write-session preconditions & locking

Status: todo

## Objective

The guardrail layer every direct write must pass through (research §4 tier 2; GOAL.md guardrails). No write code path may exist outside this session wrapper.

## Session sequence

1. Check `gnclock` — any row present → **refuse** ("Close GnuCash first"). No force option.
2. Verify schema version in `versions` — unknown → refuse.
3. Copy the book file to a timestamped backup (`book.gnucash.finapp-backup-YYYYMMDD-HHMMSS`); verify the copy (size/hash) before proceeding.
4. Insert our own `gnclock` row (hostname, PID) + open SQLite exclusive transaction.
5. Yield a write handle to the caller.
6. On completion or any error: rollback if needed, remove our `gnclock` row, close.

## Notes

- Backup retention: keep last N (configurable, default 10).
- A crash mid-session must not leave a stale lock silently: on next open, detect our own stale gnclock row (hostname+PID no longer running) and offer cleanup.

## Acceptance criteria

- Tests: lock present → refusal; unknown schema → refusal; error mid-write → rollback + lock released + book intact (hash equal to backup).
- Backup file exists and is a valid SQLite book after every write session.
