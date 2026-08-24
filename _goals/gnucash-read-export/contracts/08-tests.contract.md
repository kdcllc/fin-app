# Contract: 08-tests

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

08-tests

## done_definition

Three test artifacts close the GnuCash goal's coverage gaps without touching product
code: `tests/fixtures/gnucash/reader-output.json` (canned probe, accounts, and transaction
list aligned with `fixture-book.sql`), `tests/core/gnucash-pipeline.test.ts` (one
in-memory-DB end-to-end flow through mapping → import → re-import no-op → export →
reconcile with per-step `payments` / `payment_exports` / `gnucash_matches` assertions and
exact integer cents), and `tests/gnucash-page.test.tsx` (outcome-focused page tests with
all Tauri/invoke surfaces mocked, real core + `openTestDb()` for `db` and `repos`).
A completion-report coverage audit maps every symbol exported by tasks 01–07 to its
covering test file(s), filling gaps in these artifacts or documenting justified exceptions.
Targeted Vitest (`npx vitest run tests/gnucash-page.test.tsx
tests/core/gnucash-pipeline.test.ts`) and the full TS suite (`npm test`) exit 0.

## acceptance_criteria

### Write fence and mocking discipline

1. Only these files are created or modified: `tests/fixtures/gnucash/reader-output.json`,
   `tests/core/gnucash-pipeline.test.ts`, `tests/gnucash-page.test.tsx`. — verification:
   `git diff --name-only` against task baseline excludes product code, Rust tests, and
   `ci.yml`.

2. No test opens a real GnuCash book, Tauri runtime, or network — all
   `src/gnucash-book.ts` invoke wrappers (`gnucashProbeBook`, `gnucashListAccounts`,
   `gnucashListTransactions`, `loadGnucashBookState`, `updateGnucashBookState`),
   `@tauri-apps/plugin-dialog` (`open` / `save`), and `src/report-csv.ts`
   (`exportReportCsv`) are mocked in page tests. — verification: read
   `tests/gnucash-page.test.tsx` mock blocks; grep for real `invoke(` / unmocked dialog
   imports returns none.

3. Core pipeline and page DB assertions use `openTestDb()` from
   `tests/support/test-db.ts` (production migrations, `foreign_keys=ON`) — never the
   user's fin-app book. — verification: read test setup; no paths outside
   `tests/fixtures/gnucash/`.

### Fixture — `tests/fixtures/gnucash/reader-output.json`

4. File exists and parses as JSON with exactly three top-level keys: `probe`,
   `accounts`, `transactionList`. — verification: read file; `JSON.parse` in a one-liner
   or Vitest smoke assertion.

5. `probe` is a valid `GnucashBookProbe` for the sqlite3 fixture:
   `{ "status": "ok", "schemaVersion": 5000000 }` (matches `versions.Gnucash` in
   `fixture-book.sql`). — verification: read JSON; type-compatible with
   `src/core/gnucash-types.ts`.

6. `accounts` is a `GnucashAccount[]` mirroring `fixture-book.sql`: includes every
   non-hidden account (no `ROOT-template` branch, no `"Template Electric Bill"`), with
   pinned examples:
   - `a0000000000000000000000000000002` — `account_type: "BANK"`,
     `full_path: "Assets:Checking …9002"`, `commodity_mnemonic: "USD"`,
     `commodity_fraction: 100`;
   - `a0000000000000000000000000000004` — `CREDIT`, `"Liabilities:Visa"`;
   - `a0000000000000000000000000000007` — `EXPENSE`, `"Expenses:Utilities:Electric"`;
   - `a0000000000000000000000000000008` — `EXPENSE`, `"Expenses:Groceries"`.
   Each entry has all IPC keys: `guid`, `name`, `account_type`, `parent_guid`,
   `placeholder`, `commodity_mnemonic`, `commodity_fraction`, `full_path`. —
   verification: read JSON; cross-check GUIDs against `fixture-book.sql`; optional
   Vitest assertion that account count matches Rust
   `gnucash_list_accounts_tree_and_paths` expectations (≥ 10 visible accounts).

