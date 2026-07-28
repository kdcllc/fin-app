# Goal 06 — GnuCash Direct Write (Guarded)

**Milestone:** v0.4 · **Depends on:** Goal 05

## Objective

Optional direct write of bill payments into the GnuCash SQLite book (research §4, tier 2). GnuCash's formats are not a public API and its lock is advisory-only, so every write is wrapped in hard preconditions. piecash's semantics are the reference implementation.

## Non-negotiable guardrails (from GnuCash docs)

- **Never write while GnuCash is open** — refuse if the `gnclock` table has a row; never offer a "force" option.
- Verify the schema version (`versions` table) before writing; refuse on unknown versions.
- Copy the book file as a backup before every write session (GnuCash makes no automatic backups for SQL backends).
- Take our own lock (`gnclock` row with hostname/PID) for the write session; release after.
- Write only `transactions` + `splits` (+ new `accounts` if explicitly requested). Never touch `slots` or `versions`.
- Each payment = one balanced transaction: positive-value split on the EXPENSE account, negative-value split on the funding account; values as numerator/denominator rationals; sum of split values = 0; 32-hex GUIDs; single SQL transaction per logical change.

## Success criteria

- A payment written by fin-app opens correctly in GnuCash: right accounts, amounts, dates, no Imbalance splits, no data-integrity warnings.
- Attempting a write while GnuCash is open is refused with a clear message.
- Every write session leaves a timestamped backup; a post-write verification re-reads and validates the inserted rows.

## Tasks

1. [Write-session preconditions & locking](tasks/01-preconditions.md)
2. [Balanced transaction + splits writer](tasks/02-transaction-writer.md)
3. [Write UX, verification & rollback](tasks/03-write-ux-verification.md)
