# Contract: 03-book-link-mapping-core

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

03-book-link-mapping-core

## done_definition

`src/gnucash-book.ts` persists GnuCash link state in a dedicated `LazyStore("gnucash.json")`
(store file `gnucash.json`, not `settings.json`) with `bookPath`, `importAccountGuids`, and
`lastImportAt`, plus typed Tauri invoke wrappers for the three frozen Rust commands. The
task-01 skeleton in `src/core/gnucash-mapping.ts` is fully implemented with the exact frozen
exported signatures: pure suggestion logic (no auto-apply, no Tauri, no SQL), repository-backed
apply/clear that patches only `gnucash_guid`, duplicate-GUID enforcement via
`GnucashMappingConflictError` within each entity kind, and `mappingStatus` reporting three
unmapped lists. `tests/core/gnucash-mapping.test.ts` (test-first) covers suggestions,
persistence, conflict errors, and status output using the in-memory test DB. `npm run typecheck`
and `npx vitest run tests/core/gnucash-mapping.test.ts` pass. No UI, Rust, repository, or
`index.ts` edits.

## acceptance_criteria

### Write fence and frozen signatures

1. Only these files are created or modified: `src/gnucash-book.ts`,
   `src/core/gnucash-mapping.ts`, `tests/core/gnucash-mapping.test.ts`. — verification:
   `git diff --name-only` against task baseline.

2. `src/core/gnucash-mapping.ts` retains the exact exported signatures frozen in task 01
   (parameter types and return types unchanged):
   - `export class GnucashMappingConflictError extends Error`
   - `export type MappingKind = "account" | "category"`
   - `export interface MappingSuggestion { kind: MappingKind; finEntityId: number; gnucashGuid: string; reason: string }`
   - `export interface MappingStatus { unmappedFinAccounts: Account[]; unmappedCategories: Category[]; unmappedGnucashAccounts: GnucashAccount[] }`
   - `export function suggestAccountMappings(finAccounts: Account[], gnucashAccounts: GnucashAccount[]): MappingSuggestion[]`
   - `export function suggestCategoryMappings(categories: Category[], gnucashAccounts: GnucashAccount[]): MappingSuggestion[]`
   - `export async function applyAccountMapping(repos: Repositories, accountId: number, guid: string): Promise<void>`
   - `export async function applyCategoryMapping(repos: Repositories, categoryId: number, guid: string): Promise<void>`
   - `export async function clearMapping(repos: Repositories, kind: "account" | "category", id: number): Promise<void>`
   - `export function mappingStatus(finAccounts: Account[], categories: Category[], gnucashAccounts: GnucashAccount[]): MappingStatus`
   — verification: read exported declarations in `src/core/gnucash-mapping.ts`; `npm run typecheck`.

3. `src/core/gnucash-mapping.ts` has no imports from `@tauri-apps/*`, `invoke`, or
   `src/gnucash-book.ts`. — verification: read import block; ESLint boundary holds.

