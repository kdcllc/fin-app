---
name: gnucash-data-model
description: Canonical GnuCash integration reference for fin-app — storage backends, data model (accounts/transactions/splits/rationals), and the non-negotiable safety guardrails for reading and writing GnuCash books. MANDATORY reading for any task that opens, parses, or writes a GnuCash file. Distilled from docs/RESEARCH.md §4.
---

# GnuCash Data Model & Integration Guardrails

GnuCash's file formats are **not a public API** (per its own wiki). Everything here exists because safety comes from process discipline, not GnuCash guarantees. Full sources: `docs/RESEARCH.md` §4 and §6.

## Backends

- Books are compressed **XML** (default) or **SQLite3** (also PostgreSQL/MySQL). fin-app integrates **only with sqlite3 books**.
- Detect format by magic bytes: `SQLite format 3\0` vs gzip (`\x1f\x8b`). XML book → guide the user: GnuCash → File → Save As → sqlite3 (one-time). Never parse or write the XML.
- GnuCash loads the whole book into memory at startup and **never re-reads the DB**; its `gnclock` lock table is advisory only ("weak protection").

## The three integration tiers

1. **Read — any time.** Open with SQLite **read-only flag** (enforced in code, not convention). Concurrent reads while GnuCash runs are safe per its docs (may be momentarily stale).
2. **Write — only when GnuCash is closed**, via the write-session sequence below.
3. **Fallback — QIF/CSV export** for GnuCash's built-in importer (duplicate detection included). Zero risk; use whenever write preconditions can't be met.

## Write-session sequence (all steps mandatory, in order)

1. `gnclock` has any row → **refuse** ("Close GnuCash first"). No force option, ever.
2. `versions` table schema version unknown → **refuse**.
3. Copy the book file to a timestamped backup; verify the copy (size/hash) before proceeding. (GnuCash makes NO automatic backups for SQL backends.)
4. Insert our own `gnclock` row (hostname, PID); open an exclusive SQLite transaction.
5. Write only `transactions` and `splits` (+ `accounts` only if explicitly requested). **Never touch `slots` or `versions`** — GnuCash rewrites an object's slots wholesale on edit; out-of-band slot writes vanish or corrupt.
6. Commit as one SQL transaction; remove our `gnclock` row; close.
7. Verify: re-open read-only, re-read written GUIDs, check invariants.

Reference implementation for field-level semantics: **piecash** (github.com/sdementen/piecash, community fork github.com/gorf/piecash).

## Data model essentials

- **Accounts**: a tree (every non-root has a parent); types include BANK, CASH, CREDIT, LIABILITY, INCOME, **EXPENSE**, EQUITY, ROOT. Each account has a commodity (currency) with a `fraction` (100 = cents). Placeholder accounts may not carry splits.
- **Transactions & splits (double-entry)**: a transaction has currency, `post_date`/`enter_date`, description, and 2+ splits. Each split references one account and stores `value` and `quantity` as integer **numerator/denominator rationals** (denominator = commodity fraction). **Invariant: sum of `value` across a transaction's splits = 0.** Violations create Imbalance-* artifacts in GnuCash.
- **An "expense" is not a record type**: it's a balanced transaction — positive-value split on an EXPENSE account, negative-value split on the funding BANK/CREDIT account.
- **GUIDs**: every object keyed by a 32-char lowercase hex GUID; generate new ones for inserts (UUID4 without dashes).
- **Dates**: stored as strings in GnuCash's exact formats — match what GnuCash 5.x itself writes (check the fixture book, don't guess).
- **fin-app mapping**: `accounts.gnucash_guid` ↔ BANK/CREDIT accounts; `categories.gnucash_guid` ↔ EXPENSE accounts. The mapping table is the heart of the integration.

## Testing rules

- All GnuCash tests run against a **fixture sqlite3 book** committed to the repo — never the user's real book.
- Round-trip test for every writer: write → re-open in read-only → validate balance invariant → (manually, once per release) open in real GnuCash and run Check & Repair.
- Amounts asserted exact to the cent, including edge values ($10,673.91; $0.01).
