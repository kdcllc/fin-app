# Task 05.1 — GnuCash SQLite reader (read-only)

Status: todo

## Objective

Rust module that opens a GnuCash sqlite3 book **read-only** and exposes: schema-version check (`versions` table), account tree (guid, name, type, parent, commodity), and transactions+splits for chosen accounts/date windows.

## Notes

- Open with SQLite read-only flag — writes must be impossible on this code path.
- Detect XML books (gzip magic bytes instead of `SQLite format 3`) → guide user to File → Save As → sqlite3 in GnuCash.
- Amounts are numerator/denominator rationals — convert via the commodity fraction; expenses are splits on EXPENSE accounts (research §4).
- Refuse unknown schema versions with a clear message.
- Test fixture: small GnuCash book (few accounts, ~20 transactions) committed to the repo.

## Acceptance criteria

- Fixture book: account tree and transactions read correctly, amounts exact to the cent.
- XML book and unknown-schema cases produce guiding errors, not crashes.
