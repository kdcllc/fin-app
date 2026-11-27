# Contract: 05-export-core

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

05-export-core

## done_definition

`src/core/gnucash-export.ts` is fully implemented (replacing every `"not implemented"`
throw) with the **exact frozen function signatures** from task 01. The module lists
exportable payments from the in-memory `Database` with optional export-history filtering,
validates mapping completeness via entity `gnucash_guid` columns, builds deterministic
in-memory QIF and CSV strings (no file I/O), and batch-records exports in
`payment_exports`. Money amounts are formatted from integer cents with divide-and-pad
string math (never float division; never `Number.prototype.toFixed` on float-derived
values). `tests/core/gnucash-export.test.ts` covers every requirement below using
`openTestDb()` from `tests/support/test-db.ts`. No UI, Rust, `index.ts`, or other core
module files change.

## acceptance_criteria

### Module boundary and frozen signatures

1. `src/core/gnucash-export.ts` exports the five functions with signatures matching the
   task-01 skeleton exactly:
   `listExportablePayments(db: Database, filters: ExportFilters):
   Promise<ExportablePayment[]>`,
   `validateForExport(payments: Payment[], accounts: Account[], categories: Category[]):
   ExportValidation`,
   `buildQif(input: ExportBuildInput): string`,
   `buildCsv(input: ExportBuildInput): string`,
   `recordExport(db: Database, paymentIds: number[], format: "qif" | "csv"):
   Promise<void>`. — verification: read exported declarations; `npm run typecheck`
   passes.

2. The module imports no Tauri APIs (`@tauri-apps/*`). — verification: read import
   block; grep for `@tauri-apps`.

3. Supporting exported types (`ExportFilters`, `ExportHistoryEntry`, `ExportablePayment`,
   `ExportBlocker`, `ExportValidation`, `ExportBuildInput`) remain exported from this
   module. — verification: read file; types compile when imported from the module path
   in tests.

4. `ExportBuildInput` retains the frozen minimum fields (`payments`, `accounts`,
   `categories`, `gnucashAccounts`) and adds `payees: Payee[]` so builders can resolve
   QIF `P` and CSV `description` from `payment.payee_id` without file I/O or DB access
   (additive field permitted by task-01 contract criterion 38 evaluator-note; function
   signatures unchanged). — verification: read `ExportBuildInput`; builder tests pass
   payee fixtures.

### `listExportablePayments`

5. Returns only payments whose `date` falls in the inclusive window
   `[filters.fromDate, filters.toDate]` (ISO `YYYY-MM-DD`). — verification: vitest
   unit test seeds payments inside, below, and above the window; result ids match only
   in-window rows.

6. When `filters.includeExported` is `false` (default), payments that have **any**
   row in `payment_exports` are excluded. — verification: vitest unit test inserts
   `payment_exports` for one payment, calls with `{ includeExported: false }`, asserts
   that payment is absent and an unexported peer is present.

7. When `filters.includeExported` is `true`, payments with prior export rows are
   included (forced re-export). — verification: vitest unit test with exported payment
   asserts it appears when `includeExported: true`.

8. Each returned row is an `ExportablePayment` (all `Payment` fields) with
   `exportHistory: ExportHistoryEntry[]` listing every `payment_exports` row for that
   payment: `{ format: "qif" | "csv", exportedAt: string }` per row, ordered oldest →
   newest by `exported_at`. — verification: vitest unit test records two exports
   (different formats/times) for one payment; `exportHistory` length is 2 with matching
   `format` values and ascending `exportedAt`.

9. Payments with empty export history return `exportHistory: []`. — verification:
   vitest unit test on a never-exported payment.

### `validateForExport`

10. Reads mapping state only from `accounts[].gnucash_guid` and
    `categories[].gnucash_guid` (not from `gnucashAccounts`). — verification: vitest
    unit test passes entities with null `gnucash_guid` despite a populated
    `gnucashAccounts` fixture; blockers still emitted.

11. Every payment whose funding account (`payment.account_id`) resolves to an account
    with null/ missing `gnucash_guid` produces a blocker `{ paymentId, reason }` whose
    `reason` identifies the unmapped funding account. — verification: vitest unit test
    with one unmapped account; `blockers` contains exactly that payment id.

12. Every payment with null `category_id` or whose category lacks `gnucash_guid`
    produces a blocker whose `reason` identifies the missing/unmapped category. —
    verification: vitest unit tests for null `category_id` and for category with null
    `gnucash_guid`.

