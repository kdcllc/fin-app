# Task 05.5 — Reconciliation view

Status: todo

## Objective

Side-by-side view per account and date window: fin-app payments vs. GnuCash transactions — matched pairs, fin-app-only (not yet in GnuCash → candidates for QIF export), GnuCash-only (bank activity never logged as a bill payment).

## Notes

- Match rule: same account + amount, date within tolerance (default ±3 days); manual match/unmatch overrides persisted.
- Summary line per account: matched / unmatched counts and totals.

## Acceptance criteria

- Seeded mismatch scenarios (missing on each side, amount discrepancy) are classified correctly.
- Manual match persists across re-imports.
