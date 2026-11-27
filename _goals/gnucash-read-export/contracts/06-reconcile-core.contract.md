# Contract: 06-reconcile-core

<!-- Instance naming: _goals/[goal]/contracts/NN-task-name.contract.md — one contract
     file per task, filed in a `contracts/` subdirectory of the goal, named after the
     task file it expands (e.g. `_goals/checkout-v2/contracts/03-payment-webhook.contract.md`).
     Created during the Phase 4 contract gate, before implementation dispatch — see
     `feature/SKILL.md` Phase 4. The contract is the testable expansion of the task
     file, never a second source of scope. -->

## task_id

06-reconcile-core

## done_definition

The task-01 skeleton in `src/core/gnucash-reconcile.ts` is fully implemented with the exact
frozen exported signatures and supporting types (`ReconcileOptions`, `ReconcileMatchedPair`,
`ReconcileResult`, `ReconcileSummary`). `reconcile` classifies caller-supplied payments against
`list.transactions` into matched pairs, fin-app-only, and GnuCash-only buckets, honoring
persisted `gnucash_matches` overrides (read via embedded module-level SQL — precedent:
`import-review.ts`) and applying deterministic one-to-one auto-matching with default ±3-day
post-date tolerance. Reader errors from `list.errors` are copied to `ReconcileResult.readerErrors`
unchanged — never matched, never dropped. `setManualMatch`, `setManualUnmatch`, and
`clearOverride` upsert or delete rows on the `UNIQUE (payment_id, txn_guid)` key so overrides
survive re-imports. `summarize` returns per-account counts and integer-cent totals for all three
buckets. Test-first `tests/core/gnucash-reconcile.test.ts` covers every seeded scenario listed
in the task file using `openTestDb()` from `tests/support/test-db.ts`. `npx vitest run
tests/core/gnucash-reconcile.test.ts` and `npm run typecheck` pass. No UI, Rust, repository,
or `index.ts` edits.

## acceptance_criteria

### Write fence and frozen signatures

1. Only these files are created or modified: `src/core/gnucash-reconcile.ts`,
   `tests/core/gnucash-reconcile.test.ts`. — verification: `git diff --name-only` against
   task baseline.

2. `src/core/gnucash-reconcile.ts` retains the exact exported signatures frozen in task 01
   (parameter types and return types unchanged):
   - `export interface ReconcileOptions { toleranceDays?: number }`
   - `export interface ReconcileMatchedPair { payment: Payment; transaction: GnucashTransaction }`
   - `export interface ReconcileResult { matched: ReconcileMatchedPair[]; finAppOnly: Payment[]; gnucashOnly: GnucashTransaction[]; readerErrors: GnucashTransactionError[] }`
   - `export interface ReconcileSummary { accountId: number; matchedCount: number; finAppOnlyCount: number; gnucashOnlyCount: number; matchedTotalCents: number; finAppOnlyTotalCents: number; gnucashOnlyTotalCents: number }`
   - `export async function reconcile(db: Database, payments: Payment[], list: GnucashTransactionList, options: ReconcileOptions): Promise<ReconcileResult>`
   - `export async function setManualMatch(db: Database, paymentId: number, txnGuid: string): Promise<void>`
   - `export async function setManualUnmatch(db: Database, paymentId: number, txnGuid: string): Promise<void>`
   - `export async function clearOverride(db: Database, paymentId: number, txnGuid: string): Promise<void>`
   - `export function summarize(result: ReconcileResult): ReconcileSummary[]`
   — verification: read exported declarations in `src/core/gnucash-reconcile.ts`; `npm run typecheck`.

3. `src/core/gnucash-reconcile.ts` has no imports from `@tauri-apps/*`, `invoke`, or UI
   modules. — verification: read import block.

4. No edits to `src/core/index.ts`, any file under `src/core/repositories/`, any UI file
   (`src/**/*.tsx`), or Rust sources (`src-tauri/**`). — verification: `git diff --name-only`
   path filter.

5. No float money anywhere in new code; all cent arithmetic uses integers. — verification:
   read new files; grep for monetary `number` operations excludes float literals on money paths.

### `reconcile` — inputs, scope, and reader errors

