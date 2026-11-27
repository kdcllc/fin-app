# Contract: 04-import-core

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

04-import-core

## done_definition

`src/core/gnucash-import.ts` implements the task-01 skeleton with the exact frozen exported
function signatures and plan bucket shapes: `planGnucashImport` classifies every transaction
and reader error from a `GnucashTransactionList` into exactly one review bucket with zero
silent drops; payee resolution reuses `normalizePayeeLabel` from `payee-normalization.ts`
(exact/normalized match → existing payee; otherwise a create suggestion — never auto-create);
`commitGnucashImport` inserts only user-approved new rows as `source: "gnucash"` with
`external_ref = txn_guid`, applies approved merges (link manual payments) and approved updates,
and runs atomically via `db.batch()` / `repos.batch()` so one failing statement rolls back the
whole commit. Re-running plan+commit on the same input is a no-op. `tests/core/gnucash-import.test.ts`
(test-first) exercises every bucket, payee rules, transactional rollback, dedup no-op, multi-split
unmappable, reader-error surfacing, and cent-exact edge amounts ($10,673.91 / $0.01) against the
in-memory migrated DB. `npx vitest run tests/core/gnucash-import.test.ts` and `npm run typecheck`
pass. No UI, Rust, repository, `index.ts`, or sibling core-module edits.

## acceptance_criteria

### Write fence and frozen exported signatures (LAW)

1. Only these files are created or modified: `src/core/gnucash-import.ts`,
   `tests/core/gnucash-import.test.ts`. — verification: `git diff --name-only` against task
   baseline.

2. `src/core/gnucash-import.ts` retains the exact exported **function** signatures frozen in
   task 01 (parameter types and return types unchanged):
   - `export async function planGnucashImport(repos: Repositories, list: GnucashTransactionList, options: GnucashImportOptions): Promise<GnucashImportPlan>`
   - `export async function commitGnucashImport(db: Database, repos: Repositories, approved: GnucashImportApproval): Promise<GnucashImportResult>`
   — verification: read exported declarations; `npm run typecheck`.

3. `src/core/gnucash-import.ts` has no imports from `@tauri-apps/*` or other Tauri APIs. —
   verification: read import block.

4. The module does not modify `import-review.ts`, `payee-normalization.ts`, any repository
   file, or `src/core/index.ts`. — verification: `git diff` path filter excludes those paths.

5. Supporting types exported from `gnucash-import.ts` retain the task-01 **minimum** bucket
   shapes (additive fields and exact property names on row types are implementer freedom per
   task-01 criterion 34):
   - `GnucashImportPlan`: arrays `new`, `unchanged`, `updated`, `mergeCandidates`, `unmappable`,
     `unreadable`
   - `GnucashImportPlanNewRow`: at minimum `txnGuid: string`
   - `GnucashImportPlanUnchangedRow`: at minimum `txnGuid: string`, `paymentId: number`
   - `GnucashImportPlanUpdatedRow`: at minimum `txnGuid: string`, `paymentId: number`,
     `diffs: GnucashImportFieldDiff[]`
   - `GnucashImportFieldDiff`: at minimum `field: string`, `existing`, `incoming`
     (`string | number | null`)
   - `GnucashImportPlanMergeCandidateRow`: at minimum `txnGuid: string`, `paymentId: number`
   - `GnucashImportPlanUnmappableRow`: at minimum `txnGuid: string`, `reason: string`
   - `GnucashImportPlanUnreadableRow`: at minimum `error: GnucashTransactionError`
   - `GnucashImportApproval`: at minimum `approvedNewTxnGuids`, `approvedUpdateTxnGuids`,
     `approvedMergeTxnGuids` (each `string[]`)
   - `GnucashImportResult`: at minimum `inserted: number`, `merged: number`, `skipped: number`
   - `GnucashImportOptions`: at minimum `accountGuids?: string[]` (frozen from skeleton)
   — verification: read type definitions; `npm run typecheck`.

