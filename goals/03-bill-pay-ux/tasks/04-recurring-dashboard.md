# Task 03.4 — Recurring bills & due-this-month dashboard

Status: todo

## Objective

Define recurring bills (payee, frequency monthly/quarterly/annual, expected amount, due day) and a dashboard answering: what's due this month, what's paid, what's overdue?

Core ownership: due-period expansion, payment matching, tolerance logic, and status classification are implemented in TS core services; UI renders and filters results.

## Notes

- Match logic: a payment for the payee within the period marks the bill paid (amount tolerance configurable — utility bills vary).
- Quarterly (e.g. Fed/NC estimated taxes) and annual bills need period-aware due dates.
- Dashboard is the app's home screen: due/paid/overdue lists + month-to-date total spent.
- Seed recurring definitions from imported history (payee paid ~monthly → suggest a monthly bill).
- Error behavior: invalid recurring definitions, missing payee links, and empty-state months surface actionable UI messages.
- Execution gate: TS core schedule expansion/matching/classification must pass fixture tests before dashboard UI presentation work is implemented.

## Acceptance criteria

- Dashboard correctly classifies due/paid/overdue for fixture months covering monthly, quarterly, and annual schedules with configurable tolerance edge cases.
- Suggested recurring bills derived from fixture import history can be accepted/edited/dismissed with deterministic persisted outcomes.