6. `reconcile` reads `gnucash_matches` from `db` (SELECT for overrides) and may INSERT/UPDATE/
   DELETE only through the dedicated persistence helpers (`setManualMatch`, `setManualUnmatch`,
   `clearOverride`) — not during classification. — verification: read `reconcile` body; no
   writes inside `reconcile`.

7. `list.errors` entries never participate in matching (not placed in `matched`, `finAppOnly`, or
   `gnucashOnly`). — verification: unit test passes non-empty `list.errors` alongside payments
   and transactions; result buckets contain only payments/transactions; errors absent from all
   three.

8. `result.readerErrors` is a copy of `list.errors` with the same length and element-wise equal
   fields (`txn_guid`, `post_date`, `description`, `reason`) — order preserved, nothing dropped
   or added. — verification: unit test asserts deep equality (or field-wise equality) between
   input errors and `result.readerErrors`.

9. When `options.toleranceDays` is omitted, auto-matching uses a default of `3` calendar days. —
   verification: unit test omits `toleranceDays` and asserts a payment/trans pair exactly 3 days
   apart matches; pair 4 days apart does not (see criteria 26–27).

10. Reconciliation scope assumption for tests and auto-match: caller supplies payments for one
    fin-app account and transactions whose relevant split `account_guid` is that account's mapped
    GnuCash GUID (single-account reconcile, matching the UI's account + date window selector).
    Auto-match amount rule: `payment.amount_cents === Math.abs(relevantSplit.value_cents)` where
    `relevantSplit` is the split whose `account_guid` equals the reconciled account's
    `gnucash_guid` (integer `Math.abs` only — never float). — verification: unit tests seed one
    fin account with `gnucash_guid`, payments on that `account_id`, and a **two-split** txn
    (funding split `value_cents = -4858` on the reconciled account, expense split
    `value_cents = 4858` on another account) with payment `amount_cents = 4858` → auto-match;
    same txn with payment `amount_cents = 4859` → no auto-match.

### `reconcile` — classification buckets

11. **fin-app-only**: a payment with no matched counterpart appears in `result.finAppOnly` exactly
    once. — verification: unit test with one payment and empty `list.transactions` yields one
    fin-app-only entry (same `payment.id`).

12. **gnucash-only**: a GnuCash transaction with no matched counterpart appears in
    `result.gnucashOnly` exactly once. — verification: unit test with one txn and empty
    `payments` yields one gnucash-only entry (same `txn_guid`).

13. **matched**: a successful pair appears once in `result.matched` as
    `{ payment, transaction }` with both entities referentially equal to the inputs (same ids /
    guids). — verification: unit test asserts matched pair shape and identity fields.

14. Every input payment appears in exactly one of `matched` (as half of a pair) or `finAppOnly`. —
    verification: unit test counts payment ids across buckets; union equals input set, intersection
    empty.

15. Every input transaction in `list.transactions` appears in exactly one of `matched` (as half of
    a pair) or `gnucashOnly`. — verification: unit test counts txn guids across buckets; union
    equals input set, intersection empty.

### `reconcile` — manual overrides (`gnucash_matches`)

16. Rows in `gnucash_matches` with `status = 'matched'` are applied before auto-matching and
    always win: the `(payment_id, txn_guid)` pair is placed in `matched` even when amount or date
    would fail auto-match criteria. — verification: unit test seeds DB row
    `status='matched'` for a payment/txn with amount mismatch; `reconcile` returns them in
    `matched`.

17. `setManualMatch(db, paymentId, txnGuid)` upserts `gnucash_matches` with
    `status = 'matched'` on the `UNIQUE (payment_id, txn_guid)` pair (insert when absent, update
    status when present). — verification: in-memory DB test calls `setManualMatch` twice for the
    same pair; one row exists with `status='matched'`; criterion 16 holds on subsequent
    `reconcile`.

18. `setManualUnmatch(db, paymentId, txnGuid)` upserts `status = 'unmatched'` on the same unique
    pair. — verification: in-memory DB test inserts/updates row; `SELECT status` returns
    `'unmatched'`.

19. A manual `status = 'unmatched'` row vetoes that exact `(payment_id, txn_guid)` pair on **every
    matching path** — trivial `external_ref` identity match and auto-match alike. Even when
    `payment.external_ref === txn.txn_guid` or amount/date satisfy auto-match rules, the vetoed
    pair is not in `matched`; the payment is in `finAppOnly` and the transaction in
    `gnucashOnly` (unless either is matched to a **different** counterpart via manual match,
    trivial ref to a different txn, or auto-match to a different partner). — verification: unit
    test seeds `unmatched` override for a pair that would otherwise auto-match; assert pair split
    across the two one-sided buckets; second unit test with `payment.external_ref === txn.txn_guid`
    and `status='unmatched'` on that pair — still not matched (trivial ref blocked).

20. `clearOverride(db, paymentId, txnGuid)` removes the `gnucash_matches` row for that pair. —
    verification: in-memory DB test set then clear; `SELECT` returns no row; subsequent
    `reconcile` no longer honors the prior override.

21. Manual match overrides survive a simulated re-import cycle: after `setManualMatch`, when the
    same `payment_id` and `txn_guid` still exist post–re-import (payment row unchanged id via
    `external_ref` dedup semantics), a later `reconcile` still classifies the pair as `matched`
    without re-calling `setManualMatch`. — verification: unit test persists override, re-runs
    `reconcile` with the same payment/txn fixtures; still matched.

### `reconcile` — trivial GnuCash-import identity match

22. A payment with `external_ref` equal to a transaction's `txn_guid` is trivially matched to that
    transaction (identity link from GnuCash import), independent of date tolerance and independent
    of amount equality checks used for auto-match. — verification: unit test with
    `payment.external_ref === txn.txn_guid`, amount mismatch and/or date beyond tolerance; pair
    appears in `matched`.

23. Trivial ref matches respect one-to-one constraints: a payment or transaction already matched
    (manually, trivially, or via auto-match) is not matched again to a second partner. —
    verification: unit test with two txns sharing ref ambiguity or two payments pointing at one
    txn; at most one matched pair per payment and per txn.

### `reconcile` — auto-match rules

24. Auto-match (after manual matched and trivial ref passes) pairs a payment and transaction only
    when: (a) the payment's fin-app account is the reconciled account under test, (b) the txn has
    a split on that account's `gnucash_guid`, (c)
    `payment.amount_cents === Math.abs(relevantSplit.value_cents)` on that reconciled-account
    split (integer `Math.abs` only), and (d) absolute calendar-day difference between
    `payment.date` and `transaction.post_date` is ≤ `toleranceDays`. — verification: unit test
    with all four conditions met yields `matched` using the two-split fixture from criterion 10;
    removing any one condition yields one-sided buckets (unless another match path applies).

25. **Amount discrepancy never auto-matches**: when
    `payment.amount_cents !== Math.abs(relevantSplit.value_cents)` on the reconciled-account
    split, the pair is not auto-matched; payment surfaces in `finAppOnly` and txn in
    `gnucashOnly` (unless manual match or trivial ref applies). — verification: dedicated unit
    test with the two-split fixture (funding `-4858`, expense `+4858`), equal dates and mapped
    account, payment `amount_cents = 4859` → one-sided buckets.

26. **Date tolerance boundary — inclusive at ±3 default**: with default tolerance (`3` or omitted
    `toleranceDays`), a pair whose dates are exactly 3 calendar days apart is auto-matched when
    amount and account mapping match. — verification: unit test `payment.date = '2024-01-01'`,
    `txn.post_date = '2024-01-04'` (and symmetric `'2023-12-29'`) → `matched`.

27. **Date tolerance boundary — exclusive at ±4**: with default tolerance, a pair 4 calendar days
    apart is not auto-matched. — verification: unit test `payment.date = '2024-01-01'`,
    `txn.post_date = '2024-01-05'` → not in `matched`; payment in `finAppOnly`, txn in
    `gnucashOnly`.

28. Custom `options.toleranceDays` is honored: e.g. `toleranceDays: 0` requires same post date;
    `toleranceDays: 7` allows 7-day gap. — verification: unit test varies option and asserts
    match/no-match at boundary for the configured value.

### `reconcile` — one-to-one deterministic matching

29. Each payment appears in at most one matched pair. — verification: unit test with multiple
    candidate txns; count matched pairs per `payment.id` ≤ 1.

30. Each transaction appears in at most one matched pair. — verification: unit test with multiple
    candidate payments; count matched pairs per `txn_guid` ≤ 1.

31. When multiple auto-match candidates exist for one payment, the winner is deterministic:
    minimize absolute calendar-day distance between `payment.date` and `post_date`; break ties by
    lexicographically lowest `txn_guid`. — verification: ambiguity unit test with two txns same
    amount and equal date distance; lower `txn_guid` wins; repeated `reconcile` calls yield
    identical pairing.

32. When multiple payments compete for one transaction, the winner is deterministic: closest
    `payment.date` to `transaction.post_date`, then lowest `payment.id`. — verification: unit
    test mirrors criterion 31 with two payments one txn; equal date distance → lower
    `payment.id` wins; repeated `reconcile` calls yield identical pairing.

33. After a payment or txn is matched (any path), it is removed from the pool for subsequent
    auto-match rounds in the same `reconcile` invocation. — verification: unit test with three
    equal candidates; only one pair matched, others one-sided.

### `summarize`

34. `summarize(result)` returns `ReconcileSummary[]` with one entry per distinct fin-app
    `accountId` present among payments in `result.matched` and/or `result.finAppOnly`. —
    verification: unit test with payments on account id `A` only → one summary row with
    `accountId === A`.

35. `matchedCount` / `finAppOnlyCount` / `gnucashOnlyCount` equal the number of items attributed
    to that account in each bucket. For single-account reconcile fixtures, `gnucashOnlyCount`
    equals `result.gnucashOnly.length`. — verification: unit test asserts counts against bucket
    lengths.

36. `matchedTotalCents` is the sum of `payment.amount_cents` for matched pairs attributed to the
    account; `finAppOnlyTotalCents` sums `payment.amount_cents` for fin-app-only payments on that
    account; `gnucashOnlyTotalCents` sums `Math.abs(relevantSplit.value_cents)` for gnucash-only
    txns (using the reconciled-account split, same magnitude rule as auto-match) so totals are
    comparable to payment-side sums. — verification: unit test with known cent values across
    buckets including a two-split gnucash-only txn (funding `-4858`); assert
    `gnucashOnlyTotalCents === 4858` and exact integer sums (no floats).

37. `summarize` is pure: no `db`, repository, or invoke usage. — verification: read function body;
    unit test calls without DB.

### Persistence and SQL

38. Module embeds SQL strings for `gnucash_matches` read/write (precedent: `import-review.ts`);
    no repository imports. — verification: read `src/core/gnucash-reconcile.ts`; grep confirms
    SQL targets `gnucash_matches` only.

39. Upsert semantics respect `UNIQUE (payment_id, txn_guid)` from migration 0008: duplicate insert
    becomes update of `status`. — verification: in-memory DB test alternates
    `setManualMatch` / `setManualUnmatch` on same pair; exactly one row remains.

40. `clearOverride` on a nonexistent pair is a no-op (does not throw). — verification: unit test
    calls `clearOverride` with no prior row; passes.

### Test-first and verification commands

41. `tests/core/gnucash-reconcile.test.ts` exists and was authored test-first, covering at
    minimum: fin-app-only (criterion 11), gnucash-only (12), amount discrepancy (25), date
    tolerance ±3 inclusive / ±4 exclusive (26–27), manual match persistence across re-import
    (21), manual unmatch veto (19), ambiguity determinism (31), summary totals (36), reader
    errors passthrough (7–8), trivial `external_ref` match (22), manual matched wins (16). —
    verification: read test `describe`/`it` blocks; `npx vitest run tests/core/gnucash-reconcile.test.ts`
    exits 0.

42. Tests use `openTestDb()` from `tests/support/test-db.ts` with migration 0008 applied — no
    Tauri runtime, no real GnuCash book. — verification: read test imports and setup.

43. Tests seed payments via existing repository helpers or direct SQL on the in-memory adapter
    (consistent with other core tests); no live external services. — verification: read test
    setup.

44. `npm run typecheck` exits 0. — verification: command output.

## verification_environment

library (vitest)

## out_of_scope

- GnuCash page UI and reconcile tab wiring (task 07).
- Rust reader and `gnucash_list_transactions` (task 02).
- Other core modules (`gnucash-mapping.ts`, `gnucash-import.ts`, `gnucash-export.ts`,
  `gnucash-types.ts`).
- `src/core/index.ts` export changes (frozen in task 01).
- Repository implementation changes (`src/core/repositories/**`).
- End-to-end IPC or fixture-book integration tests (task 08).
- Modifying import or export behavior to support reconcile (callers pass pre-filtered inputs).

## Pins (orchestrator rulings — fold into criteria on revision)

1. **Single-account scope.** Caller pre-filters payments to one fin-app account and transactions to that account’s mapped GnuCash GUID. APPROVED (matches the UI per-account reconcile tab).
2. **Txn-side amount + split selection.** Txn-side amount is the split `value_cents` whose `account_guid` equals the reconciled account’s `gnucash_guid`. The reader returns ALL splits; reconcile selects that split. Signs follow the import convention: funding split negative, expense split positive. Payments store **positive** `amount_cents` (`payment-entry.ts` rejects `<= 0`). **Do not use signed equality.** Comparison rule (required): `payment.amount_cents === Math.abs(relevantSplit.value_cents)` with integer `Math.abs` only — never float. Tests must use a two-split txn (funding negative, expense positive) so the wrong split cannot accidentally satisfy equality.
3. **Tiered matching.** Order: manual `status='matched'` (always wins) → trivial `external_ref === txn_guid` (bypasses amount/date) → auto-match (amount + date). “Discrepancies never match” applies to **auto-match only**. APPROVED.
4. **Payment-side ambiguity.** Closest date, then **lowest payment id**. No alternate tie-break. APPROVED.
5. **`summarize` account context.** Assumes at least one payment in `matched` and/or `finAppOnly` so GnuCash-only rows can inherit that `accountId`. GnuCash-only-only input is out of scope. APPROVED.

## Revision request (round 1 — one request)

Rewrite criteria **10, 19, 24, 25, 32, 36** (and the AC9 cross-ref) so they cannot diverge. Do **not** retarget the write fence or frozen names: live module is `src/core/gnucash-reconcile.ts` with `setManualMatch` / `setManualUnmatch` / `clearOverride` / `summarize` (task-file aliases are not law).

1. **Amount comparison (blocker).** Replace “exact integer equality of `payment.amount_cents` and split `value_cents`” in AC10/24/25 with **magnitude equality**: `payment.amount_cents === Math.abs(split.value_cents)` on the reconciled-account split. Verification must include a two-split fixture: funding `value_cents = -4858`, expense `value_cents = 4858`, payment `amount_cents = 4858` → auto-match; funding `-4858` vs payment `4859` → no auto-match. Keep trivial-ref and manual-matched as bypasses of this check.
2. **`gnucashOnlyTotalCents` (AC36).** Sum `Math.abs(relevantSplit.value_cents)` so GnuCash-only totals are comparable to payment `amount_cents` sums (do not add raw negative funding splits).
3. **Unmatched veto vs trivial ref (AC19).** A `status='unmatched'` row vetoes that **exact pair on every subsequent path**, including trivial `external_ref` identity — not auto-match only. Otherwise `setManualUnmatch` is a no-op for GnuCash-imported payments (`external_ref === txn_guid`). The pair may still match a *different* counterpart. Drop the reading that trivial ref rematches the vetoed pair.
4. **Payment-side tie-break (AC32).** Closest date, then **lowest `payment.id`**. Remove “or consistent payment-side tie-break”.
5. **AC9 cross-ref.** Date-tolerance default points at criteria **26–27**, not 22–23.

```yaml
# --- contract sign-off ---
signoff:
  worker:              # the task's owner agent (implementer|test-writer), proposing
    agreed: true
    timestamp: 2026-08-24T12:12:00-04:00
    note: Round-1 revisions applied — Math.abs magnitude rule, unmatched vetoes trivial ref, payment-side tie-break is lowest payment.id; still achievable in two-file fence.
  evaluator:           # evaluator, spawned in contract mode to review/counter-sign
    agreed: true
    timestamp: 2026-08-24T15:45:00-04:00
    note: Round-2 counter-sign — all five revision items present (abs magnitude AC10/24/25, abs gnucash-only totals AC36, unmatched vetoes trivial-ref AC19, lowest payment.id AC32, AC9→26–27); untouched criteria and frozen signatures unchanged.
revision: 1
```