### `planGnucashImport` — partition invariant (zero silent drops)

6. Every element of `list.transactions` appears in **exactly one** of the plan buckets
   (`new`, `unchanged`, `updated`, `mergeCandidates`, `unmappable`) — never omitted, never
   duplicated across buckets. — verification: unit test builds a mixed `GnucashTransactionList`,
   calls `planGnucashImport`, and asserts the union of all bucket `txnGuid` values equals the
   input transaction GUID set with no duplicates.

7. Every element of `list.errors` appears in **exactly one** `plan.unreadable` entry (wrapped
   as `{ error: GnucashTransactionError }`) and in **no** transaction bucket. — verification:
   unit test supplies non-empty `errors`; asserts `unreadable.length === list.errors.length`,
   each error's `txn_guid` present once, and no transaction bucket references those GUIDs.

8. `list.transactions` and `list.errors` may share no GUID overlap in normal reader output; if
   overlap occurs, the transaction row wins the transaction bucket and the error is still listed
   in `unreadable` (both visible — nothing dropped). — verification: unit test with overlapping
   GUID documents dual surfacing; evaluator accepts either explicit dual-list or transaction-only
   if task test omits overlap fixture (overlap is defensive, not required fixture).

### `planGnucashImport` — **new** bucket

9. When no existing payment has `source = 'gnucash'` and `external_ref = txn_guid`, and the
   transaction is mappable (criteria 18–19), it lands in `plan.new`. — verification: unit test
   with empty gnucash payments table; txn appears in `new` with matching `txnGuid`.
   evaluator-note (pin): "mappable" means criteria 17–19 all pass (mapped funding GUID in
   `options.accountGuids` plus a fin-app account, and exactly one mapped expense-category split).
   Bucket precedence: unmappable (17–19) before merge (14) before new (9); GUID match (11–12)
   before merge (16).

10. Each `new` row carries the proposed payment fields needed for review/commit (additive fields
    on `GnucashImportPlanNewRow`): `date = post_date`, `amount_cents` from the mapped expense
    split's `value_cents` (positive outflow magnitude as stored in fin-app — same sign
    convention as manual payments in fixture tests), `memo` from transaction `description`,
    `accountId` from the fin-app account whose `gnucash_guid` matches the **funding** split
    (split on an account GUID in `options.accountGuids`), `categoryId` from the fin-app category
    whose `gnucash_guid` matches the single mapped **expense** split. — verification: unit test
    seeds account/category rows with `gnucash_guid`, builds a two-split txn (funding + expense),
    asserts `new[0]` field values.
    evaluator-note (pin): `amount_cents` equals the EXPENSE split's `value_cents` as returned
    (positive); do not take `Math.abs` of the funding split. Reader returns ALL signed splits
    (funding negative, expense positive) — plan finds the expense split among them, including
    splits whose `account_guid` is not in `options.accountGuids`. Tests must use that sign
    convention. Additive field names on the row (`date`, `amount_cents`, `memo`, `accountId`,
    `categoryId`, …) are implementer freedom.

### `planGnucashImport` — **unchanged** bucket

11. When a payment exists with `source = 'gnucash'`, `external_ref = txn_guid`, and the same
    `date`, `amount_cents`, and memo/description (memo compared to transaction `description`),
    the txn is in `plan.unchanged` with the existing `paymentId`. — verification: unit test
    pre-inserts matching gnucash payment; replan yields `unchanged` and empty `new`/`updated`.

### `planGnucashImport` — **updated** bucket

12. When a gnucash-linked payment exists (`source = 'gnucash'`, `external_ref = txn_guid`) but
    `date`, `amount_cents`, and/or memo/description differ, the txn is in `plan.updated` with
    `paymentId` and `diffs` listing each changed field (`field` name + `existing` + `incoming`). —
    verification: unit test varies each field independently; asserts `diffs` contains the
    expected entries and txn is not in `new` or `unchanged`.