4. No embedded SQL strings or direct `Database` usage in `src/core/gnucash-mapping.ts`;
   persistence goes through `repos.accounts.update` / `repos.categories.update` only. —
   verification: read file (grep for `` `SELECT `` / `` `UPDATE `` / `` `INSERT `` returns
   none); apply/clear tests use in-memory repos (criterion 38).

### `src/gnucash-book.ts` — LazyStore link state

5. File `src/gnucash-book.ts` exists outside `src/core/` (same layer as `src/xlsx-reader.ts`). —
   verification: file inspection.

6. Module uses `LazyStore("gnucash.json")` from `@tauri-apps/plugin-store` — not
   `settings.json` and not the `settings.ts` store instance. — verification: read file;
   grep shows `new LazyStore("gnucash.json")` or module-level `LazyStore("gnucash.json")`;
   no import of `settings.ts`'s store.

7. Exported state shape includes at minimum: `bookPath: string | null`,
   `importAccountGuids: string[]`, `lastImportAt: string | null` (interface or inline on
   load return type). — verification: read type definition.

8. `load*` function (name mirrors `loadSettings` pattern) reads all three persisted fields
   from `gnucash.json`, defaulting `bookPath` and `lastImportAt` to `null` and
   `importAccountGuids` to `[]` when absent. — verification: read implementation; file
   inspection of get/set keys.

9. `update*` function (name mirrors `updateSettings` pattern) accepts a partial patch,
   persists only supplied fields, calls `store.save()`, and returns fresh state via the
   load function. Passing `null` for nullable scalar fields clears them (delete key), mirroring
   `settings.ts` `setOrClear` behavior. — verification: read implementation.

10. Module does not read or write `settings.json` / `AppSettings` / `loadSettings` /
    `updateSettings`. — verification: read imports and body; grep for `settings.json` and
    `./settings` imports returns none.

### `src/gnucash-book.ts` — typed invoke wrappers

11. Typed wrapper calls `invoke<GnucashBookProbe>("gnucash_probe_book", { path })` (or
    equivalent typed invoke with command name exactly `gnucash_probe_book`). — verification:
    read wrapper function; return type `GnucashBookProbe` imported from `./core/gnucash-types`
    or `./core`.

12. Typed wrapper calls `invoke<GnucashAccount[]>("gnucash_list_accounts", { path })` with
    command name exactly `gnucash_list_accounts`. — verification: read wrapper function.

13. Typed wrapper calls
    `invoke<GnucashTransactionList>("gnucash_list_transactions", { path, accountGuids, from, to })`
    (camelCase IPC args matching Tauri convention) with command name exactly
    `gnucash_list_transactions`. — verification: read wrapper function; parameter names may
    differ in TS but all four values are forwarded.
    evaluator-note (pin 6): JS invoke object keys are camelCase (`accountGuids`); task 02
    Rust commands declare `account_guids`. Tauri 2 maps them — do not pass snake_case from TS.

14. All three wrappers import types from `src/core/gnucash-types.ts` (direct or via `./core`);
    no duplicate IPC type definitions in `gnucash-book.ts`. — verification: read imports.

### `suggestAccountMappings` — account pairing logic

15. Only GnuCash accounts with `account_type` in `BANK`, `CASH`, `CREDIT`, `LIABILITY` are
    eligible pairing targets; other types (e.g. `EXPENSE`, `INCOME`, `ROOT`) are ignored for
    account suggestions. — verification: unit test with mixed `account_type` inputs asserts
    suggestions reference eligible types only.

16. GnuCash accounts with `placeholder: true` never appear in any suggestion's `gnucashGuid`. —
    verification: unit test with placeholder and non-placeholder candidates; placeholder GUID
    absent from results.

17. Case-insensitive name similarity: when a fin-app account's normalized name matches a
    candidate GnuCash account's normalized name (whitespace collapsed, case folded — same
    normalization spirit as `collapseWhitespace` / `toLowerCase` usage in
    `payee-normalization.ts`), a suggestion is produced with `kind: "account"`,
    `finEntityId` set to the fin account id, and a non-empty `reason` string mentioning name
    match. — verification: unit test with e.g. fin `"Main Checking"` and GnuCash
    `"main checking"` yields one suggestion with expected ids and reason substring.

18. Last4 pairing: when fin account `last4` is a four-digit string and that digit sequence
    appears in the candidate GnuCash account `name`, a suggestion is produced (even if name
    similarity alone would not match) with a non-empty `reason` string mentioning last4. —
    verification: unit test with fin `last4: "9002"` and GnuCash name containing `9002`.

19. Each `MappingSuggestion` includes `kind: "account"`, the fin account id, the chosen GnuCash
    `guid`, and a human-readable `reason` string (non-empty). — verification: unit test
    asserts shape on at least one name-based and one last4-based suggestion.

20. `suggestAccountMappings` is pure: it does not call repositories, `invoke`, or mutate
    inputs; it only returns an array. Suggestions are never auto-applied (no side effects). —
    verification: unit test calls suggest with plain arrays and asserts DB/repo state unchanged
    when using a spy or by omitting repos from the call entirely.

21. Fin accounts that already have a non-null `gnucash_guid` are excluded from suggestion
    output (no remapping suggestions). — verification: unit test with pre-mapped fin account
    yields no suggestion for that id.

### `suggestCategoryMappings` — category pairing logic

22. Only GnuCash accounts with `account_type: "EXPENSE"` are eligible category-mapping
    targets. — verification: unit test with EXPENSE and non-EXPENSE accounts; only EXPENSE
    GUIDs appear.

23. Placeholder EXPENSE accounts are never suggested (`placeholder: true` excluded). —
    verification: unit test parallel to criterion 16 for categories.

24. Category name is matched case-insensitively against the GnuCash account `name` and against
    each colon-separated segment of `full_path` (e.g. category `"Electric"` matches
    `full_path: "Expenses:Utilities:Electric"` via the `Electric` segment). — verification:
    unit tests for direct name match and full_path segment match each produce a suggestion
    with `kind: "category"` and non-empty `reason`.

25. Each category suggestion includes `kind: "category"`, category id, GnuCash guid, and
    non-empty `reason`. — verification: unit test asserts shape.

26. Pure function: no repository/invoke calls; suggestions never auto-applied. — verification:
    same pattern as criterion 20 for categories.

27. Categories that already have a non-null `gnucash_guid` are excluded from suggestion output. —
    verification: unit test with pre-mapped category.

### `applyAccountMapping` / `applyCategoryMapping` / `clearMapping`

28. `applyAccountMapping` persists by calling `repos.accounts.update(accountId, { gnucash_guid: guid })`
    only — no other fields patched. — verification: in-memory test DB: insert account, apply
    mapping, `repos.accounts.get` shows updated `gnucash_guid` and unchanged `name`, `kind`,
    `last4`, `archived`.

29. `applyCategoryMapping` persists by calling `repos.categories.update(categoryId, { gnucash_guid: guid })`
    only. — verification: in-memory test DB parallel to criterion 28 for categories.

30. Remapping the same fin entity to a different GUID overwrites its previous `gnucash_guid`
    without error (no conflict with self). — verification: unit test apply A→guid1, then
    A→guid2; get shows guid2.

31. `clearMapping(repos, "account", id)` sets `gnucash_guid` to `null` via
    `repos.accounts.update` without touching other columns. — verification: in-memory test
    after apply then clear.

32. `clearMapping(repos, "category", id)` sets `gnucash_guid` to `null` via
    `repos.categories.update` without touching other columns. — verification: in-memory test.

### Duplicate GUID — `GnucashMappingConflictError`

33. Applying an account mapping whose `guid` is already held by a *different* fin-app account
    throws `GnucashMappingConflictError` (instanceof check); the existing mapping is unchanged. —
    verification: unit test maps account A→guid, expect `applyAccountMapping` for account B→same
    guid to reject with `GnucashMappingConflictError`; A still has guid.

34. Applying a category mapping whose `guid` is already held by a *different* category throws
    `GnucashMappingConflictError`; no silent overwrite. — verification: unit test parallel to
    criterion 33 for categories.

35. The same GnuCash GUID may map to one fin account *and* one category simultaneously
    (conflict is within kind only, not cross-kind). — verification: unit test maps guid to one
    account and one category successfully without error.

36. Thrown error is `GnucashMappingConflictError` with `name === "GnucashMappingConflictError"`. —
    verification: unit test `expect(error).toBeInstanceOf(GnucashMappingConflictError)`.

### `mappingStatus`

37. `mappingStatus` returns `MappingStatus` with exactly three arrays:
    `unmappedFinAccounts`, `unmappedCategories`, `unmappedGnucashAccounts`. — verification:
    unit test destructures all three keys.

38. `unmappedFinAccounts` contains fin accounts where `gnucash_guid` is `null` (or absent). —
    verification: unit test with one mapped and one unmapped account.

39. `unmappedCategories` contains categories where `gnucash_guid` is `null`. — verification:
    unit test with one mapped and one unmapped category.

40. `unmappedGnucashAccounts` lists GnuCash accounts (from the supplied `gnucashAccounts`
    input) whose `guid` is not referenced by any fin account's or category's `gnucash_guid`
    in the supplied fin lists — informational unmapped side. — verification: unit test with two
    GnuCash accounts, one linked via account mapping, asserts unmapped list contains only the
    unlinked GUID.
    evaluator-note (pin 2): this list is unfiltered by GnuCash account type (UI filters).

41. `mappingStatus` is pure (no repository/invoke); operates on plain arrays passed in. —
    verification: read function body; unit test does not pass repos.

### Test-first and verification commands

42. `tests/core/gnucash-mapping.test.ts` exists and was authored test-first (covers criteria
    15–19, 22–24, 28–35, 37–40 at minimum). — verification: read test file describe/it blocks;
    `npx vitest run tests/core/gnucash-mapping.test.ts` exits 0.

43. Tests use `openTestDb()` / in-memory adapter from `tests/support/test-db.ts` only — no
    Tauri runtime, no real GnuCash book paths. — verification: read test imports and setup.

44. `npm run typecheck` exits 0. — verification: command output.

### Out-of-scope guardrails

45. No edits to `src/core/index.ts`, `src/settings.ts`, any file under `src/core/repositories/`,
    any UI file (`src/**/*.tsx`), or Rust sources (`src-tauri/**`). — verification:
    `git diff --name-only` path filter.

46. No float money anywhere in new code; mapping module does not perform monetary arithmetic. —
    verification: read new files.

## verification_environment

library (vitest)

## out_of_scope

- GnuCash page UI (task 07).
- Rust reader implementation and `lib.rs` command registration (task 02).
- Other core modules (`gnucash-import.ts`, `gnucash-export.ts`, `gnucash-reconcile.ts`).
- `src/core/index.ts` export changes (frozen in task 01).
- Repository implementation changes (`accounts.ts`, `categories.ts`).
- Dedicated Vitest file for `src/gnucash-book.ts` (not in write fence; verified via file
  inspection and typecheck only).
- End-to-end IPC integration tests against a real fixture book (task 08 / UI task).
- Exact tie-breaking order when multiple GnuCash candidates match one fin entity (implementer
  freedom provided every returned suggestion is valid and reasons are truthful).
  evaluator-note (pin 1): implementer freedom on *which* valid candidate wins a tie;
  returned suggestion lists MUST be deterministic for a given input (stable ordering).

## pins (orchestrator rulings, round 1)

1. Name-similarity tie-breaking — implementer freedom; suggestions deterministic for a given input (stable ordering).
2. `unmappedGnucashAccounts` unfiltered by type — approved (UI filters). Criterion 40.
3. Pre-mapped entities excluded from suggestions (criteria 21/27) — approved.
4. Cross-kind GUID reuse allowed (criterion 35) — approved.
5. `src/gnucash-book.ts` export names — implementer freedom in `settings.ts` style (`load*` / `update*` plus exported typed invoke wrappers).
6. Invoke arg casing — JS-side camelCase (`accountGuids`) per Tauri 2 convention; task 02 Rust commands declare snake_case (`account_guids`) and Tauri maps them. Criterion 13.
7. No dedicated `gnucash-book.ts` test file — approved (inspection + typecheck here; task 08 page tests cover it mocked).

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T13:15:00-04:00
    note: Achievable within the three-file write fence; gnucash-book verified by inspection/typecheck, mapping by vitest.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T14:20:00-04:00
    note: Counter-signed round 1. Frozen signatures match src/core/gnucash-mapping.ts. Pins 1–7 recorded. No revision.
revision: 0
```