13. Fully mapped payments (account and category both have non-null `gnucash_guid`)
    produce no blockers. — verification: vitest unit test; `blockers` is empty.

14. Multiple blockers can be returned for one payment when both account and category are
    unmapped (one blocker per violated rule, or one combined reason — either is
    acceptable if tests assert at least one blocker referencing the payment). —
    verification: vitest unit test with doubly unmapped payment; `blockers.some(b =>
    b.paymentId === id)`.

15. Export builders are used only with fully mapped inputs in tests; production callers
    are expected to filter blockers first. `buildQif` / `buildCsv` throw `Error` when
    invoked with a payment whose account or category `gnucash_guid` is null or absent
    from `input.gnucashAccounts`. — verification: vitest unit test expects throw on
    unmapped build input.

### Amount formatting (shared by QIF `T` and CSV `amount`)

16. Amounts derive from `payment.amount_cents` (integer) using divide-and-pad string
    math: `sign`, `Math.floor(abs/100)`, `(abs % 100).padStart(2,"0")` — the same
    algorithm as `formatCentsDecimal` in `src/core/report-queries.ts`. — verification:
    read implementation; vitest asserts no `/ 100` float path and no `.toFixed` on
    float-derived values (grep or behavioral pin below).

17. Negative `amount_cents` (money out) format as a leading minus, no thousands
    separators, exactly two decimal places: `1` → `-0.01`; `1067391` → `-10673.91`
    (explicitly **not** `-10,673.91`). — verification: vitest unit tests pin these
    exact strings in both QIF `T` lines and CSV `amount` cells.

18. Positive cents format with optional leading minus only when negative (no `+` prefix);
    e.g. `100` → `1.00`. — verification: vitest unit test on a credit/inflow payment
    if included in builder input.

### `buildQif`

19. Returns a single in-memory string; performs no file I/O or `invoke` calls. —
    verification: vitest unit test; read function body.

20. Output is grouped into one QIF section per distinct funding account
    (`payment.account_id`), ordered by the mapped GnuCash account `full_path` ascending
    (lexicographic). — verification: vitest unit test with two accounts whose GnuCash
    paths sort `Assets:Checking` before `Assets:Savings`; section order matches.

21. Each section opens with `!Account` on its own line, the mapped GnuCash
    `full_path` on the next line, then `!Type:` derived from fin-app `Account.kind`
    only: `checking` → `!Type:Bank`, `cash` → `!Type:Cash`, `credit` → `!Type:CCard`
    (never from `GnucashAccount.account_type`, so a LIABILITY-mapped credit card still
    emits `!Type:CCard`). — verification: vitest unit tests per kind; additional test
    with `account_type: "LIABILITY"` in `gnucashAccounts` still yields `!Type:CCard` for
    `kind: "credit"`.

22. Within a section, payment records are ordered by `date` ascending, then `id`
    ascending. — verification: vitest unit test with permuted input array; output
    record order matches sorted order.

23. Each payment record contains:
    - `D` + date as `MM/DD/YYYY` converted from ISO `payment.date`;
    - `T` + signed amount per criteria 16–18;
    - `P` + payee name resolved from `input.payees` by `payment.payee_id`;
    - `L` + mapped category GnuCash `full_path` (lookup `category.gnucash_guid` in
      `gnucashAccounts`);
    - `M` + memo **only when** `payment.memo` is non-null and non-empty;
    - `^` terminator on its own line. — verification: vitest golden-string test with
    memo present and absent cases.

24. Account `full_path` for `!Account` resolves via `account.gnucash_guid` →
    `gnucashAccounts[].full_path`. — verification: vitest unit test asserts `!Account`
    section header path matches fixture GnuCash account, not fin-app account name.

### `buildCsv`

25. Returns a single in-memory string; performs no file I/O. — verification: vitest
    unit test; read function body.

26. First line is the header exactly: `date,account,description,category,amount` (no
    BOM — unlike `exportReportCsv` in `src/report-csv.ts`, which is UI/Rust concern). —
    verification: vitest unit test asserts first line equals header string.

27. Data rows follow the same deterministic ordering as QIF: mapped GnuCash account
    `full_path` ascending, then `date`, then `id`. — verification: vitest unit test
    mirrors criterion 20–22 ordering assertions on CSV rows.

28. Column semantics per row:
    - `date`: `payment.date` as stored (`YYYY-MM-DD`);
    - `account`: mapped funding account GnuCash `full_path`;
    - `description`: payee name from `input.payees`;
    - `category`: mapped category GnuCash `full_path`;
    - `amount`: signed decimal per criteria 16–18. — verification: vitest golden-row
    test on a fully mapped payment fixture.

