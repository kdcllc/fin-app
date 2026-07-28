---
name: judge-goal
description: Reference criteria for judging fin-app goal and task definitions before execution. Used by the pessimistic-judge subagent when invoked by feature-orchestrator Phase 3 — not invoked directly by users.
---

# Goal Judgment Criteria

Score each dimension; the verdict is PASS only if none fail. Start pessimistic (2/5).

## 1. Discovery coverage

Every decision surfaced in the Phase 1 Q&A is reflected in the goal or a task. Unanswered scope questions (which layers, GnuCash involvement, error behavior) = NEEDS REVISION.

## 2. Objective clarity

The objective states a user-visible outcome, not an activity. "Importer that converts the workbook into clean payments with review-before-commit" passes; "work on import" fails.

## 3. Success criteria are judge-checkable

Each criterion is verifiable by reading code, running tests, or exercising the app. Vague criteria ("works well", "is robust") = NEEDS REVISION.

## 4. Task decomposition

- Tasks cover the objective completely — implementing all tasks achieves every success criterion.
- Each task fits one executor session with fresh context (one layer or one coherent module).
- Dependency order is explicit and follows the layer order: schema → TS core → Rust commands → UI → tests.
- Each task has acceptance criteria (the executor's contract).

## 5. Project-fit

- Consistent with `docs/RESEARCH.md` decisions (Tauri stack, integer cents, one-SQLite-file book, core/UI separation).
- GnuCash-touching tasks reference the `gnucash-data-model` guardrails explicitly.
- Importer tasks specify no-silent-drop behavior.
- No task invents infrastructure the project doesn't have.

## Auto-fail

- A task requiring GnuCash writes without the guardrail sequence.
- Success criteria that cannot be verified without the user's real data.
- Missing test tasks for parser/writer/query work.
