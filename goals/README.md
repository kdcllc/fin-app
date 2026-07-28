# fin-app — Goals & Tasks

Derived from [docs/RESEARCH.md](../docs/RESEARCH.md). Each goal lives in its own folder with a `GOAL.md` (objective, success criteria, dependencies) and a `tasks/` folder with one file per task.

**Stack (per research):** Tauri 2.x · React + TypeScript · SQLite (`tauri-plugin-sql` with migrations) · ECharts · `calamine` / `rust_xlsxwriter` for xlsx · Tauri updater + GitHub Releases.

| # | Goal | Milestone | Depends on |
|---|------|-----------|------------|
| 01 | [Foundation & scaffolding](01-foundation/GOAL.md) | v0.1 | — |
| 02 | [Excel migration importer](02-excel-importer/GOAL.md) | v0.1 | 01 |
| 03 | [Bill-pay core UX](03-bill-pay-ux/GOAL.md) | v0.1 | 01 |
| 04 | [Reporting & export](04-reporting/GOAL.md) | v0.2 | 02, 03 |
| 05 | [GnuCash read integration + QIF export](05-gnucash-read/GOAL.md) | v0.3 | 03 |
| 06 | [GnuCash direct write (guarded)](06-gnucash-write/GOAL.md) | v0.4 | 05 |
| 07 | [Distribution & auto-update](07-distribution/GOAL.md) | release | 01 |

## Status convention

Each task file has a `Status:` line — `todo | in-progress | done`. Update it as work proceeds.