29. RFC-4180 quoting matches `escapeCsvField` behavior in
    `src/core/report-queries.ts`: fields containing `,`, `"`, CR, or LF are wrapped in
    double quotes; embedded `"` doubled. Fields without those characters are unquoted. —
    verification: vitest unit tests with payee/category strings containing commas and
    quotes; expected escaped output pinned.

### `recordExport`

30. Inserts one `payment_exports` row per id in `paymentIds` with the given `format`
    (`"qif"` or `"csv"`) in a single batch operation (one `db.batch` call or equivalent
    atomic multi-row insert — not N sequential executes). — verification: vitest unit
    test inspects `TestDb.calls` for a single `batch` (or documents one batch insert);
    row count matches `paymentIds.length`.

31. Re-exporting the same payment inserts an **additional** row; prior rows remain
    (history preserved). — verification: vitest unit test calls `recordExport` twice for
    the same id; `SELECT COUNT(*) FROM payment_exports WHERE payment_id = ?` returns 2.

32. After `recordExport`, `listExportablePayments` with default filters excludes those
    payment ids; with `includeExported: true` they reappear with updated
    `exportHistory`. — verification: vitest integration-style test chaining
    `recordExport` → `listExportablePayments`.

### Purity, constraints, and test file

33. `buildQif` and `buildCsv` are synchronous pure functions: no `Database` parameter,
    no side effects, deterministic output for the same input. — verification: read
    signatures; vitest calls twice with same input and asserts identical strings.

34. `src/core/gnucash-export.ts` does not write to any GnuCash file or invoke Rust. —
    verification: read module; grep for `invoke`, `gnucash_`, filesystem APIs.

35. File `tests/core/gnucash-export.test.ts` exists and passes:
    `npx vitest run tests/core/gnucash-export.test.ts`. — verification: command output
    exit code 0.

36. Tests use `openTestDb()` only (in-memory migrated schema); no real user book or
    GnuCash file paths. — verification: read test file imports and fixtures.

## verification_environment

library (vitest)

## out_of_scope

- UI export tab, file-save dialogs, and `src/report-csv.ts` / Rust `export_report_csv`
- Rust GnuCash reader commands and `src-tauri/**` (except reading migration SQL shape
  for `payment_exports` in tests)
- Other core modules (`gnucash-import.ts`, `gnucash-mapping.ts`, `gnucash-reconcile.ts`,
  repositories, `import-review.ts`, `index.ts`)
- Editing `payment_exports` or entity schemas beyond what migration 0008 already defines
- End-to-end GnuCash import of generated files

## pins (evaluator round 1 — orchestrator rulings)

1. **`ExportBuildInput.payees`** — required additive `payees: Payee[]` is approved (task-01 contract criterion 38 evaluator-note). QIF `P` and CSV `description` resolve through this array; builders stay pure (no DB or file I/O). Frozen function signatures are unchanged.
2. **Date formats** — CSV `date` stays ISO `YYYY-MM-DD` as stored on `payment.date`. Only QIF `D` lines convert to `MM/DD/YYYY`, by rearranging the ISO calendar parts (not `Date` timezone conversion).
3. **Doubly-unmapped payments** — one or two blocker entries is acceptable provided the payment id appears with account and/or category reasons (criterion 14).
4. **Amount formatter** — self-contained divide-and-pad in this module (`sign`, `Math.floor(abs / 100)`, `(abs % 100).toString().padStart(2, "0")`). Do **not** import `formatCentsDecimal` from `report-queries.ts`. Integer `Math.floor(abs / 100)` is the required algorithm, not a forbidden float path.
5. **Money-out pins are law** — tests seed positive stored `amount_cents` of `1` and `1067391` (bill-pay amounts are stored `> 0`) and assert the exact strings `-0.01` and `-10673.91` (no thousands separators) on both QIF `T` and CSV `amount`. Builders treat positive stored cents as money out: negate, then divide-and-pad. Criterion 18 is light coverage that a positive *signed* value formats as `1.00` with no `+` prefix; it does not override the money-out pins. Bill-pay exports are predominantly outflows.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T13:15:00-04:00
    note: Achievable within fence; ExportBuildInput gains required payees[] (additive, signatures unchanged).
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T14:20:00-04:00
    note: Counter-signed round 1. Five orchestrator rulings recorded as pins; money-out strings -0.01 and -10673.91 are law.
revision: 0
```
