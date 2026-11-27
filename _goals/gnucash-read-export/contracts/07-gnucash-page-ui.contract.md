# Contract: 07-gnucash-page-ui

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

07-gnucash-page-ui

## done_definition

The GnuCash nav placeholder is replaced by `src/pages/GnuCashPage.tsx`: a five-tab page
(Link book, Account mapping, Import, Export, Reconcile) wired to `src/gnucash-book.ts`
invoke wrappers and the frozen core APIs exported from `src/core/index.ts`, with a
blocking re-link gate when a previously linked book probes `missing`, `xml`, or
`unknown-schema`. Every requirement checkbox in `07-gnucash-page-ui.md` is satisfied with
loading/error states on all invokes, integer-cent money via `formatCentsDecimal`, and no
SQL or deep core imports. `App.tsx` swaps the placeholder branch for `GnuCashPage` with
only the routing/import changes needed to pass `repos` and the fin-app `Database` handle.
`npm run typecheck` and `npm run lint` pass. Page-level vitest coverage lands in task 08;
behavioral screenshots for link, blocking, mapping, import review, export, and reconcile
are captured at the QA gate per `tauri-qa-testing`.

## acceptance_criteria

### Write fence, imports, and App routing

1. Only these files are created or modified: `src/pages/GnuCashPage.tsx`, `src/App.tsx`. —
   verification: `git diff --name-only` against task baseline.

2. `src/pages/GnuCashPage.tsx` imports domain logic only from `../core` (public entry),
   `../gnucash-book`, and existing UI utilities (`../report-csv` for file-save invoke,
   `@tauri-apps/plugin-dialog` for pick/save dialogs). No imports from
   `src/core/gnucash-*`, `src/core/repositories/*`, or `src/core/adapters/*`. —
   verification: read import block; ESLint `no-restricted-imports` passes via
   `npm run lint`.

