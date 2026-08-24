# Task 06: reconcile-core

## Objective

The reconciliation engine in core: for an account and date window, classify fin-app
payments vs GnuCash transactions into matched pairs, fin-app-only, and GnuCash-only,
honoring persisted manual match/unmatch overrides from `gnucash_matches`, with
per-account summary totals.

## Dependencies

- 01-contract-schema (frozen types, skeletons, `gnucash_matches` table)

```yaml
# --- task ownership contract ---
writes:
  - src/core/gnucash-reconcile.ts   # fill the task-01 skeleton
  - tests/core/gnucash-reconcile.test.ts
reads:
  - src/core/gnucash-types.ts
  - src/core/repositories/payments.ts
  - src-tauri/migrations/0008_gnucash_integration.sql
depends_on:
  - "01-contract-schema"
owner: implementer
rewrite_semantics: whole-file
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `reconcile(db, payments, list, options)` (frozen signature — `list` is the
      `GnucashTransactionList`; its `errors` entries never participate in matching
      but are carried through on the result for display, never dropped) classifies
      `list.transactions`:
      - **matched**: manual `gnucash_matches` rows with `status='matched'` first
        (always win), then auto-matching — same mapped account, same `amount_cents`,
        post_date within `±toleranceDays` (default 3). Payments imported from GnuCash
        (`external_ref` = txn GUID) are trivially matched to their own transaction.
      - **fin-app-only**: payments with no counterpart → labeled as QIF/CSV export
        candidates.
      - **gnucash-only**: GnuCash transactions with no counterpart.
      - A manual `status='unmatched'` row vetoes the auto-match for that exact
        payment/txn pair, and the pair falls into the two unmatched buckets.
- [ ] Matching is one-to-one and deterministic: each payment matches at most one
      transaction and vice versa; ambiguous candidates resolve to the closest date,
      then lowest txn GUID; amount discrepancies never match (they surface as the two
      one-sided buckets).
- [ ] `setManualMatch(db, paymentId, txnGuid)` / `setManualUnmatch(...)` /
      `clearOverride(...)` persist to `gnucash_matches` (upsert on the UNIQUE pair);
      overrides survive re-imports because they key on payment id + txn GUID, not on
      recomputed state.
- [ ] `summarize(result)` returns per-account counts and integer-cent totals for the
      three buckets.
- [ ] Test-first (`tdd` skill): `tests/core/gnucash-reconcile.test.ts` covers seeded
      scenarios — missing on each side, amount discrepancy, date tolerance boundary
      (exactly ±3 days matches, ±4 does not), manual match persisting across a
      re-import cycle, manual unmatch veto, ambiguity determinism, and summary totals.

## Files to Read

- `src/core/README.md` — conventions
- `_goals/gnucash-read-export/goal.md` — discovery decisions
- `src/core/repositories/payments.ts` — query surface

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: integer cents; pure classification logic over passed-in data with DB access
  only for `gnucash_matches` persistence.
- Must NOT: modify repositories, import module, or UI; no invoke calls; no floats.

## Verification

- Targeted test command: `npx vitest run tests/core/gnucash-reconcile.test.ts`
