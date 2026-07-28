# Task 02.2 — Cell parser for "MM/DD $amount" values

Status: todo

## Objective

Parse the free-text payment cells into `{date, amount_cents}` records. Year comes from the sheet name; month column is a cross-check only (real cells sometimes disagree with their column, e.g. `03/26` under Apr — trust the cell's MM/DD).

## Observed formats (from the real file)

- `01/08  $48.58` — variable whitespace
- `04/27 $1000` — no decimals, no thousands separator
- `01/28 $10,673.91` — thousands separator
- Possible multiple payments in one cell (split on newline / multiple `MM/DD $` occurrences)

## Notes

- Output integer cents; never parse through floats.
- Anything that doesn't fully parse → an `unparsed` list with sheet/row/col coordinates for the review UI. **No silent drops.**

## Acceptance criteria

- Unit tests cover all observed formats plus multi-payment cells and garbage input.
- Running against the real workbook: every non-empty data cell is either parsed or listed as unparsed.