7. `transactionList` is a valid `GnucashTransactionList` covering the fixture's
   **2026-01-01 … 2026-02-28** window for import-eligible accounts (`CHECKING`
   `a0000000000000000000000000000002` and `VISA`
   `a0000000000000000000000000000004`), mirroring Rust reader output:
   - **12** entries in `transactions` (all parseable fixture txns: 7 January + 5 February
     including `t00000000000000000000000000000008` "Large purchase" on Visa);
   - **1** entry in `errors` for the inexact rational txn
     `t0000000000000000000000000000000d` with `post_date: "2026-02-20"`,
     `description: "Inexact rational txn"`, and `reason` containing `"inexact rational"`;
   - the inexact GUID must **not** appear in `transactions`. —
   verification: read JSON; counts and GUIDs match `fixture-book.sql` and Rust test
   `gnucash_list_transactions_inexact_rational_in_errors`.

8. Pinned edge amounts (integer cents) appear on the correct txn/split entries:
   - `t00000000000000000000000000000008` ("Large purchase"): Visa split
     `value_cents: -1067391`, expense split `+1067391`;
   - `t00000000000000000000000000000005` ("Penny purchase"): checking split
     `value_cents: -1`, expense split `+1`. —
   verification: read JSON splits; pipeline or fixture assertion.

9. All `post_date` values are ISO `YYYY-MM-DD` (reader-normalized from GnuCash
   `…105900` timestamps), e.g. `"2026-01-08"` for Electric bill Jan. — verification:
   read JSON; regex `/^\d{4}-\d{2}-\d{2}$/` on every txn and error `post_date`.

### Core pipeline — `tests/core/gnucash-pipeline.test.ts`

10. Single `describe` (or nested describes under one root) runs **one integrated flow**
    over `openTestDb()` — no Tauri, no file I/O. — verification: read test file.

11. **Setup — mapping:** seed fin-app entities and apply mappings using fixture GUIDs from
    `reader-output.json`:
    - fin-app checking account ↔ `a0000000000000000000000000000002` via
      `applyAccountMapping`;
    - categories ↔ Electric (`…0007`) and Groceries (`…0008`) via
      `applyCategoryMapping`;
    - at least one existing payee for normalized matches.
    Assert `accounts.gnucash_guid` / `categories.gnucash_guid` persisted. —
    verification: unit test DB `select` after mapping step.

12. **Import — plan + commit:** load `transactionList` from fixture; call
    `planGnucashImport(repos, list, { accountGuids: [CHECKING_GUID] })` (or equivalent
    subset covering January checking txns plus the error entry when in range).
    Assert plan buckets:
    - at least one **new** committable row with exact `amount_cents` (e.g. `4858` for
      Electric bill Jan);
    - **unreadable** row for `t0000000000000000000000000000000d` with matching
      `error.txn_guid` and `error.reason`;
    - unreadable row has **no** commit approval path (not in `approvedNewTxnGuids`).
    Commit approved new rows via `commitGnucashImport(db, repos, …)` with
    `confirmedPayeeIds` where needed. Assert after commit:
    - `payments` rows inserted with `source = 'gnucash'`, `external_ref` = txn GUID,
      exact integer `amount_cents`;
    - **no** `payments` row with `external_ref =
      't0000000000000000000000000000000d'`;
    - `payment_exports` and `gnucash_matches` counts unchanged from pre-commit baseline. —
    verification: unit test table queries after commit.

13. **Re-import no-op:** run `planGnucashImport` again on the same `transactionList`;
    expect new/updated/merge buckets empty and rows in **unchanged**; second
    `commitGnucashImport` with empty approvals yields `{ inserted: 0, merged: 0, skipped: 0 }`
    and **unchanged** `payments` row count. — verification: unit test assertions.

