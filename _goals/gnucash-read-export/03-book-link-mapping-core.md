# Task 03: book-link-mapping-core

## Objective

The book-link state module and the mapping engine: persistence of the linked GnuCash
book path and remembered import-account selection in a dedicated `gnucash.json` store,
plus the core logic that suggests and applies fin-app ↔ GnuCash account/category
mappings via the existing `gnucash_guid` columns.

## Dependencies

- 01-contract-schema (frozen types and skeletons)

```yaml
# --- task ownership contract ---
writes:
  - src/core/gnucash-mapping.ts   # fill the task-01 skeleton
  - src/gnucash-book.ts           # new: LazyStore("gnucash.json") link state + invoke wrappers
  - tests/core/gnucash-mapping.test.ts
reads:
  - src/core/gnucash-types.ts
  - src/core/repositories/accounts.ts
  - src/core/repositories/categories.ts
  - src/settings.ts               # pattern reference only — do not edit
depends_on:
  - "01-contract-schema"
owner: implementer
rewrite_semantics: whole-file
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `src/gnucash-book.ts` (outside core, like `src/xlsx-reader.ts`): typed wrappers
      over the three `gnucash_*` invoke commands, plus persisted link state in
      `LazyStore("gnucash.json")`: `bookPath: string | null`,
      `importAccountGuids: string[]` (remembered selection),
      `lastImportAt: string | null`. Load/update functions mirror the `settings.ts`
      style. Does NOT touch `settings.json`.
- [ ] `src/core/gnucash-mapping.ts` implements the task-01 skeleton signatures:
      - `suggestAccountMappings(finAccounts, gnucashAccounts)` — pairs fin-app accounts
        with GnuCash BANK/CASH/CREDIT/LIABILITY accounts by case-insensitive name
        similarity and last4 digits found in the GnuCash account name; each suggestion
        carries a reason string; placeholder accounts are never suggested.
      - `suggestCategoryMappings(categories, gnucashAccounts)` — same for EXPENSE
        accounts, matching category name against the account name and `full_path`
        segments.
      - `applyAccountMapping` / `applyCategoryMapping` / `clearMapping` — persist via
        the existing repositories' `update` (patch `gnucash_guid`); remapping
        overwrites without touching any other field.
      - `mappingStatus(finAccounts, categories, gnucashAccounts)` (exact frozen
        signature from task 01) — reports mapped/unmapped on both sides: unmapped
        GnuCash accounts (informational — simply not imported), unmapped fin-app
        entities (blockers surfaced before export).
- [ ] A GnuCash GUID can be mapped to at most one fin-app account and one category:
      applying a mapping that would duplicate a GUID within the same entity kind
      throws the frozen `GnucashMappingConflictError` (exported from `src/core` per
      task 01), it does not overwrite silently.
- [ ] Suggestions never auto-apply — they are returned for user review.
- [ ] Pure logic takes plain data (no invoke calls inside `src/core`).
- [ ] Test-first (`tdd` skill): `tests/core/gnucash-mapping.test.ts` covers suggestion
      pairing (name, last4, placeholder exclusion), apply/clear/remap persistence via
      the in-memory test DB, the duplicate-GUID typed error, and `mappingStatus`
      output for unmapped entities on both sides.

## Files to Read

- `src/core/README.md` — boundary rule (core never imports Tauri)
- `src/core/payee-normalization.ts` — existing name-similarity conventions to reuse
- `src/settings.ts` — LazyStore pattern to mirror
- `_goals/gnucash-read-export/goal.md` — discovery decisions

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: keep all SQL inside existing repositories (this module calls repository
  methods, it does not embed SQL); reuse normalization helpers rather than inventing
  new similarity code where they fit.
- Must NOT: edit `settings.ts`, `index.ts` (exports already landed in task 01), any
  repository, or the UI; no floats.

## Verification

- Targeted test command: `npx vitest run tests/core/gnucash-mapping.test.ts`
- `npm run typecheck` passes.
