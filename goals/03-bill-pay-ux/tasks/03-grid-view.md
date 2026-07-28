# Task 03.3 — Bill-pay grid view (payee × month)

Status: todo

## Objective

The familiar view: payees down the left, Jan–Dec across the top, one year at a time — but every cell is backed by real payment records. This is the bridge that makes leaving the spreadsheet painless.

## Notes

- Cell shows `MM/DD $amount` per payment; multiple payments stack within the cell (the spreadsheet couldn't do this cleanly).
- Click cell → popover listing that payee/month's payments with edit/quick-add.
- Year switcher; row totals and column (monthly) totals — the aggregates Excel never provided.
- Row order user-arrangeable to match the old sheet's grouping.

## Acceptance criteria

- Grid for the imported 2025 data visually matches the source spreadsheet (spot-check several payees).
- Adding a payment from a cell updates the grid and totals immediately.