13. Updated rows are never auto-applied — they require inclusion in
    `approved.approvedUpdateTxnGuids` at commit time. — verification: unit test commits without
    approving update; DB row unchanged; `updated` count semantics in result (criterion 29).
    evaluator-note (pin): `GnucashImportResult` has no `updated` field — unapproved updates
    increment `skipped` (criterion 31), not `merged` (criterion 29).

### `planGnucashImport` — **merge-candidate** bucket

14. When no gnucash GUID match exists, but a `source = 'manual'` payment shares the same
    `account_id` (mapped funding account), the same `amount_cents`, and a `date` within ±3
    calendar days of `post_date`, the txn is in `plan.mergeCandidates` with that manual payment's
    `paymentId`. — verification: unit test seeds manual payment at `post_date`, `post_date ± 1`,
    and `post_date ± 3` (pass) vs `post_date ± 4` (fail); asserts merge candidate only in-window.

15. Merge candidates are never auto-merged — commit only links when `txn_guid` is listed in
    `approved.approvedMergeTxnGuids`. — verification: unit test plans merge candidate, commits
    without approval; manual payment retains `source = 'manual'` and null/old `external_ref`.

16. When both a GUID match (unchanged/updated) and a manual merge candidate could apply, GUID
    match takes precedence (txn is `unchanged` or `updated`, not `mergeCandidates`). —
    verification: unit test with gnucash-linked payment plus overlapping manual payment; txn not
    in `mergeCandidates`.

### `planGnucashImport` — **unmappable** bucket

17. When the funding split's GnuCash account GUID is not in `options.accountGuids` or no fin-app
    account has that `gnucash_guid`, the txn is `unmappable` with a reason mentioning unmapped
    funding account. — verification: unit test.

18. When no fin-app category maps the expense split's `account_guid`, the txn is `unmappable`
    with a reason mentioning unmapped category/expense account. — verification: unit test.

19. When the transaction has **zero** mapped expense splits or **more than one** mapped expense
    split, the txn is `unmappable` with a reason identifying multi-expense ambiguity; for multiple
    expense splits, the reason **lists each** mapped expense split (at minimum:
    `account_guid` + `value_cents` per split). — verification: unit test with two expense splits
    on mapped categories; `reason` contains both splits' identifiers/amounts.

20. Unmappable rows are excluded from commit — approving their GUIDs (if present in approval
    arrays) has no effect. — verification: unit test attempts commit with unmappable GUID in
    approval; no payment inserted/updated.

### `planGnucashImport` — **unreadable** bucket

21. Each `list.errors` entry is copied into `plan.unreadable` preserving `txn_guid`, `post_date`,
    `description`, and `reason` (pass-through — no mutation of reader error text). — verification:
    unit test compares `unreadable[i].error` deep-equal to input `errors[i]`.

22. Unreadable entries are excluded from commit. — verification: unit test; payments count
    unchanged after commit approving only unreadable GUIDs (if any appear in approval — normally
    none).

### Payee resolution (reuse `payee-normalization.ts`)

23. Planning calls `normalizePayeeLabel(transaction.description)` from `payee-normalization.ts`
    (imported, not copied) to derive the payee label. — verification: read `gnucash-import.ts`
    imports; unit test with a description matching `normalizePayeeLabel` fixture behavior (e.g.
    `pay @ Vendor w/ 1234` → payee `Vendor`).

24. When the normalized payee matches an existing payee by **exact** name OR by
    case-insensitive trimmed name equality (same spirit as `import-review.ts` `keyOf`), the
    plan row references that payee's id (additive field on `new` / merge / update rows, e.g.
    `payeeId`). — verification: unit test with payee `"Power Co"` and description resolving to
    `"Power Co"`.

