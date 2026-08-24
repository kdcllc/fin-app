---
name: qa-criteria
description: Criteria the qa-evaluator applies to user-facing behavioral evidence for fin-app. Reference skill — not invoked directly.
disable-model-invocation: true
---

# QA Evaluation Criteria

Evaluate observed behavior from the user's perspective. Evidence not provided = behavior
not tested = an issue.

**Hard-threshold rule**: the criteria below are gates, not averages — one failing
surface **or cross-cutting check** caps the verdict at ISSUES FOUND no matter how clean
the rest are. A secrets leak, for example, caps the verdict on its own, regardless of how
clean every surface is.

## Per-surface criteria

### Desktop UI (Tauri) — the only user-facing surface
- Screenshots (captured via the Vite dev URL per the `tauri-qa-testing` skill) show the
  affected views rendering correctly.
- Browser console is free of errors; dev-server output free of unhandled errors.
- Money amounts render as exact cents — never floating-point artifacts, never wrong
  rounding.
- Import flows surface every unparsed cell in the review UI; no input silently dropped.
- Reported effects are verified directly in the SQLite app database (integer-cent
  values, expected rows present).
- GnuCash operations show the guardrails held: backups exist for writes; reads never
  mutate the book.

## Cross-cutting checks

- **Effect verification**: an operation that reports success demonstrably had its effect.
- **No secrets** in any output, log, or screenshot.
- **Consistency**: the same information reported by two surfaces agrees.

## Verdicts

- **PASS**: all affected surfaces evidenced and clean.
- **ISSUES FOUND**: numbered issues, each with observed vs expected and exact repro
  steps — these become fix tasks for implementer.
- **REJECT**: an auto-fail trigger fired (see `.claude/agents/qa-evaluator.md`) or the
  evidence shows the feature fundamentally doesn't work.
