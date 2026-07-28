# Goal 04 — Reporting & Export

**Milestone:** v0.2 · **Depends on:** Goals 02, 03

## Objective

The reason the app exists: multi-year expense reports the spreadsheet could never produce, plus PDF and xlsx/CSV export. Report set inspired by HomeBank ("Where your money goes", trend-over-time) and KMyMoney (configurable engine, export any report).

## Success criteria

- Reports: spending by category, by payee, by account; month-over-month; **year-over-year**; calendar-year and trailing-12-month windows.
- Every report renders as an interactive chart (ECharts) plus a data table, and exports to PDF and xlsx/CSV.
- Reports over 5+ years of data render in under 1 second (SQLite aggregate queries, indexed).

## Tasks

1. [Report query engine over SQLite](tasks/01-report-queries.md)
2. [Chart components with ECharts](tasks/02-charts.md)
3. [PDF export of reports](tasks/03-pdf-export.md)
4. [xlsx / CSV export](tasks/04-xlsx-csv-export.md)
