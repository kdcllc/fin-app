# Task 04: import-core

## Objective

The GnuCash → payments import pipeline in core: turns reader output from mapped
accounts into a review-before-commit plan (mirroring the Excel importer's UX contract),
with GUID-based dedup, update detection, payee suggestions via the existing
normalization module, and cross-source merge suggestions against manual payments.

## Dependencies

- 01-contract-schema (frozen types and skeletons)

```yaml
# --- task ownership contract ---
writes:
  - src/core/gnucash-import.ts    # fill the task-01 skeleton
  - tests/core/gnucash-import.test.ts
reads:
  - src/core/gnucash-types.ts
  - src/core/import-review.ts
  - src/core/payee-normalization.ts
  - src/core/repositories/payments.ts
depends_on:
  - "01-contract-schema"
owner: implementer
rewrite_semantics: whole-file
eval_depth: full
```

## Requirements (exhaustive — the evaluator verifies every item)

- [ ] `planGnucashImport(repos, list, options)` takes the full
      `GnucashTransactionList` (frozen in task 01) and classifies every input —
      nothing is silently dropped (importer non-negotiable). Reader-side
      `errors` entries pass through into the plan's **unreadable** bucket (GUID +
      reason, excluded from commit, always visible in review). Buckets for
      `transactions`:
      - **new**: no existing payment with `source='gnucash'` and
        `external_ref = txn_guid` → proposed payment (account from the mapped funding
        split; category from the mapped EXPENSE split's account; date = post_date;
        `amount_cents` from the expense-split value; memo from description).
      - **unchanged**: existing payment with same GUID and same data → no-op.
      - **updated**: same GUID, different date/amount/description → flagged with a
        field-level diff for user decision; never auto-applied.
      - **merge-candidate**: no GUID match, but a `source='manual'` payment with the
        same account, same `amount_cents`, and date within ±3 days → offered as a
        merge (link the manual payment by setting its `external_ref`/`source`), never
        auto-merged.
      - **unmappable**: funding account or expense account unmapped, or a transaction
        without exactly one expense-side interpretation (multi-expense splits listed
        per split) → surfaced with a reason, excluded from commit.
- [ ] Payee resolution reuses `payee-normalization.ts` against the GnuCash description:
      exact/normalized match → that payee; otherwise a suggestion to create, requiring
      user confirmation (silent auto-create is forbidden).
- [ ] `commitGnucashImport(...)` inserts only user-approved rows as
      `source: "gnucash"`, `external_ref: txn_guid` (`NewNonXlsxPayment`), applies
      approved merges/updates, and is transactional via the `Database` seam's batch
      semantics — a failing row aborts the whole commit.
- [ ] Re-running plan+commit over the same input is a no-op (dedup proven by test).
- [ ] Test-first (`tdd` skill): `tests/core/gnucash-import.test.ts` covers every
      bucket (including reader `errors` surfacing as unreadable plan entries), the
      multi-split edge case, payee suggestion vs auto-create prohibition,
      transactional commit rollback, re-import no-op, and cent-exact amounts including
      $10,673.91 and $0.01.

## Files to Read

- `src/core/import-review.ts` — the review/commit pattern to mirror
- `src/core/repositories/payments.ts` — insert/query surface
- `src/core/README.md`, `CLAUDE.md` — non-negotiables
- `_goals/gnucash-read-export/goal.md` — discovery decisions

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: keep all SQL in repositories or this core module (module-level SQL only if the
  repositories lack the needed query — prefer extending nothing and composing existing
  methods); integer cents; ISO dates.
- Must NOT: modify `import-review.ts`, repositories, or `payee-normalization.ts`; no UI;
  no invoke calls; never auto-create payees or auto-merge.

## Verification

- Targeted test command: `npx vitest run tests/core/gnucash-import.test.ts`
