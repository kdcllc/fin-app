---
name: deep-research-orchestrator
description: Research → Plan workflow for fin-app topics needing investigation before implementation (GnuCash schema details, Tauri plugin capabilities, QIF format specifics, report/PDF approaches). Produces a research report and then a judged goals/NN-name/ structure ready for feature-orchestrator execution.
---

# Deep Research Orchestrator

For topics where building would be guessing. Coordinates research subagents, then converts findings into an executable goal. You coordinate; subagents research; judges verify.

## Named-subagent model routing (mandatory)

Launch subagents by registered name: `pessimistic-judge`, `qa-judge`, `implementation-executor`, `test-generator`. On **every** such launch, pass the frozen-table `model` slug for **role + current IDE** (see `CLAUDE.md` or `goals/09-ide-agent-alignment/GOAL.md`). Cursor's Task tool inherits the parent model when `model` is omitted — wrapper `model:` frontmatter is not enough.

| Role | Cursor | Claude Code |
|---|---|---|
| Judges (`pessimistic-judge`, `qa-judge`) | `cursor-grok-4.6-xhigh` | `fable` |
| Coding agents (`implementation-executor`, `test-generator`) | `composer-2.5-fast` | `sonnet` |

## Research ground truth

- `docs/RESEARCH.md` — the committed, canonical research (stack decision, spreadsheet analysis, GnuCash strategy). **Cite as ground truth; promote durable new findings into it.**
- `_research/` — working area: `_research/prompts/[topic].md` for prompts, `_research/[topic]/report.md` for raw reports. Scratch, not canon.

## Phase 1 — Research prompt

Draft `_research/prompts/[topic].md` from `templates/research-prompt.md`: precise questions, what's already known (link `docs/RESEARCH.md` sections), required output structure, source-citation requirement.

## Phase 2 — Execute & ingest

Launch one or more research subagents (Agent tool, general-purpose, with WebSearch/WebFetch) with the prompt — parallel agents for independent angles (e.g., format spec vs. library survey). Ingest results into `_research/[topic]/report.md` using `templates/research-report.md`. Every claim needs a source URL; flag unverified claims explicitly. If findings contradict `docs/RESEARCH.md`, surface the conflict to the user — never silently overwrite ground truth.

## Phase 3 — High-level plan

Collaborative planning with the user (plan mode when appropriate): present the approach the research supports, alternatives with trade-offs, and get explicit direction before decomposing.

## Phase 4 — Goal & tasks

Create `goals/NN-name/` (GOAL.md + tasks/) per the feature-orchestrator templates, then run the **feature-orchestrator Phase 3 goal-judgment loop** (pessimistic-judge with judge-goal criteria) until PASS. Output feeds directly into feature-orchestrator Phase 4 execution.

## Rules

- Research subagents get fresh context: the prompt file content is their whole world — make it complete.
- Promote-or-discard: at the end, either durable findings go into `docs/RESEARCH.md` (with sources) or the `_research/` material is noted as superseded. No orphaned half-truths.