25. When no existing payee matches, the plan row carries a **create suggestion** (additive
    field, e.g. `payeeCreateSuggestion: string` with the normalized payee name) and **does not**
    assign a `payeeId`. — verification: unit test; no payee row created during `planGnucashImport`
    (`payees` table count unchanged).

26. Silent auto-create is forbidden: `commitGnucashImport` must not call `repos.payees.insert`
    (directly or indirectly). New-row commit requires a confirmed existing `payeeId` supplied
    via additive approval fields (e.g. `confirmedPayeeIds: Record<string, number>` keyed by
    `txn_guid`) or pre-created payee in test setup. — verification: unit test asserts payee
    count unchanged when committing a new row whose plan had only `payeeCreateSuggestion` and
    no confirmed id; separate test commits successfully after test inserts payee and supplies
    confirmed id.

### `commitGnucashImport` — inserts, merges, updates

27. Commit context: because the frozen function signature omits `list` / `plan`, additive fields
    on `GnucashImportApproval` MUST supply what commit needs — at minimum `list:
    GnucashTransactionList`, `options: GnucashImportOptions`, and per-new-txn confirmed payee ids
    when the plan suggested create. Commit throws a clear error if required context is missing. —
    verification: read types; unit test calling commit without `list` rejects/throws.
    evaluator-note (pin): additive `list` / `options` / confirmed-payee fields on
    `GnucashImportApproval` are APPROVED (frozen function signatures unchanged; additive fields
    allowed by task-01 contract criterion 34). Property names are implementer freedom.

28. Approved **new** rows (`txn_guid ∈ approved.approvedNewTxnGuids`) insert payments with
    `source: 'gnucash'`, `external_ref = txn_guid`, `source_sheet`/`source_row`/`source_col`/
    `occurrence_index` all `null`, and field values from the planned row. — verification: unit
    test; `repos.payments.get` round-trip matches expected cents/date/memo/FKs.

29. Approved **merge** rows update the matched manual payment: set `source = 'gnucash'`,
    `external_ref = txn_guid`; other fields unchanged unless also in `approvedUpdateTxnGuids`. —
    verification: unit test; manual payment id preserved; source/external_ref updated;
    `GnucashImportResult.merged` incremented.

30. Approved **update** rows patch only differing fields identified in `plan.updated` diffs
    (date, amount_cents, memo/description mapping). — verification: unit test approves one field
    change; DB reflects patch; non-approved fields unchanged.

31. Non-approved plan rows are skipped; `GnucashImportResult.skipped` counts plan rows not
    applied (new + update + merge eligible but not approved). — verification: unit test with
    partial approval; `inserted + merged + skipped` reconciles with plan bucket sizes.

### `commitGnucashImport` — transactional batch semantics

32. All commit statements run in a **single** `repos.batch()` (or `db.batch()`) call — one atomic
    transaction. — verification: unit test records `repos.batch` / test-db `calls` and asserts
    exactly one `batch` call for a multi-row commit.

33. When any statement in the batch fails, **no** payment rows from that commit are persisted
    (full rollback). — verification: unit test mirrors `import-review-commit.test.ts` pattern:
    inject a poison/failing statement after the first payment write inside the batch builder; assert
    payments count unchanged from pre-commit.

### Re-import no-op (dedup)

34. After a successful plan+commit cycle, running `planGnucashImport` again on the same
    `GnucashTransactionList` classifies all previously imported txns as `unchanged` (empty
    `new`, `updated`, `mergeCandidates`). — verification: unit test two consecutive plan calls.

35. A second `commitGnucashImport` with empty approval arrays (or approving nothing new) returns
    `inserted = 0`, `merged = 0`, and does not change the payments table. — verification: unit
    test counts before/after second commit.

### Cent-exact amounts

36. Amount `1067391` cents ($10,673.91) round-trips through plan and commit without off-by-one. —
    verification: unit test with expense split `value_cents: 1067391`; inserted payment
    `amount_cents === 1067391`.

