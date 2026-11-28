# fin-app — Research Report

**Date:** 2026-07-28
**Purpose:** Foundation document for defining goals and tasks for a custom, cross-platform, local-first personal finance desktop app that replaces the `2026-bill-pay.xlsx` workflow and integrates with GnuCash.

---

## 1. Problem Statement

The user currently tracks monthly bill payments in an Excel workbook (`2026-bill-pay.xlsx`) and manages bank accounts in GnuCash. The goals:

1. Track expenses **over multiple years** (the spreadsheet resets per year and doesn't aggregate).
2. **Generate reports** (spending by category, payee, account, trends over time).
3. Run as a **desktop app on Windows, macOS, and Linux** — explicitly *not* a website.
4. **Two-way integration with GnuCash** so bank-account data and bill-pay data stay consistent.
5. **Local-only data** — no cloud, no server; all data stays on the machine.

## 2. Analysis of the Current Spreadsheet

The workbook contains one sheet per year (currently `2025`), structured as a payee × month grid:

- **Rows** = payees/bills (city water, internet, mobile phone, electric, credit cards, insurance, charitable giving, quarterly taxes, pest control, etc.).
- **Columns** = months Jan–Dec.
- **Cells** = free text like `01/08 $48.58` (payment date + amount in one string).

### Weaknesses this app must solve

| Weakness | Consequence |
|---|---|
| Dates and amounts stored as text in one cell | No sums, no filtering, no math possible |
| Payment method/account embedded in payee name (e.g., "9002 (ExampleBank Personal Checking)", "pay w/CardOne") | Account is not queryable; two rows per payee when paid from two accounts |
| No category field | Cannot report "spending by category" without manual tagging |
| One sheet per year | No multi-year trends; history requires opening old files |
| Multiple payments in one month squeeze into one cell | Data loss / ambiguity |
| No link to actual bank data (GnuCash) | Manual double-entry; no reconciliation |

### Implicit data model discovered in the spreadsheet

Entities the app needs, derived directly from how the spreadsheet is used:

- **Payee** (biller): name, default category, notes.
- **Account / payment method**: ExampleBank Personal Checking (…9002), ExampleBank Business Checking (…9001), CardOne card, CardTwo card, CardThree card — these should map to GnuCash accounts.
- **Payment**: payee, date, amount, account used, optional memo.
- **Category**: utilities, telecom, credit-card payments, insurance, charitable giving, taxes, home services.
- **Recurring bill definition**: expected frequency (monthly, quarterly, annual) and expected amount — enables a "what's due / what's unpaid this month" view, which is the spreadsheet's core job.

## 3. Technology Stack Evaluation (2026)

Candidates compared for a local-first desktop app (Win/macOS/Linux) with SQLite storage, charts, PDF/Excel export, .xlsx import, and GnuCash interop.

### Summary table

| | Tauri 2.x | Avalonia (.NET) | Electron | Flutter desktop | Qt/PySide6 |
|---|---|---|---|---|---|
| Maturity for desktop | Stable since Oct 2024, rapidly growing | Production-grade (JetBrains, Autodesk; MS building MAUI-Linux on it) | Incumbent (VS Code, Actual Budget) | Weakest target of Flutter | Most battle-tested |
| Installer size / idle RAM | ~3–15 MB / 30–100 MB (best) | ~26–80 MB / 100–200 MB | 80–200 MB / 150–300 MB | ~190–210 MB / 270–310 MB (worst) | Large (Python bundling) |
| SQLite | Official `tauri-plugin-sql` w/ migrations, or `rusqlite` | Excellent (EF Core, Microsoft.Data.Sqlite, Dapper) | `better-sqlite3` (N-API, prebuilt) | drift / sqflite | sqlite3 stdlib |
| Charts | Entire JS ecosystem (ECharts, Chart.js, D3) — richest | LiveCharts2, ScottPlot | Same as Tauri | fl_chart, Syncfusion | QtCharts |
| .xlsx import/export | `calamine` (read) + `rust_xlsxwriter` (write), or SheetJS | ClosedXML (best-in-class free) | SheetJS/exceljs | thin (`excel` pkg) | pandas/openpyxl (excellent) |
| PDF reports | HTML print-to-PDF, `printpdf`, Typst | QuestPDF (free at personal scale) | `printToPDF()` built-in (easiest) | `pdf`+`printing` pkgs | reportlab |
| Packaging + auto-update, all 3 OSes | Built-in bundler + signed updater (MSI/NSIS/DMG/deb/rpm/AppImage) — best free story | Velopack (one command, delta updates) | electron-builder + electron-updater (mature) | No Linux auto-update; DIY packaging | Poor (PyInstaller pain, LGPL care) |
| GnuCash interop | Read SQLite in Rust; piecash Python sidecar (documented pattern) | Read SQLite via ADO.NET; piecash via Process | Read SQLite; piecash via child process | Weak interop story | **Native piecash** (same language) |

### Recommendation

**Top choice: Tauri 2.x** — Rust core + web UI (React or Svelte + TypeScript).

- Hits every requirement with the smallest footprint and the most complete free 3-OS packaging/auto-update pipeline (built-in signed updater serving from GitHub Releases).
- For a **reports-heavy** app, the JS charting ecosystem (Apache ECharts recommended) is the strongest argument — nothing in .NET/Flutter matches it.
- xlsx import is solved with `calamine` (pure-Rust reader — ideal for the one-time spreadsheet migration) and export with `rust_xlsxwriter`.
- Most application logic can live in TypeScript; Rust is needed only for thin backend commands, limiting the learning-curve risk.
- Accepted risks: WebKitGTK quirks on Linux; testing across three OS WebViews; some Rust required.

**Runner-up: Avalonia UI (.NET/C#)** — pick this instead if a single language and pixel-identical rendering (own Skia renderer, no WebView variance) outweigh footprint and charting breadth. EF Core + ClosedXML + QuestPDF + LiveCharts2 + Velopack is a complete, high-quality solution.

**Not recommended:** Electron (works — Actual Budget proves it — but 10–20× the footprint for no gain here); Flutter desktop (heaviest binaries, thinnest desktop/xlsx ecosystem, no Linux auto-update, and no mobile requirement to justify it); PySide6 (best piecash interop but the worst packaging/update/licensing story for a shipped desktop app).

### Architectural inspiration from existing open-source apps

- **Actual Budget** (TypeScript/Electron): one **SQLite file per budget book**; platform-agnostic core (`loot-core`) separated from the UI shell; DB access in a worker thread. → Adopt: one-SQLite-file data store, core/UI separation.
- **HomeBank** (C/GTK): report set worth copying — "Where your money goes," trend-over-time, budget-vs-actual.
- **KMyMoney** (C++/Qt): configurable report engine with chart types + CSV export of any report.

## 4. GnuCash Integration Strategy

### Feasibility verdict

Two-way integration is **feasible and proven, but officially unsupported** — safety comes from process discipline, not from any GnuCash guarantee.

Key facts from GnuCash's own documentation:

- GnuCash stores a book as compressed **XML** (default), **SQLite3**, PostgreSQL, or MySQL. **SQLite3 is the required backend for integration** — the wiki calls modifying the XML "risky and not recommended," while the SQL schema is stable and documented.
- GnuCash treats its file formats as **not a public API**; the wiki says correct SQL updates outside its API are "nearly impossible" in the general case. In practice this is mitigated by writing only the well-understood subset: `transactions`, `splits`, `accounts`, `prices`.
- **The critical constraint:** GnuCash loads the whole book into memory at startup and never re-reads the DB. Writing while GnuCash is open means it won't see the rows and its own commits can clobber them. Its `gnclock` lock table is "weak protection" (advisory only).
- **piecash** (Python, SQLAlchemy) is the de facto standard third-party read-write library for GnuCash SQL books — a decade in production, safety-first defaults (read-only open, auto-backup before writes, lock checks). Original repo last released v1.2.1 (July 2024); development continues in the community fork `gorf/piecash`. Rust (`rucash`) and JS libraries are read-only; .NET (`NetCash`) is an unstable work-in-progress.
- GnuCash makes **no automatic backups for SQL backends** (unlike XML), so the integrating app must own backups.

### Recommended integration design (three tiers)

1. **Read (any time)** — open the GnuCash SQLite file read-only to import bank transactions, account tree, and balances into fin-app. GnuCash docs confirm concurrent reads are safe. One-time prerequisite: user saves their book as sqlite3 (File → Save As in GnuCash).
2. **Write (only when GnuCash is closed)** — to push bill payments into GnuCash: check the `gnclock` table and refuse if GnuCash holds the lock; take our own lock row; **copy the file as a backup first**; insert balanced transaction + splits (double-entry: debit the EXPENSE account, credit the funding BANK/CREDIT account, amounts as numerator/denominator rationals, 32-hex GUIDs); wrap in a single SQL transaction; verify the `versions` table schema version before writing and refuse on unknown versions; never touch `slots`.
3. **Fallback (zero-risk)** — generate a **QIF/CSV file** and let the user run GnuCash's built-in import assistant, which provides duplicate detection and account matching. Use this whenever the write preconditions can't be met.

_[Implemented in v0.3: read-only sqlite3 reader (probe/accounts/transactions), account & category GUID mapping, transaction import with review, QIF/CSV export fallback, and reconciliation with manual overrides — see `src-tauri/src/gnucash_reader.rs`, `src/core/gnucash-*.ts`, `src/pages/GnuCashPage.tsx`; direct GnuCash write (tier 2) remains deferred pending explicit go-ahead. The QIF/CSV export fallback and reconciliation were later retired in the ledger-core goal; the GnuCash page now offers Link book, Account mapping, and Import only.]_

### Data-model essentials to honor

- Accounts form a tree with types (BANK, CREDIT, EXPENSE, …); each has a commodity (currency) with a fraction (e.g., 100 = cents).
- An "expense" is not a record type — it's a balanced transaction: one split with positive value on an EXPENSE account, one with negative value on the funding account. **Sum of split values per transaction must equal 0.**
- Map fin-app `accounts` and `categories` to GnuCash account GUIDs (asset/credit accounts ↔ payment methods; EXPENSE accounts ↔ categories) — this mapping table is the heart of the integration. _[Implemented: since the ledger-core goal, categories are EXPENSE accounts in fin-app's own ledger, so both funding and EXPENSE accounts carry `accounts.gnucash_guid`.]_

## 5. Proposed Application Scope (input for goals/tasks)

### Core data model (SQLite, one file = one book)

`accounts` (mapped to GnuCash account GUIDs where applicable) · `payees` · `categories` · `payments` (payee, account, category, date, amount, memo, source: manual|gnucash|xlsx) · `recurring_bills` (payee, frequency, expected amount, due day) · `import_log`.

_[Superseded by the ledger-core goal (schema v9, migration `0009_double_entry_ledger.sql`): `accounts` is now a typed tree (ASSET/LIABILITY/INCOME/EXPENSE/EQUITY, with `subtype`, `parent_id`, `placeholder`, `gnucash_guid`), `transactions` and `splits` replace `payments` (split `amount_cents` is debit-positive and a transaction's splits sum to 0), and `categories` became EXPENSE accounts (old ids kept in `legacy_category_map`). `payments`, `categories`, `payment_exports` and `gnucash_matches` were dropped; existing books migrate automatically after a verified backup. `payees`, `recurring_bills` and `import_log` remain. A "payment" is now a payment-shaped transaction: a payee plus exactly two splits, one EXPENSE and one ASSET/LIABILITY.]_

### MVP features (v0.1)

1. One-time **migration importer** for `2026-bill-pay.xlsx` (and prior-year files): parse `MM/DD $amount` cells, extract account hints from payee names, land clean rows for review before commit.
2. **Bill-pay grid view** replicating the payee × month layout users already know — but backed by real records.
3. Payment entry (quick-add), payee/account/category management.
4. **Due-this-month dashboard**: recurring bills vs. payments made.

### v0.2 — Reporting

5. Reports: spending by category / payee / account, month-over-month and **year-over-year trends**, calendar-year and trailing-12-month views.
6. Export: PDF report output, .xlsx/CSV export.

### v0.3 — GnuCash integration

7. Read-only GnuCash SQLite import (transactions → payments, account/category GUID mapping). _[Imports now land as payment-shaped ledger transactions.]_
8. ~~Reverse flow: export entered bill payments as QIF/CSV for GnuCash import (zero-risk path).~~ _[Retired in the ledger-core goal.]_
9. ~~Reconciliation view: fin-app payments vs. GnuCash transactions.~~ _[Retired in the ledger-core goal.]_

### v0.4 — GnuCash direct write (optional, guarded)

10. Direct write of bill payments into the GnuCash SQLite book, only when GnuCash is closed: `gnclock` check, schema-version check, automatic file backup, balanced transaction+splits in one SQL transaction (piecash semantics as the reference implementation).

### Non-functional requirements

- All data local (single SQLite file, user-chosen location, easy to back up/sync via Dropbox-style tools if desired).
- Signed installers + auto-update on Windows/macOS/Linux via Tauri updater + GitHub Releases. _(Amended 2026-08-25: shipped without OS code signing — no Windows/Apple certs; SmartScreen/Gatekeeper workarounds documented in `docs/RELEASING.md`. Updater bundles are minisign-signed and verified against the pubkey pinned in `src-tauri/tauri.conf.json` — see `docs/RELEASING.md`.)_
- Schema migrations from day one (`tauri-plugin-sql` migrations). _(Amended 2026-08-04: `tauri-plugin-sql` was replaced by an app-owned `rusqlite` backend with `PRAGMA user_version` migrations over the same SQL files — its sqlx connection pool broke transaction atomicity; see Goal 08, `goals/08-sqlite-backend-rework/GOAL.md`.)_

## 6. Sources

Stack comparison: Tauri 2.0 announcement & plugin docs (v2.tauri.app), rustify.rs Tauri-vs-Electron 2026, pkgpulse.com Electron-vs-Tauri 2026, Avalonia (avaloniaui.net, The Register on MAUI-Linux, Velopack, QuestPDF), electron-builder docs, Flutter desktop 2026 assessments (softaims.com, tomasrepcik.dev), drift docs, PySide licensing (pythonguis.com). Prior-art: actualbudget.org database docs & localfirst.fm interview, gethomebank.org, KMyMoney KDE docs. GnuCash: wiki.gnucash.org — [SQL backend & gnclock](https://wiki.gnucash.org/wiki/SQL), [Using the API](https://wiki.gnucash.org/wiki/Using_the_API), [external software interfaces](https://wiki.gnucash.org/wiki/List_of_external_software_interfaces), [Python bindings](https://wiki.gnucash.org/wiki/Python_Bindings), [Backup](https://wiki.gnucash.org/wiki/Backup); [GnuCash 5 import guide](https://www.gnucash.org/docs/v5/C/gnucash-guide/chapter_importing.html); [piecash docs & object model](https://piecash.readthedocs.io/en/master/object_model.html), [piecash GitHub](https://github.com/sdementen/piecash) + [community fork](https://github.com/gorf/piecash); [rucash (Rust, read-only)](https://github.com/z-Wind/rucash); [NetCash (.NET, WIP)](https://github.com/louietan/NetCash).
