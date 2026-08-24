# Task 08: tests

## Objective

Close the coverage gaps the per-task tests leave: page-level tests for the GnuCash UI
(all five tabs + blocking state, mocked invoke layer), an end-to-end core pipeline test
driving reader-shaped fixture data through mapping → import → export → reconcile
against the in-memory DB, and a coverage audit of every exported symbol added by this
goal.

## Dependencies

- all implementation tasks (01–07)

```yaml
# --- task ownership contract ---
writes:
  - tests/gnucash-page.test.tsx
  - tests/core/gnucash-pipeline.test.ts
  - tests/fixtures/gnucash/reader-output.json   # canned reader payloads for TS tests
reads:
  - src/pages/GnuCashPage.tsx
  - src/gnucash-book.ts
  - src/core/index.ts
  - tests/fixtures/gnucash/fixture-book.sql
  - tests/support/test-db.ts
depends_on:
  - "01-contract-schema"
  - "02-gnucash-reader-rust"
  - "03-book-link-mapping-core"
  - "04-import-core"
  - "05-export-core"
  - "06-reconcile-core"
  - "07-gnucash-page-ui"
owner: test-writer
rewrite_semantics: whole-file
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `tests/fixtures/gnucash/reader-output.json`: canned `GnucashBookProbe`,
      `GnucashAccount[]`, and a full `GnucashTransactionList` payload mirroring
      `fixture-book.sql` (same GUIDs and amounts, including $10,673.91 and $0.01, AND
      the fixture's inexact/malformed transaction as a `GnucashTransactionError`
      entry in `errors`), so TS tests stay consistent with the Rust fixture.
- [ ] `tests/core/gnucash-pipeline.test.ts`: one flow over the in-memory DB
      (`tests/support/test-db.ts`) — map accounts/categories → plan+commit import →
      re-import no-op → export QIF and CSV for a subset → reconcile shows the
      remaining fin-app-only payments and a seeded GnuCash-only transaction; asserts
      DB state (payments, payment_exports, gnucash_matches) after each step, exact
      cents throughout; asserts the reader-error entry flows plan → unreadable bucket
      → is NEVER committed (no payment row for its GUID) and reappears on the
      reconcile result.
- [ ] `tests/gnucash-page.test.tsx` (mock `src/gnucash-book.ts`'s invoke-backed
      functions and the dialog plugin, real core over the in-memory DB where
      practical, following existing page-test patterns): renders each tab; XML book
      shows the conversion walkthrough; missing book shows the blocking state while
      other pages stay reachable; mapping suggestion apply persists; import review
      shows every bucket incl. unmappable reasons AND unreadable reader-error rows
      (GUID + reason visible, not committable); payee auto-create requires
      confirmation; export blocks unmapped payments and excludes already-exported by
      default; reconcile manual match persists and the reader-error notice strip
      renders. Every test asserts outcomes, not just
      "renders without crashing".
- [ ] All external surfaces mocked — no Tauri runtime, no network, no real books.
- [ ] Coverage audit in the completion report: table of every new exported
      function/component from tasks 01–07 → the test file(s) covering it; any gap is
      filled in this task (in these two test files) or explicitly justified.
- [ ] Full TS suite green: `npm test`.

## Files to Read

- `tests/import-review-ui.test.tsx`, `tests/reports-page.test.tsx` — page-test patterns
- `tests/support/test-db.ts`, `tests/support/db-contract.ts` — in-memory DB harness
- `.claude/skills/test-ladder/SKILL.md` — rung discipline (this task runs rungs 1–2)
- All task files 01–07 in `_goals/gnucash-read-export/`

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: mock every external service/IPC surface; use fixtures + temp state only.
- Must NOT: modify product code (report gaps needing code changes instead), touch Rust
  tests (task 02 owns those), or run the full Rust suite (rung 3 is orchestrator-owned).

## Verification

- Targeted test command: `npx vitest run tests/gnucash-page.test.tsx tests/core/gnucash-pipeline.test.ts`
- Then rung 2: `npm test` (TS suite) — report pass/fail counts.
