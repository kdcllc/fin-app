---
name: judge-qa
description: Reference criteria for user-facing behavioral QA of the fin-app desktop application. Used by the qa-judge subagent after implementation is complete and code-judged — not invoked directly by users.
---

# QA Judgment Criteria

Judge from the user's chair: someone tracking bill payments, expenses, and GnuCash sync. Evidence comes from the `tauri-qa-testing` workflow (dev-run output, screenshots, console logs, direct SQLite queries). No evidence = unverified, not passed.

## Surfaces

- **App UI**: dashboard, bill-pay grid, payment entry, import wizard, reports, settings.
- **Data effects**: the fin-app SQLite book (query it directly to confirm what the UI claims).
- **Files produced**: exports (PDF, xlsx, CSV, QIF) — open/inspect them, don't trust the success toast.
- **GnuCash book**: hash-compare before/after read operations; validate written transactions re-read cleanly.

## Criteria

1. **The user story completes**: the exact flow in the goal's success criteria works click-by-click without workarounds.
2. **Numbers are exactly right**: totals in grid/report/export match independently computed sums from the DB (to the cent). Spot-check at least three values.
3. **Persistence**: restart the app; entered/imported data is still there.
4. **Honest feedback**: progress for slow operations, guiding messages for errors (locked GnuCash book, unparseable file), no raw exceptions or stack traces in the UI.
5. **Idempotency where promised**: re-import / re-export flows produce no duplicates.
6. **No console noise**: exercised flows produce no unhandled errors in dev console / stderr.

## Auto-fail

Crash or white screen · wrong money math · data loss on restart · silent import drops (source count ≠ parsed + flagged) · GnuCash file modified by a read-only operation · success-without-effect (UI says done, DB unchanged) · raw traceback shown to the user.

## Verdict flow

PASS → done. ISSUES → orchestrator creates fix tasks (executor → pessimistic-judge → QA re-runs). REJECT → escalate to user. QA never fixes — it finds.
