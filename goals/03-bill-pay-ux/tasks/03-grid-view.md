# Task 03.3 — Bill-pay grid view (payee × month)

Status: todo

## Objective

The familiar view: payees down the left, Jan–Dec across the top, one year at a time — but every cell is backed by real payment records. This is the bridge that makes leaving the spreadsheet painless.

Core ownership: month bucketing, cell contents, row totals, and column totals are produced by TS core query/services; UI renders results and dispatches edits.

## Notes

- Cell shows `MM/DD $amount` per payment; multiple payments stack within the cell (the spreadsheet couldn't do this cleanly).
- Click cell → popover listing that payee/month's payments with edit/quick-add.
- Year switcher; row totals and column (monthly) totals — the aggregates Excel never provided.
- Row order user-arrangeable to match the old sheet's grouping.
- Error behavior: empty year/filter states and query failures show clear messages and recoverable UI states.
- Execution gate: TS core month-bucketing and totals queries must pass fixture tests before grid rendering/popover interactions are implemented.

## Acceptance criteria

- Grid for committed fixture dataset reproduces expected payee x month placement and exact expected row/column totals from fixture assertions.
- Adding a payment from a cell updates the grid and totals immediately.
- Cell popover edit/delete operations persist and refresh target cell contents and aggregates deterministically.
