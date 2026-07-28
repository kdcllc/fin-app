# Task 03.4 — Recurring bills & due-this-month dashboard

Status: todo

## Objective

Define recurring bills (payee, frequency monthly/quarterly/annual, expected amount, due day) and a dashboard answering: what's due this month, what's paid, what's overdue?

## Notes

- Match logic: a payment for the payee within the period marks the bill paid (amount tolerance configurable — utility bills vary).
- Quarterly (e.g. Fed/NC estimated taxes) and annual bills need period-aware due dates.
- Dashboard is the app's home screen: due/paid/overdue lists + month-to-date total spent.
- Seed recurring definitions from imported history (payee paid ~monthly → suggest a monthly bill).

## Acceptance criteria

- Dashboard correctly classifies due/paid/overdue for a month of real data.
- Suggested recurring bills from import history can be accepted/edited/dismissed.
