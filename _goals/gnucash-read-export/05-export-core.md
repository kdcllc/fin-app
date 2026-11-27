# Task 05: export-core

## Objective

The zero-risk reverse flow in core: build QIF and CSV file contents for selected
fin-app payments so GnuCash's import assistant (with its duplicate detection) can
consume them, track what was exported in `payment_exports`, and refuse to export
payments whose account or category mapping is missing.

## Dependencies

- 01-contract-schema (frozen types, skeletons, `payment_exports` table)

```yaml
# --- task ownership contract ---
writes:
  - src/core/gnucash-export.ts    # fill the task-01 skeleton
  - tests/core/gnucash-export.test.ts
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

- [ ] `listExportablePayments(db, filters)` returns payments in the date window that
      have NO `payment_exports` row by default; `includeExported: true` includes them
      (forced re-export). Each row carries its export history (formats + timestamps).
- [ ] `validateForExport(payments, accounts, categories)` (exact frozen signature —
      mapping state is read from the entities' `gnucash_guid` columns): every payment
      whose funding account or category lacks a `gnucash_guid` mapping is returned as
      a blocker with a reason; export builders accept only fully-mapped payments.
- [ ] `buildQif(input)` produces one QIF section per funding account: `!Account`
      header with the mapped GnuCash account's `full_path`; the `!Type:` line derives
      from the fin-app account `kind` — `checking` → `!Type:Bank`, `cash` →
      `!Type:Cash`, `credit` → `!Type:CCard` (never from the GnuCash account type, so
      LIABILITY-mapped credit accounts are unambiguous); one
      record per payment with `D` date (GnuCash-5.x-compatible `MM/DD/YYYY`), `T`
      amount (negative = money out, formatted from integer cents with exactly two
      decimals — string formatting, never float math), `P` payee name, `L` category as
      the mapped EXPENSE account `full_path` (e.g. `Expenses:Utilities:Electric`),
      `M` memo when present, `^` terminator.
- [ ] `buildCsv(...)` produces a GnuCash-CSV-importer-friendly table with a header row:
      `date,account,description,category,amount` — same signing and two-decimal
      formatting rules, RFC-4180 quoting for embedded commas/quotes.
- [ ] `recordExport(db, paymentIds, format)` inserts `payment_exports` rows in one
      batch; re-export inserts a new row (history preserved).
- [ ] Builders are pure (string in-memory results); file writing stays in the UI layer
      via the existing save-dialog pattern.
- [ ] Test-first (`tdd` skill): `tests/core/gnucash-export.test.ts` covers grouping by
      account, sign and two-decimal formatting for edge cents (1 → `-0.01`,
      1067391 → `-10,673.91`? NO — QIF `T` amounts must not contain thousands
      separators: `-10673.91`; the test pins this exact string), CSV quoting, unmapped
      blockers, default exclusion of exported payments + forced re-export, and export
      recording.

## Files to Read

- `src/report-csv.ts` / `src-tauri/src/report_csv.rs` — existing CSV/save conventions
- `.claude/skills/gnucash-data-model/SKILL.md` — tier-3 fallback rules
- `docs/RESEARCH.md` §4 — QIF format ground truth
- `_goals/gnucash-read-export/goal.md` — discovery decisions (both QIF and CSV)

## Files to Create / Change

- Exactly the ownership contract's write set.

## Constraints

- Must: format money from integer cents with string arithmetic; deterministic output
  ordering (by account path, then date, then id).
- Must NOT: write to any GnuCash file; touch the UI; use `Number.prototype.toFixed` on
  float-divided values (divide-and-pad on integers instead).

## Verification

- Targeted test command: `npx vitest run tests/core/gnucash-export.test.ts`
