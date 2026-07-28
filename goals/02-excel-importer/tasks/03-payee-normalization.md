# Task 02.3 — Payee normalization & account-hint extraction

Status: todo

## Objective

Turn messy row labels like `9002(ExampleBank Personal Checking)` and `Metro Power: … pay w/CardOne` into clean payee names plus account hints, and propose payee/account/category records.

## Notes

- Heuristics: leading `NNNN(` → account last4; `pay w/X` / `Pay@X w/Y` → payment-method hint; text before `:` or `(` → payee name.
- Group header rows (e.g. `Example City:` followed by per-account rows) belong to one payee with two accounts — merge.
- Propose initial categories (utilities, telecom, credit-card payment, insurance, giving, taxes, services) as *suggestions*; user confirms in the review UI.
- Everything is a suggestion — heuristics feed the review step, they never commit directly.

## Acceptance criteria

- The real workbook's ~20 payee rows map to a sensible proposed payee/account/category set (manually verified once).
- Unmatched patterns fall back to "payee = raw label, account = unknown" rather than failing.
