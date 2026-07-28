---
name: judge-task
description: Reference criteria for judging completed fin-app implementation work. Used by the pessimistic-judge subagent in feature-orchestrator Phases 4 and 5 — not invoked directly by users.
---

# Task Judgment Criteria

Verify, don't trust. Read the diff, run the checks, compare against the task file's acceptance criteria. Start at 2/5.

## 1. Acceptance criteria — the contract

Every criterion in the task file is demonstrably met. For each, name the evidence (file:line, test name, command output). One unmet criterion = NEEDS FIXES, no matter how good the rest is.

## 2. Verification actually ran

The executor's report claims commands were run — re-run the decisive ones yourself (`npm test`, `cargo test`, `cargo clippy`). Claimed-green-but-red = REJECT (misreporting).

## 3. Project non-negotiables

- Integer cents everywhere in fin-app code; rationals for GnuCash; **no float money math**.
- SQL confined to the core data-access layer.
- Importers: every input cell parsed or surfaced — grep for swallowed errors / bare catches.
- GnuCash access follows `gnucash-data-model` guardrails (read-only flags on reads; lock/version/backup on writes; `slots`/`versions` untouched).
- Tests use fixtures/temp dirs only.

## 4. Test quality (when the task includes tests)

- Tests verify outcomes, not implementation details.
- Edge cases from the task file are present (not just happy path).
- Tests can fail: a suite that passes with the feature's core logic inverted is decorative.

## 5. Scope discipline

The diff contains the task and only the task. Unrelated refactors, renames, dependency additions = NEEDS FIXES (revert or justify).

## Auto-fail (→ NEEDS FIXES or REJECT)

Float currency math · missing GnuCash guardrail · silent data drops · SQL in UI code · tests against real user data · unmet acceptance criterion · weakened/deleted tests to force green · misreported verification results.
