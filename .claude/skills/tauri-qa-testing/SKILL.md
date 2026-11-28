---
name: tauri-qa-testing
description: Behavioral QA workflow for the fin-app Tauri desktop app — launch the dev build, exercise user-facing flows, and capture evidence (dev output, console errors, screenshots via the Vite dev URL, direct SQLite verification) for the qa-evaluator. Use after UI or user-facing changes, before or during the QA gate.
---

# Tauri QA Testing Workflow

Produces the evidence package `qa-evaluator` requires. QA captures and observes — it never fixes.

## 1. Launch

- `npm run tauri dev` in the background (capture stdout/stderr to a log file in the scratchpad). Wait for the window/devserver-ready line; note any Rust or JS warnings at startup.
- Use a **QA copy** of data: point the app (settings/env) at a scratch book file, never the user's real book. For GnuCash flows, copy the fixture book to a temp path and hash it first (`sha256sum`).
- **Isolate from the real book**: launch with isolated `HOME`/`XDG_*` directories, pre-seed the scratch `bookPath` in the app settings, and fingerprint the real book (sha256 + size + mtime) before and after — it must be identical. Start the app with the working directory set to the scratch dir so native file dialogs do not open in the repo root. Use `sqlite3 -readonly` for any query against a live book.

## 2. Exercise the affected surface

Drive the flows named in the goal's success criteria. Two access paths:

- **Native window**: for flows requiring Tauri APIs (dialogs, file system). Interact manually-described steps or via the `run` skill's patterns.
- **Vite dev URL in a browser** (the same React UI): usable with the `claude-in-chrome` skill for clicks, screenshots, and console capture. Note in the evidence that Tauri-only APIs are stubbed/unavailable there — verify those in the native window path instead.

## 3. Capture evidence (the deliverable)

For each exercised flow record:

1. **Steps** — exact clicks/inputs.
2. **Screenshots** — before/after states (grid, dashboard, report, import review).
3. **Console/stderr** — full capture; empty is an explicit claim, show the capture. For the native window, drive it via WebDriver (`tauri-driver` + `WebKitWebDriver`, on a private Xvfb display on Linux) and install a console hook to collect errors.
4. **DB verification** — query the scratch book directly (`sqlite3 book.db "SELECT ..."`) to confirm the UI's claim: row counts after import, transaction + split rows after quick-add, totals recomputed independently and compared to displayed values (exact cents).
5. **File verification** — open produced exports: xlsx/CSV parsed back and spot-checked; PDF page count + non-zero size.
6. **GnuCash safety check** — for read flows: hash the GnuCash file before/after, must be identical. For write flows: verify backup file exists and re-read the written GUIDs.
7. **Persistence check** — kill and relaunch the app; confirm the data survived.

## 4. Package for qa-evaluator

```markdown
## QA Evidence: [feature]
**Build**: [commit/dirty] · **Data**: [scratch book path, fixture hashes]
### Flow: [name]
Steps: … | Screenshots: [paths] | Console: [path, error count]
DB check: [query → result vs expected] | Files: [path → inspection result]
Persistence: [pass/fail] | GnuCash hash: [before/after]
```

Hand the package to `qa-evaluator` (`.claude/agents/qa-evaluator.md`) (criteria: `.claude/skills/qa-criteria/SKILL.md`). Anything you couldn't exercise goes in an explicit **Not covered** list — never leave coverage implied.
