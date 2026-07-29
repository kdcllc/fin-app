# Goal 03 fixtures

These fixtures are the deterministic source of truth for Goal 03 bill-pay UX tests.

## Recurring dashboard fixtures

Directory: `recurring-dashboard/`

- `classification.json`: baseline due/paid/overdue classification cases.
- `classification-anchors.json`: quarterly/annual anchor-month and anchor-phase cases.
- `suggestions.json`: recurring suggestion detection and dismissal persistence cases.

Recurring fixture invariants:
- Classification output is deterministic for the same fixture inputs and options.
- Money assertions are integer cents only.
- Anchor fields (`anchor_month`, `anchor_phase`) are explicit where non-default behavior is required.
- Suggestion dismissals filter by deterministic signature and persist across re-runs.

## Bills grid fixtures

Directory: `bill-pay-grid/`

- `goal-03-grid-2026.json`: canonical payee x month placement and aggregate totals dataset for Goal 03.

Grid fixture invariants:
- Cell placement is exact by payee name, month, and rendered payment label (`MM/DD $amount`).
- Row totals, month totals, and grand total are exact integer-cents equivalents of fixture payments.
- Dataset is deterministic and year-scoped to support year-switch regression tests.
- Includes at least one payee with no in-year payments to verify zero-total row handling.