14. **Export subset:** insert or select a subset of imported/manual payments; call
    `buildQif` and `buildCsv` with fully mapped `ExportBuildInput`; assert output strings
    contain pinned ISO dates and cent-exact decimal amounts (e.g. `-48.58`, `-10673.91`,
    `-0.01` per sign conventions in existing `gnucash-export.test.ts`); call
    `recordExport(db, paymentIds, 'qif')` (and/or `'csv'`). Assert `payment_exports` rows
    inserted with correct `payment_id` and `format`. — verification: unit test string +
    `SELECT COUNT(*) FROM payment_exports`.

15. **Reconcile:** seed one **fin-app-only** manual payment (no matching GnuCash txn in
    the filtered list) and ensure one **GnuCash-only** txn remains in the fixture list
    (not imported). Call `reconcile(db, payments, list, { toleranceDays: 3 })`. Assert:
    - fin-app-only payment appears in `result.finAppOnly`;
    - GnuCash-only txn appears in `result.gnucashOnly`;
    - `result.readerErrors` includes the inexact txn error (same GUID + reason as fixture);
    - `summarize(result)` cent totals use integer math.
    Apply `setManualMatch(db, paymentId, txnGuid)` for a pair, re-run reconcile, assert
    pair moves to `matched` and `gnucash_matches` row exists with `status = 'matched'`. —
    verification: unit test bucket membership + `SELECT * FROM gnucash_matches`.

16. **Per-step DB snapshots:** the test records and asserts `payments`,
    `payment_exports`, and `gnucash_matches` counts (and key row fields where relevant)
    after mapping, commit, re-import, export, and reconcile — not only final state. —
    verification: read test; multiple assertion checkpoints.

17. **Exact cents throughout:** at least one assertion each for `1067391` and `1` cent
    amounts round-tripping from fixture → payment row → export string without float drift. —
    verification: unit test `expect(payment.amount_cents).toBe(1067391)` / `.toBe(1)`.

### Page tests — `tests/gnucash-page.test.tsx`

18. File uses `// @vitest-environment jsdom` and renders `GnuCashPage` with **required**
    props `db` and `repos` from `openTestDb()` per `GnuCashPageProps`
    (`src/pages/GnuCashPage.tsx` lines 48–53). Optional `pickBookPath` /
    `pickSavePath` injectors replace native dialog calls. — verification: read render
    calls; TypeScript compiles.

19. **`vi.mock("../src/gnucash-book")`** provides controllable stubs for all five
    exports; **`vi.mock("../src/report-csv")`** stubs `exportReportCsv`; dialog plugin
    mocked when `pickBookPath` / `pickSavePath` not injected. In-memory book state for
    `loadGnucashBookState` / `updateGnucashBookState` is simulated in-test (plain object
    or mock implementation — no `LazyStore`). — verification: read mock block.

20. **All five tabs render** with outcome assertions: click each tab button
    (`Link book`, `Account mapping`, `Import`, `Export`, `Reconcile`) and assert
    tab-specific heading or control present (not merely "no throw"). — verification:
    unit test `screen.getByRole` / `findByText` per tab.

21. **XML book walkthrough:** mock `gnucashProbeBook` returning `{ status: "xml" }` after
    pick; assert conversion walkthrough copy (File → Save As → sqlite3 / Resave guidance)
    is visible; assert `updateGnucashBookState` was **not** called with the XML path
    (book remains unlinked or prior path unchanged). — verification: unit test mock call
    counts + visible text.

22. **Missing / broken book blocking:** mock persisted `bookPath` non-null with probe
    `{ status: "missing" }` (or `"unknown-schema"` / `"unreadable"`). On blocked tabs
    (mapping/import/export/reconcile), assert blocking message + `Re-link book` control;
    Link tab remains usable. **Other app pages reachable:** either (a) render `App` with
    gnucash mocks and navigate to Dashboard/Import confirming those headings render, or
    (b) document in test that blocking is page-scoped via isolated `GnuCashPage` render
    plus a separate lightweight assertion that `App` nav items are unchanged (read-only
    grep). Prefer (a) when `App.tsx` already passes `db`/`repos` to `GnuCashPage`. —
    verification: unit test interaction; if App test deferred, completion report notes
    pattern (b) with explicit nav smoke.

