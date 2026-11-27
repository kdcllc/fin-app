# Task 07: gnucash-page-ui

## Objective

Replace the GnuCash placeholder with the real page: five sections/tabs (Link book,
Account mapping, Import, Export, Reconcile) wired to the Rust reader and the four core
modules, with the blocking re-link state for missing/XML/unknown-schema books.

## Dependencies

- 02-gnucash-reader-rust, 03-book-link-mapping-core, 04-import-core, 05-export-core,
  06-reconcile-core

```yaml
# --- task ownership contract ---
writes:
  - src/pages/GnuCashPage.tsx
  - src/App.tsx                    # swap placeholder for GnuCashPage only
  - src/book.ts                    # ORCHESTRATOR AMENDMENT (post-contract): openBook
                                   # returns { db, repos } so App can retain the
                                   # Database handle the gnucash core APIs need
  - tests/app-shell.test.tsx       # ORCHESTRATOR AMENDMENT: update the ../src/book
                                   # mock to the new return shape ONLY — no other
                                   # test-logic change
reads:
  - src/gnucash-book.ts
  - src/core/index.ts
  - src/pages/ImportPage.tsx
  - src/pages/SettingsPage.tsx
depends_on:
  - "02-gnucash-reader-rust"
  - "03-book-link-mapping-core"
  - "04-import-core"
  - "05-export-core"
  - "06-reconcile-core"
owner: implementer
rewrite_semantics: targeted-insertion   # App.tsx is a shared hotspot
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] **Link book**: file picker (existing `tauri-plugin-dialog` pattern) → probe →
      ONLY on `ok` persist the path via `src/gnucash-book.ts` and show book summary
      (path, schema version, account count); on `xml` show the File → Save As →
      sqlite3 walkthrough text WITHOUT persisting the selection; on
      `missing`/`unreadable`/`unknown-schema` show the guiding error without
      persisting. Re-link is always available.
- [ ] **Blocking state**: when a previously linked book probes as
      missing/xml/unknown-schema, every tab except Link book is replaced by a clear
      blocking message + "Re-link book" action. All other app pages are untouched by
      this state.
- [ ] **Mapping tab**: fin-app accounts and categories listed beside the GnuCash tree
      (BANK/CASH/CREDIT/LIABILITY for accounts, EXPENSE for categories); suggestions
      shown with their reason, applied only on user action; current mappings editable
      and clearable; unmapped-entity warnings visible.
- [ ] **Import tab**: account-tree checkboxes (remembered selection from
      `gnucash-book.ts`), date window, then the review flow: bucketed plan (new /
      updated / merge-candidate / unmappable / **unreadable** — the reader-error
      entries from `GnucashTransactionList.errors`, shown with GUID + reason, never
      committable — nothing hidden), per-row approve/reject for updates and merges,
      payee-creation confirmations, commit; success shows inserted/merged/skipped
      counts (unreadable count included).
- [ ] **Export tab**: date window + payment list (exported ones excluded by default,
      toggle to include), format choice QIF / CSV, mapping blockers shown before
      export, save via dialog + existing file-save pattern, then `recordExport`.
- [ ] **Reconcile tab**: account + date window + tolerance selector (default ±3 days);
      three-bucket view with per-account summary line (counts + totals); manual
      match/unmatch actions persisting overrides; reader errors carried through on the
      `reconcile` result render as a separate notice strip (GUID + reason) outside the
      three match buckets.
- [ ] Loading/error states for every invoke call; money rendered from integer cents
      with the app's existing formatting helper; no SQL or deep core imports
      (`src/core` public entry only).
- [ ] `App.tsx` change is minimal: import + route the new page where the placeholder
      branch was.

## Files to Read

- `src/pages/ImportPage.tsx` — review-flow UI pattern to mirror
- `src/pages/ReportsPage.tsx` — date-window + export UI patterns
- `src/App.tsx` — routing branch to extend
- `.claude/skills/tauri-qa-testing/SKILL.md` — evidence capture for the QA gate
- `_goals/gnucash-read-export/goal.md` — discovery decisions

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: import from `src/core` public entry and `src/gnucash-book.ts` only; reuse
  existing UI conventions (App.css classes, page structure).
- Must NOT: issue SQL, import Tauri APIs for anything the wrappers already cover,
  modify core modules, or restructure App.tsx beyond the routing swap.

## Verification

- Targeted test command: `npx vitest run tests/gnucash-page.test.tsx` (written in
  task 08; during this task: `npm run typecheck` + `npm run lint`)
- Behavioral evidence for the QA gate per `tauri-qa-testing`: screenshots of link,
  blocking, mapping, import review, export, reconcile states against the fixture book.
