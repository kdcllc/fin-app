# Task 01: contract-schema

## Objective

The frozen boundary every other task builds against: migration 0008 (export tracking +
reconciliation override tables), the TypeScript types for all GnuCash data crossing the
IPC boundary (with the Rust command names and JSON payload shapes documented on the
types), skeleton files for the four new core modules, and their `src/core/index.ts`
exports. After this task, tasks 02–06 can proceed in parallel without touching any
shared file.

## Dependencies

- none

```yaml
# --- task ownership contract ---
writes:
  - src-tauri/migrations/0008_gnucash_integration.sql
  - src-tauri/src/db.rs            # MIGRATIONS array entry + test constants only
  - src/core/gnucash-types.ts
  - src/core/gnucash-mapping.ts    # skeleton: exported signatures, TODO bodies
  - src/core/gnucash-import.ts     # skeleton
  - src/core/gnucash-export.ts     # skeleton
  - src/core/gnucash-reconcile.ts  # skeleton
  - src/core/index.ts              # add exports for the five new modules
reads:
  - src/core/entities.ts
  - src/core/db.ts
  - src-tauri/migrations/0001_schema_v1.sql
depends_on: []
owner: implementer
rewrite_semantics: targeted-insertion   # db.rs and index.ts are shared files
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] Migration `0008_gnucash_integration.sql` creates:
      `payment_exports` (id INTEGER PK, payment_id INTEGER NOT NULL REFERENCES
      payments(id), format TEXT NOT NULL CHECK (format IN ('qif','csv')),
      exported_at TEXT NOT NULL DEFAULT (datetime('now'))) and
      `gnucash_matches` (id INTEGER PK, payment_id INTEGER NOT NULL REFERENCES
      payments(id), txn_guid TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN
      ('matched','unmatched')), created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (payment_id, txn_guid)), plus indexes on `payment_exports.payment_id` and
      `gnucash_matches.txn_guid`.
- [ ] `db.rs` `MIGRATIONS` gains `(8, include_str!("../migrations/0008_gnucash_integration.sql"))`;
      the `LATEST_VERSION`/`EXPECTED_TABLES` test assertions are updated so
      `cargo test` stays green. No other `db.rs` change.
- [ ] `src/core/gnucash-types.ts` defines (all money as integer cents, dates as
      `YYYY-MM-DD` strings):
      - `GnucashBookProbe` — discriminated union over
        `{ status: "ok", schemaVersion: number }` | `{ status: "xml" }` |
        `{ status: "unknown-schema", detail: string }` | `{ status: "missing" }` |
        `{ status: "unreadable", detail: string }`.
      - **Schema-version pin**: a book is `ok` only when its `versions` table has key
        `Gnucash-Resave` with value exactly `19920` (the value GnuCash 2.6–5.x SQL
        books carry; the implementer verifies against piecash's reference semantics
        and the fixture, and adjusts the pin with a comment if the reference
        disagrees). Any other value → `unknown-schema` with the found value in
        `detail`. Exported as `const SUPPORTED_GNUCASH_RESAVE = 19920`. The `ok`
        variant's `schemaVersion` is display information: the `versions` table's
        `Gnucash` key value (the writing GnuCash version); the compatibility gate is
        `Gnucash-Resave` alone.
      - `GnucashAccount` — `guid`, `name`, `account_type` (string union incl. BANK,
        CASH, CREDIT, LIABILITY, INCOME, EXPENSE, EQUITY, ROOT), `parent_guid | null`,
        `placeholder: boolean`, `commodity_mnemonic`, `commodity_fraction`,
        `full_path` (colon-joined, e.g. `Expenses:Utilities:Electric`).
      - `GnucashTransaction` — `txn_guid`, `post_date`, `description`,
        `splits: GnucashSplit[]`.
      - `GnucashSplit` — `split_guid`, `account_guid`, `memo`, `value_cents` (integer,
        converted from rational at the Rust boundary).
      - `GnucashTransactionError` — `{ txn_guid: string; post_date: string | null;
        description: string | null; reason: string }` for transactions the reader
        cannot represent (inexact rational conversion, malformed rows). The
        list-transactions result type is
        `GnucashTransactionList = { transactions: GnucashTransaction[];
        errors: GnucashTransactionError[] }` — errors are surfaced, never dropped.
      - JSDoc on each type naming the Rust command that produces it:
        `gnucash_probe_book(path)`, `gnucash_list_accounts(path)`,
        `gnucash_list_transactions(path, account_guids, from, to)` →
        `GnucashTransactionList`.
- [ ] The four skeleton modules exist with EXACTLY these exported signatures (typed,
      documented, bodies `throw new Error("not implemented")`; supporting result/input
      types defined alongside). Signatures take repositories/`Database` plus plain
      data — core never imports Tauri APIs:
      - `gnucash-mapping.ts`: `class GnucashMappingConflictError extends Error`
        (thrown when applying a mapping would duplicate a GUID within an entity
        kind — part of the frozen public surface so the UI can `instanceof` it),
        `suggestAccountMappings(finAccounts: Account[],
        gnucashAccounts: GnucashAccount[]): MappingSuggestion[]`,
        `suggestCategoryMappings(categories: Category[], gnucashAccounts:
        GnucashAccount[]): MappingSuggestion[]`,
        `applyAccountMapping(repos: Repositories, accountId: number, guid: string):
        Promise<void>`, `applyCategoryMapping(repos: Repositories, categoryId: number,
        guid: string): Promise<void>`, `clearMapping(repos: Repositories, kind:
        "account" | "category", id: number): Promise<void>`,
        `mappingStatus(finAccounts: Account[], categories: Category[],
        gnucashAccounts: GnucashAccount[]): MappingStatus`.
      - `gnucash-import.ts`: `planGnucashImport(repos: Repositories, list:
        GnucashTransactionList, options: GnucashImportOptions):
        Promise<GnucashImportPlan>`, `commitGnucashImport(db: Database, repos:
        Repositories, approved: GnucashImportApproval): Promise<GnucashImportResult>`.
      - `gnucash-export.ts`: `listExportablePayments(db: Database, filters:
        ExportFilters): Promise<ExportablePayment[]>`,
        `validateForExport(payments: Payment[], accounts: Account[], categories:
        Category[]): ExportValidation`, `buildQif(input: ExportBuildInput): string`,
        `buildCsv(input: ExportBuildInput): string`, `recordExport(db: Database,
        paymentIds: number[], format: "qif" | "csv"): Promise<void>`.
      - `gnucash-reconcile.ts`: `reconcile(db: Database, payments: Payment[],
        list: GnucashTransactionList, options: ReconcileOptions):
        Promise<ReconcileResult>`, `setManualMatch(db: Database, paymentId: number,
        txnGuid: string): Promise<void>`, `setManualUnmatch(db: Database, paymentId:
        number, txnGuid: string): Promise<void>`, `clearOverride(db: Database,
        paymentId: number, txnGuid: string): Promise<void>`,
        `summarize(result: ReconcileResult): ReconcileSummary[]`.
- [ ] `src/core/index.ts` re-exports exactly: everything from `gnucash-types.ts` and
      the exported functions/types of the four modules above. This export list is
      FROZEN after this task — tasks 03–06 fill bodies without touching `index.ts`.
- [ ] `npm run typecheck` passes.
- [ ] No behavior change anywhere else; no UI or Rust reader code in this task.

## Files to Read

- `src/core/README.md` — core conventions and the boundary rule
- `src/core/entities.ts` — existing entity/type conventions
- `src-tauri/src/db.rs` — MIGRATIONS array shape and the tests-module constants
  (`LATEST_VERSION`, `EXPECTED_TABLES`)
- `.claude/skills/gnucash-data-model/SKILL.md` — data-model essentials (account types,
  rationals, GUIDs)
- `_goals/gnucash-read-export/goal.md` — discovery decisions
- `_goals/gnucash-read-export/03-book-link-mapping-core.md`, `04-import-core.md`,
  `05-export-core.md`, `06-reconcile-core.md` — the consumers of the frozen
  signatures; the skeletons must satisfy their requirements exactly

## Files to Create / Change

- Exactly the ownership contract's write set: migration 0008, `db.rs` (targeted
  insertion), `gnucash-types.ts`, four skeletons, `index.ts` exports.

## Constraints

- Must: follow the migration style of `0003_import_idempotency.sql`+ (append-only,
  never edit shipped migrations); integer cents; quote all dates as TEXT.
- Must NOT: implement any module body, touch the UI, add Rust code beyond the `db.rs`
  MIGRATIONS entry, or edit `settings.ts`.

## Verification

- Targeted test command: `npx vitest run tests/core/schema.test.ts` (in-memory adapter
  applies migration files; must stay green) and
  `cargo test db --manifest-path src-tauri/Cargo.toml`
- `npm run typecheck` passes with the new exports.
