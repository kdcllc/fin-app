# Goal: gnucash-read-export

## Problem Statement

fin-app tracks bill payments but is blind to the user's GnuCash book: bank activity in
GnuCash never reconciles against logged bills, and payments recorded in fin-app must be
re-typed into GnuCash by hand. The "GnuCash" nav item is a placeholder page. This goal
delivers the v0.3 milestone (archived Goal 05): safe read-only integration with the
GnuCash sqlite3 book (account tree, transaction import with dedup), persistent
account/category GUID mapping, QIF **and** CSV export for GnuCash's import assistant,
and a reconciliation view. Direct writes to the GnuCash book are a separate, later goal.

## Discovery Summary (Phase 1 Q&A)

- **Execution plan**: run this goal in parallel with `distribution-auto-update`; this
  goal has priority on contention. GnuCash direct write is deferred until the user
  explicitly green-lights it after this goal ships.
- **Book format**: app detects the book format; XML books get a guiding walkthrough to
  the one-time GnuCash File → Save As → sqlite3 conversion. Detection built regardless.
- **Import scope**: user picks specific accounts from the GnuCash account tree in the
  UI; the selection is remembered across sessions.
- **Export format**: BOTH QIF and CSV.
- **UI placement**: everything lives on the existing "GnuCash" nav page as
  sections/tabs: link book, account mapping, import, export, reconcile.
- **Error behavior**: missing/moved book or unknown schema version shows a clear
  blocking message with a re-link/fix prompt on the GnuCash page only; the rest of the
  app is unaffected.

## Success Criteria

- [ ] With a linked sqlite3 fixture book, the GnuCash page lists the account tree and
      imports transactions from user-selected accounts as payments
      (`source = 'gnucash'`, `external_ref` = GnuCash transaction GUID); re-import is a
      no-op (dedup on `external_ref`).
- [ ] Amounts converted from GnuCash numerator/denominator rationals are exact to the
      cent (integer cents end-to-end; edge values like $10,673.91 and $0.01 covered by
      tests).
- [ ] Account/category ↔ GnuCash GUID mappings persist across restart and are editable
      without data loss; name/last4-based suggestions pair the obvious fixture cases.
- [ ] Exported QIF and CSV files contain correct dates, signed amounts, payees, and
      category account paths for the selected payments; a second export excludes
      already-exported payments by default with forced re-export available.
- [ ] Reconciliation classifies seeded scenarios correctly into exactly three buckets
      (matched / fin-app-only / GnuCash-only; an amount discrepancy never matches and
      therefore surfaces as one entry in each one-sided bucket) with the ±3-day
      default window; manual match/unmatch overrides persist across re-imports.
- [ ] All GnuCash file access is read-only, enforced by the SQLite read-only open flag
      in the one Rust module that touches the book; XML books and unknown schema
      versions produce guiding errors, never crashes.
- [ ] An unlinked/missing/moved book or unknown schema renders the blocking re-link
      state on the GnuCash page; all other pages work normally.

## Constraints

- `gnucash-data-model` skill guardrails are binding: read-only flag enforced in code,
  never parse XML books, never touch `slots`/`versions`, fixture books only in tests.
- Money is integer cents in TypeScript; GnuCash rationals are converted at the Rust
  boundary using the commodity `fraction`; inexact conversions surface as error
  entries in the frozen `GnucashTransactionList.errors` shape — never rounded, never
  dropped.
- All SQL lives in `src/core`; the UI never issues queries. Explicit exception to the
  repositories-only convention (precedent: `import-review.ts`): the new core modules
  may embed module-level SQL for their own tables (`payment_exports`,
  `gnucash_matches`) and cross-entity queries that no repository covers.
- Reuse existing infrastructure: payee normalization (`src/core/payee-normalization.ts`),
  the review-before-commit import pattern (`src/core/import-review.ts`), the
  `Database` seam, and existing repositories (accounts/categories already carry
  `gnucash_guid` columns).
- The GnuCash book path is stored in its own `gnucash.json` store (LazyStore), NOT in
  `settings.json` — avoids write contention with the parallel distribution goal.
- Cross-goal hotspots serialized by the orchestrator (never edited concurrently with
  the other goal's tasks): `src-tauri/src/lib.rs`, `src-tauri/src/db.rs`,
  `src/App.tsx`.
- Tests use fixture books and temp dirs only — never a real GnuCash book.

## Out of Scope

- Any write to the GnuCash book (deferred guarded-write goal; requires explicit user
  green-light).
- PostgreSQL/MySQL GnuCash backends; XML book parsing.
- Auto-creating fin-app payees/categories from GnuCash data without user review.
- Scheduling/automatic background sync — import and export are user-initiated.

## Tasks (dependency order)

| # | Task file | Layer | Depends on |
|---|-----------|-------|------------|
| 01 | `01-contract-schema.md` | migrations + shared types (contract) | — |
| 02 | `02-gnucash-reader-rust.md` | Rust commands | 01 |
| 03 | `03-book-link-mapping-core.md` | TS core | 01 |
| 04 | `04-import-core.md` | TS core | 01 |
| 05 | `05-export-core.md` | TS core | 01 |
| 06 | `06-reconcile-core.md` | TS core | 01 |
| 07 | `07-gnucash-page-ui.md` | React UI | 02–06 |
| 08 | `08-tests.md` | tests | all |

**Contract first.** Task 01 freezes the IPC payload shapes, the new core module
skeletons, `src/core/index.ts` exports, and migration 0008 — tasks 02–06 build against
that frozen boundary and never edit each other's files.
