# Contract: 01-contract-schema

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

01-contract-schema

## done_definition

Migration `0008_gnucash_integration.sql` adds the `payment_exports` and `gnucash_matches`
tables with the specified columns, constraints, and indexes; `db.rs` registers migration 8
and its tests-module constants reflect version 8 and the two new table names. Five new core
files land: `gnucash-types.ts` (frozen IPC payload types with JSDoc command names and
`SUPPORTED_GNUCASH_RESAVE`), four skeleton modules whose exported function/class signatures
match the task file exactly (bodies throw `"not implemented"`, supporting input/result types
exported alongside), and `index.ts` re-exports the full frozen public surface. Existing
`tests/core/schema.test.ts` and `cargo test db` stay green; `npm run typecheck` passes.
No UI, Rust reader, module implementations, or other files change.

## acceptance_criteria

### Migration `0008_gnucash_integration.sql`

1. File `src-tauri/migrations/0008_gnucash_integration.sql` exists and is append-only
   (new file; no edits to shipped migrations `0001`–`0007`). — verification: file
   inspection; `git diff` shows only the new migration among migration files.

2. Table `payment_exports` is created with columns: `id INTEGER PRIMARY KEY`, `payment_id
   INTEGER NOT NULL REFERENCES payments(id)`, `format TEXT NOT NULL CHECK (format IN
   ('qif','csv'))`, `exported_at TEXT NOT NULL DEFAULT (datetime('now'))`. — verification:
   read migration SQL; `PRAGMA table_info(payment_exports)` on an in-memory DB after all
   migrations apply (`openTestDb` / `tests/core/schema.test.ts` path) matches column names,
   types, and NOT NULL flags.

3. Table `gnucash_matches` is created with columns: `id INTEGER PRIMARY KEY`, `payment_id
   INTEGER NOT NULL REFERENCES payments(id)`, `txn_guid TEXT NOT NULL`, `status TEXT NOT
   NULL CHECK (status IN ('matched','unmatched'))`, `created_at TEXT NOT NULL DEFAULT
   (datetime('now'))`, and `UNIQUE (payment_id, txn_guid)`. — verification: read migration
   SQL; `PRAGMA table_info(gnucash_matches)` and `PRAGMA index_list(gnucash_matches)` on
   in-memory migrated DB show the unique constraint on `(payment_id, txn_guid)`.

4. An index exists on `payment_exports.payment_id`. — verification: read migration SQL for
   `CREATE INDEX` targeting `payment_exports` and `payment_id`; confirm index present via
   `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='payment_exports'` on
   in-memory migrated DB.

5. An index exists on `gnucash_matches.txn_guid`. — verification: read migration SQL for
   `CREATE INDEX` targeting `gnucash_matches` and `txn_guid`; confirm index present via
   `sqlite_master` query on in-memory migrated DB.

6. Inserting a `payment_exports` row with `format` outside `('qif','csv')` fails the CHECK
   constraint. — verification: in-memory DB test (manual or existing schema harness):
   valid insert succeeds; invalid `format` value rejects.

7. Inserting a `gnucash_matches` row with `status` outside `('matched','unmatched')` fails
   the CHECK constraint. — verification: in-memory DB test: valid insert succeeds; invalid
   `status` rejects.

8. Duplicate `(payment_id, txn_guid)` pairs in `gnucash_matches` violate the UNIQUE
   constraint. — verification: in-memory DB test: second insert with same pair rejects.

9. `payment_exports.payment_id` and `gnucash_matches.payment_id` enforce `REFERENCES
   payments(id)` (dangling FK rejected). — verification: in-memory DB test with
   `foreign_keys=ON` rejects insert with nonexistent `payment_id`.

### `db.rs` migration registration and test constants

10. `MIGRATIONS` array gains exactly one new trailing entry:
    `(8, include_str!("../migrations/0008_gnucash_integration.sql"))`. — verification:
    read `src-tauri/src/db.rs`; no other edits outside the `MIGRATIONS` tuple and the
    `#[cfg(test)] mod tests` constants/assertion called out below.

11. Tests-module `LATEST_VERSION` resolves to `8` after the change (derived from
    `MIGRATIONS[MIGRATIONS.len() - 1].0`). — verification: read `db.rs` test module;
    `cargo test db --manifest-path src-tauri/Cargo.toml` passes including
    `open_book_on_fresh_path_migrates_to_latest_version_with_all_tables`.