23. **Mapping suggestion apply persists:** with probe `ok` and fixture `accounts`, render
    mapping tab; click **Apply** on an account suggestion; assert fin-app account row in
    DB (`accounts.gnucash_guid`) updated via real `applyAccountMapping` through UI. —
    verification: unit test DB query after click.

24. **Import review — all buckets:** mock `gnucashListTransactions` returning a crafted
    `GnucashTransactionList` (may import from `reader-output.json`) and drive **Plan
    import** → review step. Assert visible sections/rows for **new**, **updated** (with
    diff text), **merge candidates**, **unmappable** (GUID + reason), and **unreadable**
    (GUID + reason from `error.txn_guid` / `error.reason`). Unreadable/unmappable rows
    have **no** approve checkbox. — verification: unit test DOM + absence of commit
    checkbox query.

25. **Payee auto-create requires confirmation:** plan includes `payeeCreateSuggestion`;
    assert **Commit import** disabled until user clicks **Create payee** or selects
    existing payee; after confirm, commit succeeds and `payees` row count increases by
    one. — verification: unit test button disabled state + DB count.

26. **Export blocks unmapped:** seed payment with unmapped account or category; load
    export tab payments; assert **Mapping blockers** list visible and **Export** button
    disabled; no `exportReportCsv` / `recordExport` calls. — verification: mock call counts
    + disabled assertion.

27. **Export excludes already-exported by default:** seed imported payment + prior
    `recordExport`; load payments without "Include previously exported"; assert payment
    absent from list; toggle checkbox, assert payment appears. — verification: unit test
    DOM/table rows.

28. **Reconcile manual match persists:** mock transactions + seed fin-app payments;
    run reconcile; select fin-app-only and GnuCash-only entries in manual match controls;
    click **Match selected**; assert matched pair in results table and
    `gnucash_matches` row in DB; re-run reconcile, pair stays matched. — verification:
    unit test DB + DOM.

29. **Reader-error strip on reconcile:** when mocked list includes `errors`, run
    reconcile; assert **Reader errors** section lists `t0000000000000000000000000000000d`
    GUID and reason substring (not buried inside match buckets). — verification: unit test
    `screen.getByText` / role queries.

30. **Outcome-only assertions:** no test whose sole assertion is "renders without
    crashing" — every `it` checks DOM state, mock call counts, and/or DB rows. —
    verification: read test bodies.

### Coverage audit (completion report deliverable)

31. Completion report includes a markdown table: **Export (tasks 01–07)** → **Covering
    test file(s)** → **Notes**. Minimum rows:

    | Export | Covering test file(s) | Notes |
    |--------|----------------------|-------|
    | `SUPPORTED_GNUCASH_RESAVE`, GnuCash IPC types (`GnucashBookProbe`, `GnucashAccount`, `GnucashTransaction`, `GnucashTransactionList`, `GnucashTransactionError`, `GnucashSplit`) | `reader-output.json`, `gnucash-pipeline.test.ts`, `gnucash-page.test.tsx`, per-module core tests | Structural / fixture typing |
    | `suggestAccountMappings`, `suggestCategoryMappings`, `applyAccountMapping`, `applyCategoryMapping`, `clearMapping`, `mappingStatus`, `GnucashMappingConflictError` | `tests/core/gnucash-mapping.test.ts`, `gnucash-page.test.tsx` (apply persists) | |
    | `planGnucashImport`, `commitGnucashImport`, import plan/result types | `tests/core/gnucash-import.test.ts`, `gnucash-pipeline.test.ts`, `gnucash-page.test.tsx` | |
    | `listExportablePayments`, `validateForExport`, `buildQif`, `buildCsv`, `recordExport`, export types | `tests/core/gnucash-export.test.ts`, `gnucash-pipeline.test.ts`, `gnucash-page.test.tsx` | |
    | `reconcile`, `summarize`, `setManualMatch`, `setManualUnmatch`, `clearOverride`, reconcile types | `tests/core/gnucash-reconcile.test.ts`, `gnucash-pipeline.test.ts`, `gnucash-page.test.tsx` | |
    | `GnuCashPage`, `GnuCashPageProps` | `tests/gnucash-page.test.tsx` | |
    | `loadGnucashBookState`, `updateGnucashBookState`, `gnucashProbeBook`, `gnucashListAccounts`, `gnucashListTransactions`, `GnucashBookState` | `tests/gnucash-page.test.tsx` (mocked invoke surface) | Justified: thin IPC wrappers; behavior exercised via page mocks |
    | Rust reader commands | `src-tauri` tests (task 02) | Out of scope for 08 |

    Any row marked "gap" must be closed by adding assertions to the two new test files in
    this task or given an explicit justification. — verification: read completion report
    table; evaluator cross-check against `src/core/index.ts` exports and
    `src/pages/GnuCashPage.tsx`.

