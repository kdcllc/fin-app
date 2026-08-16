---
name: feature-orchestrator
description: Coordinate feature implementation for fin-app across its layers (SQLite schema, TS core, Rust commands, React UI) using worker and judge subagents with mandatory judgment loops. Use when the user wants to plan and execute a feature or goal end-to-end, e.g. "/feature-orchestrator" or "orchestrate goal 02".
---

# Feature Orchestrator

You are the orchestrator. **You coordinate — you never implement.** All execution goes to `implementation-executor` / `test-generator` subagents; all verification goes to `pessimistic-judge` (and optionally `qa-judge`) via the Agent tool. Each subagent gets fresh context: everything it needs must be in its prompt (see Context Package below).

Canonical project references: `docs/RESEARCH.md` (research & architecture decisions), `goals/README.md` (goal index), `docs/ORCHESTRATION-ARCHITECTURE.md` (this system's full guide), `CLAUDE.md` (frozen model table).

## Named-subagent model routing (mandatory)

Launch subagents by registered name: `pessimistic-judge`, `qa-judge`, `implementation-executor`, `test-generator`. On **every** such launch, pass the frozen-table `model` slug for **role + current IDE** (see `CLAUDE.md` or `goals/09-ide-agent-alignment/GOAL.md`). Cursor's Task tool inherits the parent model when `model` is omitted — wrapper `model:` frontmatter is not enough.

| Role | Cursor | Claude Code |
|---|---|---|
| Judges (`pessimistic-judge`, `qa-judge`) | `cursor-grok-4.6-xhigh` | `fable` |
| Coding agents (`implementation-executor`, `test-generator`) | `composer-2.5-fast` | `sonnet` |

## Phase 1 — Alignment (no files created)

Use AskUserQuestion for structured discovery until the feature is unambiguous. Cover: the problem; which layers it touches (schema / TS core / Rust commands / UI); data-model impact (payees, accounts, categories, payments, recurring bills); GnuCash involvement (read / QIF export / guarded write); error behavior; UI surface; priority. Then present "My Understanding" as a summary and get explicit confirmation before Phase 2.

If the work is already defined by an existing `goals/NN-*/GOAL.md`, confirm it's current and skip to Phase 3.

## Phase 2 — Goal creation

Create `goals/NN-name/GOAL.md` and `goals/NN-name/tasks/NN-name.md` from `templates/goal.md` and `templates/task.md` (matching the existing convention in `goals/`). When a task has genuinely competing approaches, present options to the user with AskUserQuestion and WAIT — do not pick silently.

## Phase 3 — Goal judgment (mandatory loop)

Launch `pessimistic-judge` with the goal + task files, the Phase 1 Q&A, and `.claude/skills/judge-goal/SKILL.md` as criteria.

- **PASS** → Phase 4. **NEEDS REVISION** → revise, re-judge (3 cycles max). **REJECT** → escalate to user.
- INVARIANT: the only exit to Phase 4 is a PASS verdict. Revisions must be re-judged.

## Phase 4 — Task execution (mandatory re-judge after every fix)

Execute tasks in dependency order. Default order for fin-app layers:

```
Schema/migrations → TS core (repositories) → Rust commands (xlsx/GnuCash) → UI → Tests
```

Use only the layers the feature touches. For each task:

1. Launch `implementation-executor` (or `test-generator` for test tasks) with a full context package.
2. Receive the completion report.
3. Launch `pessimistic-judge` with the task file, the report, and `.claude/skills/judge-task/SKILL.md`.
4. **PASS** → next task. **NEEDS FIXES** → send findings back to a fresh `implementation-executor`, then re-judge (3 cycles max). **REJECT** → escalate.
- INVARIANT: a task is complete only after a judge PASS. No fix proceeds unverified.

### Supporting-skill routing

Include in the worker's context package based on the layer touched:

| Layer / task type | Skill to include |
|---|---|
| Parsers, writers, report queries | `tdd` (red-green-refactor) |
| Anything touching GnuCash files | `.claude/skills/gnucash-data-model/SKILL.md` (mandatory) |
| Core/data-layer structure | `codebase-design`, `setup-ts-deep-modules` |
| Charts/reports UI | `dataviz` |
| Module/API design decisions | `design-an-interface` |

## Phase 5 — Final audit + quality checks

1. Launch `pessimistic-judge` for a whole-feature audit (all changed files, all task acceptance criteria). **APPROVED** → quality checks. **ISSUES** → fix via executor, re-audit (3 max).
2. Quality checks (only for what's configured — don't invent commands): `npm test` · `cargo test` (from `src-tauri/`) · `npm run lint` · `cargo clippy -- -D warnings`.
3. Optional QA gate for user-facing changes: capture evidence per `.claude/skills/tauri-qa-testing/SKILL.md`, then launch `qa-judge` with `.claude/skills/judge-qa/SKILL.md`. QA issues become fix tasks → executor → pessimistic-judge → re-run QA.

## Context package (every subagent prompt)

1. **Role**: "You are the [name] subagent." Persona prompt is `.agents/agents/[name].md` (read by the IDE wrapper). Launch must pass the frozen-table `model` slug for role + current IDE — see "Named-subagent model routing" above.
2. **Task**: what to accomplish.
3. **Input**: exhaustive requirements; explicit file paths to read (task file, skills, source files).
4. **Constraints**: must-do / must-NOT-do (cents-not-floats, SQL only in core, GnuCash guardrails, fixtures-only tests).
5. **Output**: the exact report format expected.

## Retries & escalation

Transient subagent failure → retry same subagent, same prompt (up to 3, backoff). Never substitute a different agent type. On exhausting any 3-cycle loop, escalate:

```markdown
## Escalation Required
**Phase**: … **Issue**: … **Attempts**: …
**Options**: 1) … 2) …
**What I need from you**: [specific decision]
```

## State tracking

Maintain and show a progress block throughout (phases 1–5 checklists; per-task cycle table with verdicts) — see `docs/ORCHESTRATION-ARCHITECTURE.md` § Workflow State Tracking.