12. The hardcoded assertion `assert_eq!(LATEST_VERSION, 7, ...)` in
    `open_book_on_fresh_path_migrates_to_latest_version_with_all_tables` is updated to
    `8`. — verification: read `db.rs` line ~529; `cargo test db` passes.

13. Tests-module `EXPECTED_TABLES` includes `"payment_exports"` and `"gnucash_matches"`
    in sorted order alongside existing tables. — verification: read `db.rs` test module;
    fresh-book `open_book` test asserts `table_names(&conn) == EXPECTED_TABLES` with both
    new names present.

14. No other `db.rs` production or test logic changes (no new commands, hooks, or refactors).
    — verification: `git diff src-tauri/src/db.rs` limited to `MIGRATIONS` entry,
    `EXPECTED_TABLES`, and the `LATEST_VERSION` literal assertion.

### `src/core/gnucash-types.ts` — frozen IPC types

15. File `src/core/gnucash-types.ts` exists and exports `SUPPORTED_GNUCASH_RESAVE` as
    `const` with value exactly `19920`. — verification: read file; `npm run typecheck`
    resolves the export from `src/core/index.ts`.

16. `GnucashBookProbe` is a discriminated union with variants: `{ status: "ok";
    schemaVersion: number }`, `{ status: "xml" }`, `{ status: "unknown-schema"; detail:
    string }`, `{ status: "missing" }`, `{ status: "unreadable"; detail: string }`. —
    verification: read type definition; TypeScript exhaustiveness check compiles when
    switching on `status`.

17. JSDoc on `GnucashBookProbe` documents that `status: "ok"` applies only when the book's
    `versions` table has key `Gnucash-Resave` with value exactly `SUPPORTED_GNUCASH_RESAVE`
    (`19920`); any other value maps to `unknown-schema` with the found value in `detail`;
    the `ok` variant's `schemaVersion` is display-only (the `versions` table `Gnucash` key
    value); the compatibility gate is `Gnucash-Resave` alone. — verification: read JSDoc
    text on the type or `SUPPORTED_GNUCASH_RESAVE` constant.

18. JSDoc on `GnucashBookProbe` names Rust command `gnucash_probe_book(path)`. —
    verification: read JSDoc.

19. `GnucashAccount` exports with fields: `guid: string`, `name: string`, `account_type`
    (string union including `BANK`, `CASH`, `CREDIT`, `LIABILITY`, `INCOME`, `EXPENSE`,
    `EQUITY`, `ROOT`), `parent_guid: string | null`, `placeholder: boolean`,
    `commodity_mnemonic: string`, `commodity_fraction: number`, `full_path: string`
    (colon-joined path). — verification: read interface/type definition; `npm run typecheck`.

20. JSDoc on `GnucashAccount` names Rust command `gnucash_list_accounts(path)`. —
    verification: read JSDoc.

21. `GnucashSplit` exports with fields: `split_guid: string`, `account_guid: string`,
    `memo: string`, `value_cents: number` (integer cents). — verification: read type;
    no float money fields.

22. `GnucashTransaction` exports with fields: `txn_guid: string`, `post_date: string`
    (`YYYY-MM-DD`), `description: string`, `splits: GnucashSplit[]`. — verification:
    read type definition.

23. `GnucashTransactionError` exports with fields: `txn_guid: string`, `post_date: string
    | null`, `description: string | null`, `reason: string`. — verification: read type
    definition.

24. `GnucashTransactionList` exports as `{ transactions: GnucashTransaction[]; errors:
    GnucashTransactionError[] }`. — verification: read type definition.

25. JSDoc on `GnucashTransaction` / `GnucashTransactionList` names Rust command
    `gnucash_list_transactions(path, account_guids, from, to)` returning
    `GnucashTransactionList`. — verification: read JSDoc.

26. All monetary fields in `gnucash-types.ts` are integer cents (`value_cents: number`);
    date fields are `YYYY-MM-DD` strings. — verification: read file; no `number` fields
    documented as floats for money.

### `src/core/gnucash-mapping.ts` — skeleton signatures

27. File exists; no imports from `@tauri-apps/*` or other Tauri APIs. — verification: read
    imports; `npm run typecheck`.

28. `export class GnucashMappingConflictError extends Error` is defined and exported. —
    verification: read file; `instanceof GnucashMappingConflictError` type-narrows in TS.