### Verification commands

32. Targeted new tests pass:
    `npx vitest run tests/gnucash-page.test.tsx tests/core/gnucash-pipeline.test.ts` —
    verification: command output exit 0 with all tests passed.

33. Full TS suite passes: `npm test` (Vitest run over the repo test tree) — verification:
    command output exit 0; report pass count in completion report.

## verification_environment

library (vitest)

## out_of_scope

- Product-code changes (`src/**`, `src-tauri/**`, migrations) — report gaps instead of
  editing.
- Rust reader tests and `cargo test` (task 02 owns).
- `.github/workflows/ci.yml` and rung-3 cross-stack CI.
- Modifying existing per-module core tests except when a failing assertion requires test
  fixture alignment (prefer fixing new files first; escalate if product bug).
- `tests/app-shell.test.tsx` updates (orchestrator/task 07 pin: out of fence unless
  evaluator escalates).

## pins (evaluator round 1 — orchestrator rulings)

1. **`reader-output.json` shape** — APPROVED. Top-level object is exactly
   `{ probe, accounts, transactionList }` (AC4).
2. **`transactionList` scope** — APPROVED. CHECKING
   `a0000000000000000000000000000002` + VISA `a0000000000000000000000000000004`,
   `2026-01-01`…`2026-02-28`, **12** parseable txns + **1** error
   (`t0000000000000000000000000000000d`). Pipeline MAY import a CHECKING-only
   subset. The error entry MUST be exercised end-to-end: plan unreadable → never
   committed (no `payments` row for that GUID) → `result.readerErrors` on
   reconcile. **AC17 under CHECKING-only:** the penny (`t…0005`) MUST round-trip
   import → `payments.amount_cents === 1` → export string. `1067391` MAY
   round-trip by also importing VISA `t…0008` **or** by seeding an export payment
   copied from that fixture amount; the JSON MUST still pin `value_cents`
   ±1067391 on `t…0008` (AC8).
3. **"Other pages reachable"** — APPROVED. Page-scoped blocking assertions on an
   isolated `GnuCashPage` render are sufficient (AC22 option b). A full `App` nav
   smoke is optional, not required. `tests/app-shell.test.tsx` is out of fence and
   already proves the shell.
4. **Coverage audit** — APPROVED. Lives in the completion report (AC31), not as a
   fourth fenced file. Type-only `src/core/index.ts` exports (`GnucashAccountType`,
   `MappingKind`, `MappingStatus`, `MappingSuggestion`) MUST appear in that table
   (folding into existing rows is fine).
5. **app-shell / `openBook` mock** — ALREADY RESOLVED. Verified
   `tests/app-shell.test.tsx` lines 29–30:
   `openBookMock = vi.fn(async () => ({ db: dbStub, repos: reposStub }))`. Task 08
   must not edit that file.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T18:30:00-04:00
    note: Achievable within the three-file write fence; reader-output.json + pipeline + page tests cover all task checkboxes against implemented surfaces.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T19:10:00-04:00
    note: Counter-signed round 1. Five orchestrator rulings recorded as pins; AC17 1067391 may seed or VISA-import under CHECKING-only; app-shell mock already { db, repos } (tests/app-shell.test.tsx:29-30). No revision.
revision: 0
```
