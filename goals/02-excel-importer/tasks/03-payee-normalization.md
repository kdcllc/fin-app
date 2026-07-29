# Task 02.3 — Payee normalization & account-hint extraction

Status: todo

## Objective

Turn messy row labels like `9002(ExampleBank Personal Checking)` and `Metro Power: … pay w/CardOne` into clean payee names plus account hints, and propose payee/account/category records.

Ownership: implement normalization heuristics in TS core so proposed mappings are deterministic and unit-testable.

## Notes

- Heuristics: leading `NNNN(` → account last4; `pay w/X` / `Pay@X w/Y` → payment-method hint; text before `:` or `(` → payee name.
- Group header rows (e.g. `Example City:` followed by per-account rows) belong to one payee with two accounts — merge.
- Propose initial categories (utilities, telecom, credit-card payment, insurance, giving, taxes, services) as *suggestions*; user confirms in the review UI.
- Everything is a suggestion — heuristics feed the review step, they never commit directly.

## Acceptance criteria

- Fixture labels map to deterministic expected outputs (payee name, account hint, optional category suggestion) defined in test fixtures.
- Group-header patterns (e.g. `Example City:` families) produce one payee proposal with distinct account-hint variants as expected by fixture assertions.
- Category suggestions are emitted as suggestions only; no persistence occurs in this task.
- Unmatched patterns fall back to "payee = raw label, account = unknown" rather than failing.