29. Exported function signatures match exactly:
    - `suggestAccountMappings(finAccounts: Account[], gnucashAccounts: GnucashAccount[]):
      MappingSuggestion[]`
    - `suggestCategoryMappings(categories: Category[], gnucashAccounts: GnucashAccount[]):
      MappingSuggestion[]`
    - `applyAccountMapping(repos: Repositories, accountId: number, guid: string):
      Promise<void>`
    - `applyCategoryMapping(repos: Repositories, categoryId: number, guid: string):
      Promise<void>`
    - `clearMapping(repos: Repositories, kind: "account" | "category", id: number):
      Promise<void>`
    - `mappingStatus(finAccounts: Account[], categories: Category[], gnucashAccounts:
      GnucashAccount[]): MappingStatus`
    — verification: read exported declarations; `npm run typecheck` with call sites using
    these exact parameter types.

30. Supporting types `MappingSuggestion` and `MappingStatus` are exported named types
    (interface or type alias) from this module. — verification: read file; re-exported via
    `index.ts`.
    evaluator-note (minimum fields; additive fields and exact TS property names are
    implementer freedom): `MappingSuggestion` requires kind, fin-entity id, gnucash guid,
    and a reason string. `MappingStatus` requires unmapped fin accounts, unmapped
    categories, and unmapped gnucash accounts.

31. Every function body throws `new Error("not implemented")` (or equivalent single throw
    with that message) and performs no SQL or repository side effects. — verification: read
    function bodies.

### `src/core/gnucash-import.ts` — skeleton signatures

32. File exists; no Tauri imports. — verification: read imports; `npm run typecheck`.

33. Exported function signatures match exactly:
    - `planGnucashImport(repos: Repositories, list: GnucashTransactionList, options:
      GnucashImportOptions): Promise<GnucashImportPlan>`
    - `commitGnucashImport(db: Database, repos: Repositories, approved:
      GnucashImportApproval): Promise<GnucashImportResult>`
    — verification: read exported declarations; `npm run typecheck`.

34. Supporting types `GnucashImportOptions`, `GnucashImportPlan`, `GnucashImportApproval`,
    and `GnucashImportResult` are exported named types from this module. — verification:
    read file; re-exported via `index.ts`.
    evaluator-note (minimum fields; additive fields and exact TS property names are
    implementer freedom): `GnucashImportPlan` requires buckets new / unchanged / updated
    (with field-diffs) / merge-candidate / unmappable (with reasons) / unreadable (from
    reader errors). `GnucashImportApproval` requires approved rows in.
    `GnucashImportResult` requires inserted / merged / skipped counts out.
    `GnucashImportOptions` field shape remains unpinned.

35. Every function body throws `new Error("not implemented")`. — verification: read
    function bodies.

### `src/core/gnucash-export.ts` — skeleton signatures

36. File exists; no Tauri imports. — verification: read imports; `npm run typecheck`.

37. Exported function signatures match exactly:
    - `listExportablePayments(db: Database, filters: ExportFilters):
      Promise<ExportablePayment[]>`
    - `validateForExport(payments: Payment[], accounts: Account[], categories: Category[]):
      ExportValidation`
    - `buildQif(input: ExportBuildInput): string`
    - `buildCsv(input: ExportBuildInput): string`
    - `recordExport(db: Database, paymentIds: number[], format: "qif" | "csv"):
      Promise<void>`
    — verification: read exported declarations; `npm run typecheck`.

38. Supporting types `ExportFilters`, `ExportablePayment`, `ExportValidation`, and
    `ExportBuildInput` are exported named types from this module. — verification: read
    file; re-exported via `index.ts`.
    evaluator-note (minimum fields; additive fields and exact TS property names are
    implementer freedom): `ExportFilters` requires a date window and `includeExported`.
    `ExportablePayment` requires export history on rows (formats + timestamps).
    `ExportValidation` requires blockers with payment id + reason. `ExportBuildInput`
    requires payments, accounts, categories, and gnucash accounts.

39. Every async function body throws `new Error("not implemented")`; sync builders throw
    likewise. — verification: read function bodies.

### `src/core/gnucash-reconcile.ts` — skeleton signatures

40. File exists; no Tauri imports. — verification: read imports; `npm run typecheck`.