37. Amount `1` cent ($0.01) round-trips through plan and commit without off-by-one. —
    verification: unit test with `value_cents: 1`; inserted payment `amount_cents === 1`.

38. No floating-point arithmetic on money anywhere in `gnucash-import.ts` (integer cents only). —
    verification: read implementation; grep for `Math.round` / `parseFloat` / `* 100` on amounts
    returns none (rationals are already cents at IPC boundary per `gnucash-types.ts`).

### Test harness and regression

39. File `tests/core/gnucash-import.test.ts` exists and uses `openTestDb()` from
    `tests/support/test-db.ts` (in-memory SQLite with real migrations). — verification: file
    inspection.

40. Test file covers **each** bucket with at least one dedicated example: `new`, `unchanged`,
    `updated`, `mergeCandidates`, `unmappable` (including multi-expense-split case), `unreadable`
    (reader errors). — verification: read test `describe`/`it` blocks; evaluator checklist.

41. Test file includes: payee match vs create-suggestion vs auto-create prohibition (criteria
    24–26), transactional rollback (criterion 33), re-import no-op (criteria 34–35), and cent
    edges (criteria 36–37). — verification: read test file.

42. `npx vitest run tests/core/gnucash-import.test.ts` exits 0. — verification: command output.

43. `npm run typecheck` exits 0. — verification: command output.

### SQL and repository composition

44. No edits to `src/core/repositories/payments.ts` or other repositories. Payment queries inside
    `gnucash-import.ts` use existing repo methods (`payments.list`, `payments.get`,
    `payments.insert`, `payments.update`) and/or module-level SQL via `db.select` / batch
    statements built for commit — allowed when repo methods lack `external_ref` / `source`
    filters (precedent: task-file constraint). — verification: `git diff` excludes repositories;
    read `gnucash-import.ts` for SQL only in owned module.
    evaluator-note (pin): `planGnucashImport` uses `repos.payments.list` with a date window
    derived from the input transactions (at least min `post_date`−3 … max `post_date`+3 calendar
    days so merge ±3 is visible) plus in-memory `external_ref` matching. Module-level SQL is
    allowed ONLY if repos genuinely cannot express a needed **commit-phase** query. `updated`
    date-diff tests must keep the existing payment `date` inside that list window.

45. `planGnucashImport` uses only `repos` (no `Database` param per frozen signature); it does not
    call `invoke`. — verification: read function signature and body imports.

## verification_environment

library (vitest)

## out_of_scope

- GnuCash page UI and invoke wiring (task 07 / `src/gnucash-book.ts` consumers).
- Rust reader (`gnucash_list_transactions`, task 02).
- Other core modules: `gnucash-mapping.ts`, `gnucash-export.ts`, `gnucash-reconcile.ts`,
  `gnucash-types.ts`, `import-review.ts`, `payee-normalization.ts`.
- Repository implementations (`src/core/repositories/**`).
- `src/core/index.ts` export list changes.
- Dedicated cross-module integration tests in task 08 (this task owns
  `tests/core/gnucash-import.test.ts` only).
- Auto-creating payees, auto-merging manual payments, or auto-applying field updates without
  explicit approval arrays.
- Modifying reader behavior or IPC payload shapes.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T13:15:00-04:00
    note: Achievable within src/core/gnucash-import.ts + tests/core/gnucash-import.test.ts; commit context via additive GnucashImportApproval fields and module-level SQL/batch where repos lack external_ref queries.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T14:20:00-04:00
    note: Counter-signed. Pins — (1) additive approval list/options/confirmed-payee APPROVED; (2) amount_cents = expense split value_cents (positive); reader returns ALL signed splits, plan finds expense among them; (3) GUID-overlap dual-surfacing allowed, no fixture required; (4) additive property names implementer freedom; (5) plan uses payments.list + in-memory external_ref match, module SQL only for commit-phase if repos cannot express the query. Also: unmappable precedes merge/new; unapproved updates increment skipped.
revision: 0
```