3. `GnuCashPage` does not issue SQL or call Tauri invoke for operations already wrapped
   in `src/gnucash-book.ts` or core (except the existing `exportReportCsv` write path from
   `src/report-csv.ts`). — verification: read `GnuCashPage.tsx`; grep for `` `SELECT `` /
   `` `INSERT `` / `` `UPDATE `` / raw `invoke(` outside allowed modules returns none.

4. `App.tsx` imports `GnuCashPage` and routes `active.id === "gnucash"` to it instead of
   `PlaceholderPage`; no other page branches, nav items, or layout structure change. —
   verification: read `App.tsx` diff; code inspection.

5. `App.tsx` passes `GnuCashPage` at minimum `repos: Repositories` and `db: Database`
   (fin-app book connection). Because `openRustSqliteDatabase` allows one session
   connection, App retains the `Database` instance from the initial book open (may
   replace `openBook()` calls with `openRustSqliteDatabase` + `createRepositories`
   inline — still within `App.tsx` only). — verification: read `App.tsx`; `npm run
   typecheck`.

6. Money amounts throughout the page render via `formatCentsDecimal` from `../core`
   (optionally wrapped in a local currency helper mirroring `ReportsPage`'s `toCurrency`). —
   verification: read `GnuCashPage.tsx`; grep confirms no float money math or
   hand-rolled cent formatting.

7. Page structure reuses existing conventions: `<section className="page">`, `App.css`
   button/table classes (`primary`, `muted`, `error`, `import-panel`, `import-table`
   where applicable). — verification: read JSX; QA screenshot.

### Page shell — five tabs

8. `GnuCashPage` exposes five user-visible tabs/sections: **Link book**, **Account
   mapping**, **Import**, **Export**, **Reconcile** (labels may vary slightly; all five
   must be reachable without leaving the page). — verification: code inspection; QA
   screenshot showing tab strip.

9. Tab switching is client-side state (no router); active tab content renders in-place. —
   verification: code inspection.

10. On mount, the page loads persisted state via `loadGnucashBookState()` from
    `../gnucash-book`. When `bookPath` is non-null, it immediately probes that path via
    `gnucashProbeBook(bookPath)` to determine link health (drives blocking state and Link
    tab summary). — verification: read load/probe effect; code inspection.

### Link book tab

11. **Pick book**: a control opens the native file picker using `@tauri-apps/plugin-dialog`
    `open` (same pattern as `ImportPage` `chooseWorkbook` — title/filters appropriate for
    GnuCash book files). — verification: code inspection; QA screenshot.

12. After pick, the page calls `gnucashProbeBook(chosenPath)` and branches on
    `probe.status` before any persist:
    - `ok` → `updateGnucashBookState({ bookPath: chosenPath })`, then refresh summary.
    - `xml` → show File → Save As → sqlite3 conversion walkthrough text; **do not** call
      `updateGnucashBookState` with the XML path.
    - `missing` / `unreadable` / `unknown-schema` → show guiding error using probe
      `detail` where present; **do not** persist the path.
    — verification: code inspection of probe handler; QA screenshots for `ok` and `xml`
    paths against fixture book.

13. Walkthrough for `xml` status references GnuCash **File → Save As** choosing **sqlite3**
    format (guidance text, not parsing). May cite `SUPPORTED_GNUCASH_RESAVE` / supported
    schema context from core if helpful. — verification: read rendered copy in source; QA
    screenshot with XML fixture or mocked probe.

14. When linked (`bookPath` non-null and last probe `ok`), Link tab shows book summary:
    absolute **path**, **schemaVersion** from probe, and **account count** from
    `gnucashListAccounts(bookPath).length`. — verification: code inspection; QA
    screenshot with linked sqlite3 fixture.

15. **Re-link** control is always visible on the Link tab (even when currently linked),
    re-opening the picker flow from criterion 11. — verification: code inspection; QA
    screenshot.

16. Link-tab probe/list invokes show loading state while in flight and surface errors
    inline (not silent console-only). — verification: code inspection.

### Blocking state (re-link gate)

17. When persisted `bookPath` is non-null but the latest probe returns
    `missing`, `xml`, or `unknown-schema`, the page enters **blocking state**. —
    verification: code inspection; QA screenshot with moved/missing fixture path.

18. In blocking state, tabs **Account mapping**, **Import**, **Export**, and **Reconcile**
    render a clear blocking message explaining the book problem plus a **Re-link book**
    action (switches focus to Link tab or opens picker — implementer choice; must be
    obvious). Link book tab remains fully usable. — verification: code inspection; QA
    screenshot on each blocked tab.

19. Blocking state is scoped to `GnuCashPage` only — navigating to Dashboard, Import,
    Settings, etc. renders those pages normally (App shell unchanged). — verification:
    QA interaction: blocking on GnuCash page, other nav items still work.

20. When probe returns `ok`, blocking clears and non-Link tabs become fully functional. —
    verification: QA screenshot after successful re-link.

21. `unreadable` on a previously linked path shows guiding error on the Link tab; treat as
    blocking for other tabs (same gate as `missing`) since the book cannot be used. —
    verification: code inspection.

### Account mapping tab

22. When not blocked and book is linked, Mapping tab loads fin-app accounts and
    categories via `repos.accounts.list()` / `repos.categories.list()` and GnuCash accounts
    via `gnucashListAccounts(bookPath)`. — verification: code inspection.

23. UI lists fin-app **accounts** beside a GnuCash account tree filtered to eligible types
    `BANK`, `CASH`, `CREDIT`, `LIABILITY` (per `gnucash-mapping` eligibility). — verification:
    code inspection; QA screenshot.

24. UI lists fin-app **categories** beside GnuCash accounts filtered to `EXPENSE` type. —
    verification: code inspection; QA screenshot.

25. Mapping tab calls `suggestAccountMappings` / `suggestCategoryMappings` and displays
    each suggestion with its **reason** string; suggestions are **not** auto-applied. —
    verification: code inspection.

26. User can **apply** a suggestion explicitly (calls `applyAccountMapping` or
    `applyCategoryMapping`), **edit** an existing mapping (apply a different GUID), and
    **clear** a mapping (`clearMapping`). — verification: code inspection; QA interaction.

27. `mappingStatus` drives visible **unmapped** warnings for fin accounts, categories,
    and GnuCash accounts still without pairings. — verification: code inspection; QA
    screenshot with deliberate gaps.

28. When apply throws `GnucashMappingConflictError`, the page shows the error message
    inline near the mapping action (not an unhandled exception). — verification: code
    inspection; QA or task-08 test hook.

29. Mapping load/apply/clear invokes show loading/error states. — verification: code
    inspection.

### Import tab

30. Import tab renders a GnuCash **account tree with checkboxes** for selectable import
    accounts (non-placeholder eligible account types). Selection initializes from
    `loadGnucashBookState().importAccountGuids` and persists on change via
    `updateGnucashBookState({ importAccountGuids })`. — verification: code inspection;
    QA screenshot; reload preserves selection.

31. Import tab provides a **date window** (`from` / `to` ISO dates) controlling
    `gnucashListTransactions(bookPath, accountGuids, from, to)`. — verification: code
    inspection.

32. A **Plan import** (or equivalent) action loads transactions, then calls
    `planGnucashImport(repos, list, { accountGuids })` and renders the returned plan in
    review mode mirroring `ImportPage`'s staged review pattern (wizard or panel flow). —
    verification: code inspection; QA screenshot.

33. Review UI shows **all** plan buckets — nothing hidden:
    - **new** rows (committable when approved),
    - **updated** rows with field **diffs** (`GnucashImportFieldDiff[]`),
    - **merge-candidate** rows,
    - **unmappable** rows with **reason**,
    - **unreadable** rows from reader errors (`plan.unreadable`, sourced from
      `GnucashTransactionList.errors`) each showing **txn GUID + reason**, never committable.
    — verification: code inspection; QA screenshot with fixture data covering multiple
    buckets.

34. **Updated** and **merge-candidate** rows expose per-row **approve** / **reject**
    (or equivalent explicit toggles); default is not committed. — verification: code
    inspection.

35. For **new** rows whose plan includes `payeeCreateSuggestion`, the UI requires explicit
    **payee confirmation** (select existing payee or confirm creation path) before commit;
    `commitGnucashImport` receives `confirmedPayeeIds` keyed by `txn_guid`. No silent
    payee auto-create. — verification: code inspection; QA screenshot.

36. Commit action calls `commitGnucashImport(db, repos, approval)` with approved GUID
    arrays and required context (`list`, `options`, confirmed payee ids). Commit button
    disabled while committing; loading/progress state shown. — verification: code
    inspection.

37. On commit success, UI shows `GnucashImportResult` counts: **inserted**, **merged**,
    **skipped**, plus **unreadable** count from the plan (reader errors are not in result
    object but must be reported separately). — verification: code inspection; QA screenshot.

38. **KNOWN PITFALL — zero-count success**: `GnucashImportResult` has **no** `updated`
    field; approved field updates increment `skipped` (or apply without incrementing
    `inserted`/`merged`). The success message **must not** treat
    `{ inserted: 0, merged: 0, skipped: 0 }` as "nothing happened" when the user approved
    one or more **updated** rows — surface explicit confirmation that updates were applied
    (e.g. "N payment(s) updated" derived from approved update GUID count, separate from
    result counters). — verification: code inspection of success handler; QA scenario with
    only approved updates.

39. After successful commit, `updateGnucashBookState({ lastImportAt: <ISO now> })` when
    appropriate. — verification: code inspection.

40. Unreadable / unmappable rows cannot be included in approval arrays from the UI (no
    commit checkbox). — verification: code inspection.

41. Import plan/list/commit invokes show loading and inline error states. — verification:
    code inspection.

### Export tab

42. Export tab provides a **date window** (`fromDate` / `toDate`) passed to
    `listExportablePayments(db, filters)`. — verification: code inspection.

43. Payment list excludes previously exported payments by default
    (`includeExported: false`); a toggle sets `includeExported: true` to show them. —
    verification: code inspection; QA screenshot.

44. User selects export **format** `qif` or `csv`. — verification: code inspection.

45. Before export, UI calls `validateForExport(payments, accounts, categories)` and renders
    **mapping blockers** (`ExportBlocker` payment id + reason); export action disabled or
    blocked while blockers exist (user must fix mappings first). — verification: code
    inspection; QA screenshot with deliberate blocker.

46. Export save flow mirrors Reports CSV pattern: `@tauri-apps/plugin-dialog` `save` for
    path selection, then write file content via `exportReportCsv(path, content)` from
    `../report-csv`, where `content` is `buildQif(...)` or `buildCsv(...)` from core with
    the assembled `ExportBuildInput`. — verification: read export handler; code inspection.

47. After successful write, `recordExport(db, paymentIds, format)` persists export history
    for the selected payments. — verification: code inspection.

48. Export list/build/write invokes show loading/error states (including write failures
    from `exportReportCsv`). — verification: code inspection.

### Reconcile tab

49. Reconcile tab provides: fin-app **account** selector (mapped accounts with
    `gnucash_guid`), **date window**, and **tolerance** control defaulting to **±3 days**
    (`toleranceDays: 3`). — verification: code inspection; QA screenshot.

50. Run action loads GnuCash transactions for the mapped account GUID and fin-app payments
    for the account/date window, then calls `reconcile(db, payments, list, { toleranceDays
    })`. — verification: code inspection.

51. Results render **three buckets**: matched pairs, fin-app-only payments, GnuCash-only
    transactions — mirroring `ReconcileResult.matched`, `.finAppOnly`, `.gnucashOnly`. —
    verification: code inspection; QA screenshot.

52. A **per-account summary** line (via `summarize(result)`) shows counts and cent totals
    for matched / fin-app-only / GnuCash-only for the selected account. Amounts use
    `formatCentsDecimal`. — verification: code inspection; QA screenshot.

53. Matched and GnuCash-only rows expose **manual unmatch** (`setManualUnmatch`); fin-app-only
    and GnuCash-only rows expose **manual match** (`setManualMatch`) when user selects a
    pairing. Overrides persist via core reconcile module (survive re-run). — verification:
    code inspection; QA interaction.

54. `ReconcileResult.readerErrors` (pass-through of `list.errors`) renders as a **separate
    notice strip** outside the three match buckets, each entry showing **GUID + reason**. —
    verification: code inspection; QA screenshot when reader errors present.

55. Reconcile load/run/match invokes show loading/error states. — verification: code
    inspection.

### Cross-cutting loading, errors, and verification commands

56. Every `gnucash-book.ts` invoke (`gnucashProbeBook`, `gnucashListAccounts`,
    `gnucashListTransactions`) and every async core call used by the page has a visible
    loading indicator and try/catch (or equivalent) with user-readable error text. —
    verification: code inspection.

57. `npm run typecheck` exits 0. — verification: command output.

58. `npm run lint` exits 0. — verification: command output.

59. QA gate (post-implementation, pre-ship): screenshots per `tauri-qa-testing` for link
    (ok + xml guidance), blocking state, mapping with suggestions, import review buckets,
    export with blocker + successful save, reconcile three-bucket view — all against the
    sqlite3 fixture book. — verification: screenshot evidence at QA gate (not task 07 CI).

60. Task 08 owns `tests/gnucash-page.test.tsx`; this task does not add or modify test
    files. — verification: `git diff` excludes `tests/**`.

## verification_environment

library (`npm run typecheck`, `npm run lint`) + browser evidence at QA gate (`tauri-qa-testing`
screenshots). Automated page tests land in task 08 (`npx vitest run tests/gnucash-page.test.tsx`).

## out_of_scope

- Core module changes (`src/core/**`, including `index.ts` export list).
- Rust reader / Tauri command changes (`src-tauri/**`).
- `src/gnucash-book.ts` changes (read-only consumer).
- Test files (`tests/gnucash-page.test.tsx` and all other tests — task 08).
- New CSS files or App-wide layout/nav restructuring beyond the GnuCash route swap.
- Auto-sync, background import, or GnuCash book writes.

## pins (evaluator round 1 — orchestrator rulings)

1. **Database prop (criterion 5)** — APPROVED. `src/book.ts` `openBook` returns only `Promise<Repositories>` and drops the `Database` handle. App may inline `openRustSqliteDatabase` + `createRepositories` (replacing `openBook()` at both the session-open and first-run sites) **inside `App.tsx` only** so one adapter instance is retained and passed as `db` to `GnuCashPage`. Do **not** modify `src/book.ts`. Do **not** dual-open (`openBook` plus a second `openRustSqliteDatabase`) — two JS adapters would have two client queues on the one Rust session connection. `tests/app-shell.test.tsx` currently mocks `../src/book` `openBook`; this task must **not** edit that file (criterion 60). Typecheck+lint are this task's commands; the app-shell mock update is out of fence (task 08 / orchestrator).
2. **`unreadable` probe also blocks** non-Link tabs — APPROVED (same gate as `missing`). Criterion 21 is law; criterion 17's status list is incomplete without it.
3. **Re-link UX** (tab-switch vs direct picker) — implementer freedom; the control must be obvious (criterion 18).
4. **"N updated" success-copy wording** — implementer freedom. Substance of criterion 38 is mandatory: `GnucashImportResult` is **only** `{ inserted, merged, skipped }` (no `updated` field). Successful approved updates currently increment none of those counters, so `{0,0,0}` after approved updates must **not** render as "nothing happened" — surface an explicit update confirmation from the approved-update GUID count.
5. **Export write path** — APPROVED WITH EVIDENCE. `src-tauri/src/report_csv.rs` `export_report_csv` → `write_csv_file` → `fs::write(path, content.as_bytes())` with no CSV validation. QIF and CSV strings may be saved through existing `exportReportCsv` + dialog `save`, mirroring Reports. No new Rust command. Assemble the full frozen `ExportBuildInput` (`payments`, `accounts`, `categories`, `gnucashAccounts` from `gnucashListAccounts`, `payees` from `repos.payees.list()`).
6. **Unreadable import rows** — `GnucashImportPlanUnreadableRow` is `{ error: GnucashTransactionError }`. Render `error.txn_guid` + `error.reason` (not top-level `txnGuid`). Reconcile `readerErrors` is a bare `GnucashTransactionError[]`.
7. **Payee confirmation** — `commitGnucashImport` does **not** insert payees. For `payeeCreateSuggestion` rows, UI must `repos.payees.insert` after explicit confirm (or bind an existing payee id), then pass numeric ids in `confirmedPayeeIds` keyed by plan `txnGuid`. No silent auto-create.
8. **Unlinked book** (`bookPath === null`) — non-Link tabs must not call reader invokes; show a link-first empty/blocking state (goal success criterion includes unlinked). Same chrome as the re-link gate is acceptable.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T16:30:00-04:00
    note: Achievable within src/pages/GnuCashPage.tsx + src/App.tsx; App must retain/pass Database alongside repos (openRustSqliteDatabase is single-session).
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T17:10:00-04:00
    note: Counter-signed round 1. Eight pins (orchestrator rulings 1–5 plus unreadable-row shape, payee insert-then-id, unlinked gate). Real GnucashImportResult is inserted/merged/skipped only. No revision.
revision: 0
```