41. Exported function signatures match exactly:
    - `reconcile(db: Database, payments: Payment[], list: GnucashTransactionList, options:
      ReconcileOptions): Promise<ReconcileResult>`
    - `setManualMatch(db: Database, paymentId: number, txnGuid: string): Promise<void>`
    - `setManualUnmatch(db: Database, paymentId: number, txnGuid: string): Promise<void>`
    - `clearOverride(db: Database, paymentId: number, txnGuid: string): Promise<void>`
    - `summarize(result: ReconcileResult): ReconcileSummary[]`
    — verification: read exported declarations; `npm run typecheck`.

42. Supporting types `ReconcileOptions`, `ReconcileResult`, and `ReconcileSummary` are
    exported named types from this module. — verification: read file; re-exported via
    `index.ts`.
    evaluator-note (minimum fields; additive fields and exact TS property names are
    implementer freedom): `ReconcileOptions` requires `toleranceDays` defaulting to 3.
    `ReconcileResult` requires matched pairs, fin-app-only, gnucash-only, and
    carried-through reader errors. `ReconcileSummary` requires per-account counts and
    integer-cent totals.

43. Every function body throws `new Error("not implemented")`. — verification: read
    function bodies.

### `src/core/index.ts` — frozen export list

44. `index.ts` re-exports all public bindings from `gnucash-types.ts` (including
    `SUPPORTED_GNUCASH_RESAVE` and every type listed in criteria 15–26). — verification:
    read `export`/`export type` lines; `import { … } from "./core"` typecheck from a test
    harness file or existing consumer pattern.

45. `index.ts` re-exports all exported functions and types from `gnucash-mapping.ts`,
    `gnucash-import.ts`, `gnucash-export.ts`, and `gnucash-reconcile.ts` (including
    `GnucashMappingConflictError`, all skeleton functions, and supporting types from
    criteria 30, 34, 38, 42). — verification: read export list; grep `index.ts` for each
    exported symbol name.

46. No pre-existing exports from `index.ts` are removed or renamed. — verification: `git
    diff src/core/index.ts` shows only additive export lines for the five new modules.

47. After this task, `index.ts` export list for GnuCash modules is treated as frozen
    (documented in task file; no further edits in tasks 03–06). — verification: task-file
    constraint; evaluator confirms diff scope.

### Typecheck and regression

48. `npm run typecheck` exits 0. — verification: command output.

49. `npx vitest run tests/core/schema.test.ts` exits 0 (in-memory adapter applies all
    migration files including `0008`; existing assertions remain satisfied). — verification:
    command output.

50. `cargo test db --manifest-path src-tauri/Cargo.toml` exits 0. — verification: command
    output.

### No behavior change elsewhere

51. No files outside the task write fence are modified: `src-tauri/migrations/0008_*`,
    `src-tauri/src/db.rs` (limited edits per criterion 14), `src/core/gnucash-types.ts`,
    `src/core/gnucash-{mapping,import,export,reconcile}.ts`, `src/core/index.ts` only. —
    verification: `git diff --name-only` against task baseline.

52. No UI files (`src/**/*.tsx`), Rust reader module (`src-tauri/src/gnucash*.rs` or new
    `gnucash_*` commands in `lib.rs`), or `settings.ts` changes. — verification: `git
    diff` path filter.

53. No new Vitest or Rust test files in this task (task 08 owns dedicated GnuCash tests).
    — verification: `git diff --name-only` excludes `tests/**` additions.

## verification_environment

library (vitest + cargo test + tsc)

## out_of_scope

- Module bodies beyond `throw new Error("not implemented")` (tasks 03–06 fill
  `gnucash-mapping.ts`, `gnucash-import.ts`, `gnucash-export.ts`, `gnucash-reconcile.ts`).
- Rust GnuCash reader commands and IPC registration (task 02).
- GnuCash page UI (task 07).
- New dedicated GnuCash test files or extensions to `tests/core/schema.test.ts` beyond
  keeping existing suites green (task 08).
- Additive fields (and exact TypeScript property names) on skeleton supporting types
  beyond the evaluator-note minimums on criteria 30, 34, 38, and 42.
  `GnucashImportOptions` field shape remains unpinned.
- Index object names for migration 0008 (task specifies columns indexed, not index
  object names).

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T11:20:00-04:00
    note: Achievable within the eight-file write fence; db.rs and index.ts are surgical additions only.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T11:35:00-04:00
    note: Counter-signed with minimum supporting-type field pins from tasks 03–06; additive fields remain implementer freedom.
revision: 0
```
