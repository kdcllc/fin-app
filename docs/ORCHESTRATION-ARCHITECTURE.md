# fin-app Orchestration Architecture

A guide to how the feature and research orchestration system works for **fin-app**,
including subagent delegation, judgment cycles, and retry mechanisms.

> **Stack note:** fin-app is a local-first, cross-platform (Windows/macOS/Linux) desktop
> personal-finance app: **Tauri 2.x** shell, **React + TypeScript** UI, a platform-agnostic
> **TypeScript core** data layer over **SQLite** (`tauri-plugin-sql`, one file = one book), and
> **Rust commands** for xlsx parsing (`calamine`) and GnuCash sqlite3 file access. It replaces the
> `2026-bill-pay.xlsx` workflow and integrates with GnuCash (read / QIF export / guarded
> write). The canonical references are `docs/RESEARCH.md` (research & decisions), `goals/README.md`
> (goal index), and the `gnucash-data-model` skill (domain guardrails).

---

## Table of Contents

1. [Core Concepts](#core-concepts)
2. [Component Overview](#component-overview)
3. [Feature Orchestrator Flow](#feature-orchestrator-flow)
4. [Deep Research Orchestrator Flow](#deep-research-orchestrator-flow)
5. [QA Judgment (Optional Behavioral Gate)](#qa-judgment-optional-behavioral-gate)
6. [Subagent Communication Protocol](#subagent-communication-protocol)
7. [Judgment & Retry Mechanisms](#judgment--retry-mechanisms)
8. [Quick Reference](#quick-reference)

---

## Core Concepts

### Why This Architecture?

Traditional single-agent execution suffers from:

| Problem | Cause | Impact |
|---------|-------|--------|
| **Context Fatigue** | Long conversations exhaust attention | Late tasks get less quality |
| **Sunk Cost Bias** | Agent invested in previous work | Reluctant to reject own output |
| **Optimism Creep** | Desire to "finish" | Cuts corners, skips edge cases |
| **Self-Review Blindness** | Reviewing own work | Misses obvious issues |

### The Solution: Separation of Concerns

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   ORCHESTRATOR                    WORKERS                   JUDGES          │
│   (Coordinates)                   (Execute)                 (Verify)        │
│                                                                             │
│   ┌───────────┐                  ┌───────────┐            ┌───────────┐    │
│   │           │    context       │           │   output   │           │    │
│   │  feature- │ ───────────────► │  impl-    │ ─────────► │ pessim-   │    │
│   │  orchest- │                  │  executor │            │ istic-    │    │
│   │  rator    │ ◄─────────────── │           │ ◄───────── │ judge     │    │
│   │           │    verdict       │           │   verdict  │           │    │
│   └───────────┘                  └───────────┘            └───────────┘    │
│                                                                             │
│   • Never executes               • Fresh context          • No stake in    │
│   • Prepares context             • Focused task             outcome        │
│   • Makes decisions              • Reports status         • Defaults to    │
│   • Handles retries              • Checklists               pessimism      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Key Principle: Fresh Context Per Task

Each subagent invocation (via the Agent tool with `subagent_type`):
- Starts with **zero conversation history**
- Receives **only what's in the prompt**
- Returns **one response** to the orchestrator
- Has **no knowledge** of previous attempts or other tasks

This eliminates fatigue and bias completely.

### Subagent Invocation: Retry on Transient Failures

Subagent invocations can fail due to transient issues (network timeouts, rate limits, temporary service unavailability). When this happens:

```
ON subagent invocation failure:
  DO NOT assume "subagent must not exist" or fall back to general agent

  INSTEAD:
  1. Retry the same subagent_type with the same prompt (up to 3 attempts)
  2. Wait briefly between retries (exponential backoff: 2s, 4s, 8s)
  3. Only after 3 failed attempts: escalate to user

  NEVER substitute a different subagent type due to transient errors
```

---

## Component Overview

### Orchestrator & Reference Skills (`.claude/skills/`)

| Skill | Type | Purpose |
|-------|------|---------|
| `feature-orchestrator` | Coordinator | Plans and executes feature implementation across fin-app layers |
| `deep-research-orchestrator` | Coordinator | Research → Plan workflow (GnuCash internals, format specs, library choices) |
| `judge-goal` | Reference | Criteria for goal judgment |
| `judge-task` | Reference | Criteria for task judgment |
| `judge-qa` | Reference | Criteria for user-facing QA judgment (app UI, data effects, exports, GnuCash safety) |
| `gnucash-data-model` | Domain | Canonical GnuCash integration reference: backends, data model, write guardrails |
| `tdd` | Supporting | Red-green-refactor workflow; used for parser/writer/query tasks (installed from mattpocock/skills) |
| `tauri-qa-testing` | Supporting | Dev-run + evidence-capture QA workflow after user-facing changes; produces QA evidence |
| `codebase-design`, `setup-ts-deep-modules` | Supporting | Deep-module core/UI separation; wiring dependency-cruiser into the TS workspace |
| `design-an-interface`, `domain-modeling`, `grill-me` | Supporting | Interface design, domain vocabulary, adversarial plan review |
| `dataviz` | Supporting (built-in) | Chart/dashboard design rules for the Goal 04 report UI |

> The `gnucash-data-model` skill is the project's domain knowledge base for GnuCash work. The
> orchestration skills reference it but do not replace it. Supporting skills are routed into
> subagent context packages by `feature-orchestrator` (see its "Supporting-skill routing" section)
> based on which layer a task touches.

### Subagents (shared bodies + IDE wrappers)

Persona prompts live in **`.agents/agents/<name>.md`** (shared, not auto-discovered by either IDE). Thin **IDE wrappers** pin `model:` and instruct the subagent to read the shared body first:

| Wrapper path | IDE | Purpose |
|---|---|---|
| `.cursor/agents/<name>.md` | Cursor | Pins Cursor slugs; wins over `.claude/agents/` on name clash |
| `.claude/agents/<name>.md` | Claude Code | Pins Claude Code slugs |

| Subagent | Behavioral Style | Use Case |
|----------|------------------|----------|
| `pessimistic-judge` | Skeptical, problem-finding | Goal / task / code verification (schema, TS core, Rust commands, UI) |
| `qa-judge` | Skeptical, user-perspective | Behavioral QA of the app UI, data effects, exports, and GnuCash safety |
| `implementation-executor` | Focused, checklist-driven | Implementation + fixes |
| `test-generator` | Coverage-obsessed | Vitest (TS core) and `cargo test` (Rust) suites, fixtures only — never live user data |

**Model routing (required):** On every launch of the four named subagents, orchestrators **must pass** the frozen-table slug for **role + current IDE** (see `CLAUDE.md` or `goals/09-ide-agent-alignment/GOAL.md`). Cursor's Task tool inherits the parent model when `model` is omitted — wrapper `model:` frontmatter is not enough.

| Role | Cursor | Claude Code |
|---|---|---|
| Judges (`pessimistic-judge`, `qa-judge`) | `cursor-grok-4.6-xhigh` | `fable` |
| Coding agents (`implementation-executor`, `test-generator`) | `composer-2.5-fast` | `sonnet` |

**Duplicate-load guard:** Do **not** copy skills into `.agents/skills/` or `.cursor/skills/` — Cursor would discover each `SKILL.md` twice. Skills stay under `.claude/skills/` only. Do not create `.cursor/commands/` or `.claude/commands/`.

---

## Feature Orchestrator Flow

### Complete Lifecycle

```
PHASE 1: ALIGNMENT (Structured Discovery via AskUserQuestion)
══════════════════════════════════════════════════════════

    User Request ──► Stay in conversation ──► AskUserQuestion (batched MCQs)
                                                  │
                                    ┌─────────────┘
                                    │
                     (Follow-up rounds if needed)
                                    │
                                    ▼
    Summarize "My Understanding" ──► User Confirms ──► Phase 2

    IMPORTANT: No files created during this phase.
    Covers: problem, layers touched (schema/TS core/Rust/UI), data-model impact
    (payees/accounts/categories/payments/recurring bills), GnuCash involvement
    (read / QIF export / guarded write), error behavior, UI surface, priority.


PHASE 2: GOAL CREATION (With Decision Gates)
════════════════════════════════════════════

    Create goals/NN-name/ ──► Write GOAL.md
           │
           ▼
    FOR EACH TASK:
    ┌─────────────────────────────────────────────┐
    │ Multiple approaches? ──YES──► Present to   │
    │         │                      user, WAIT  │
    │         NO                          │      │
    │         │◄──────────────────────────┘      │
    │         ▼                                  │
    │   Create tasks/NN-name.md                  │
    └─────────────────────────────────────────────┘


PHASE 3: GOAL JUDGMENT (Mandatory Re-Judge Loop)
════════════════════════════════════════════════

    Orchestrator ──► Agent(pessimistic-judge)
                     (includes Phase 1 Q&A for Discovery Coverage check)
           │
           ▼
    Receive Judgment
           │
    ┌──────┼──────┐
    │      │      │
  PASS  NEEDS   REJECT
    │    REV      │
    │      │      │
    ▼      ▼      ▼
 Phase4  Revise  User
         & re-judge
        (3 max)

    INVARIANT: The ONLY exit to Phase 4 is a PASS verdict
    from the judge subagent. Revisions MUST be re-judged.


PHASE 4: TASK EXECUTION (Mandatory Re-Judge After Every Fix)
════════════════════════════════════════════════════════════

    FOR EACH TASK (in dependency order):

    Step 1: Launch implementation-executor (or test-generator for the test task)
    Step 2: Receive completion report
    Step 3: Launch pessimistic-judge
    Step 4: Handle verdict
            │
    ┌───────┼───────┐
    │       │       │
  PASS   NEEDS    REJECT
    │    FIXES      │
    │       │       │
    ▼       ▼       ▼
  Next   Re-impl  Escalate
  Task   & re-judge to User
        (3 max)

    INVARIANT: A task is only marked complete after the judge
    returns PASS. There is no path where fixes are made and the
    orchestrator proceeds without re-verification.


PHASE 5: FINAL AUDIT (Mandatory Re-Audit Loop)
══════════════════════════════════════════════

    All Tasks Complete
           │
           ▼
    Final pessimistic-judge audit
           │
    ┌──────┴──────┐
    │             │
 APPROVED     ISSUES
    │             │
    ▼             ▼
 Quality Checks  Fix & Re-audit
 (npm test,      (3 max)
  cargo test)

    INVARIANT: The ONLY exit to Quality Checks is an
    APPROVED verdict from the audit subagent. Remediations
    MUST be re-audited.
```

### Execution Order for fin-app

```
SEQUENTIAL: Schema/migrations → TS core (repositories) → Rust commands → UI
                │
                ▼ (implementation complete)
                │
            Tests (Vitest for TS core, cargo test for Rust — fixtures only)
                │
                ▼ (all tests pass)
                │
            Final Audit ──► Quality Checks (npm test, cargo test, lint, clippy)
```

Use only the layers the feature actually touches — most features reuse the core data layer and
add a repository function + UI surface + tests; only importer/GnuCash features add Rust commands.

---

## Deep Research Orchestrator Flow

For topics where building would be guessing — GnuCash schema details, QIF format specifics,
Tauri plugin capabilities, PDF-generation approaches.

```
Phase 1: Generate Research Prompt → _research/prompts/[topic].md
Phase 2: Execute & Ingest Report  → _research/[topic]/report.md  (research subagents w/ web access)
Phase 3: High-Level Plan          → Collaborative planning with the user
Phase 4: Low-Level Tasks          → goals/NN-name/ structure (judged via Phase 3 loop)
```

**Research locations:**
- `docs/RESEARCH.md` — committed stack decision, spreadsheet analysis, GnuCash strategy, prior-art survey. Cite as ground truth.
- `_research/` — working/scratch area for new prompts and raw reports. Promote durable findings into `docs/RESEARCH.md`; findings that contradict it are surfaced to the user, never silently overwritten.

The output of Phase 4 (`goals/NN-name/`) feeds directly into the feature-orchestrator's
Phase 4 execution.

---

## QA Judgment (Optional Behavioral Gate)

User-facing QA is a lightweight, optional gate run with the `qa-judge` subagent after a feature
is implemented and code-judged. It covers **all user-facing surfaces**:
- The **app UI** (dashboard, bill-pay grid, payment entry, import wizard, reports, settings)
- The **data effects** in the fin-app SQLite book (queried directly, not trusted from the UI)
- The **files produced** (PDF / xlsx / CSV / QIF exports — opened and inspected)
- **GnuCash safety** — read flows leave the book byte-identical (hash-compared); write flows
  leave a backup and re-read cleanly

```
Implementation complete (+ tests green)
        │
        ▼
Exercise the affected surface and capture evidence
(workflow: tauri-qa-testing skill):
  ├── App: npm run tauri dev output, screenshots, console/stderr capture
  ├── DB: direct sqlite3 queries confirming UI claims (counts, exact-cent totals)
  ├── Exports: files opened and spot-checked, not trusted from the success toast
  └── GnuCash: before/after file hashes (reads), backup + re-read (writes)
        │
        ▼
Agent(qa-judge) ──► Verdict
        │
  ┌─────┼─────┐
PASS  ISSUES  REJECT
  │     │       │
  ▼     ▼       ▼
Done  Create  Escalate
      fix tasks → implementation-executor → pessimistic-judge → re-run QA
```

QA never fixes issues — it finds them. Fixes flow back through the standard
implementation-executor + pessimistic-judge loop, then QA re-runs.

---

## Subagent Communication Protocol

### Context Package Structure

Every subagent invocation requires a complete context package:

```
┌─────────────────────────────────────────────────────────────────┐
│  SECTION 1: ROLE ASSIGNMENT                                      │
│  Agent tool with subagent_type: [subagent-name]                 │
│  Persona: .agents/agents/[subagent-name].md (read by wrapper)   │
│  model: frozen-table slug for role + current IDE (required)     │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 2: TASK DEFINITION                                      │
│  "## Task"                                                       │
│  "[Clear description of what to accomplish]"                    │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 3: INPUT DATA                                          │
│  "## Requirements" (exhaustive list)                            │
│  "## Files to Read" (explicit paths: task file, source files)   │
│  "## Domain Reference" (gnucash-data-model / RESEARCH.md        │
│   excerpts when the task touches those areas)                   │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 4: CONSTRAINTS                                         │
│  "## Rules" or "## Critical Requirements"                       │
│  - Must do X (e.g. integer cents, SQL only in core layer)       │
│  - Must NOT do Y (e.g. touch GnuCash slots/versions, test       │
│    against the user's real book, float money math)              │
├─────────────────────────────────────────────────────────────────┤
│  SECTION 5: OUTPUT FORMAT                                       │
│  "## Output"                                                    │
│  "[Exact structure expected in response]"                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Judgment & Retry Mechanisms

### Retry Limits by Phase

| Phase | Max Cycles | On Exhaust |
|-------|------------|------------|
| Goal Judgment (Phase 3) | 3 revise→re-judge | Escalate to user |
| Task Execution (Phase 4) | 3 implement→judge per task | Escalate to user |
| Final Audit (Phase 5) | 3 fix→re-audit | Escalate to user |
| QA Gate (optional) | bounded by runtime; fixes loop through impl+judge | Escalate if unresolved |

### Mandatory Re-Judge Invariants

- **Phase 3**: Goal judgment loop ONLY exits to Phase 4 via a PASS verdict. Revisions without re-judge are forbidden.
- **Phase 4**: A task is ONLY marked complete after the judge returns PASS. Fixes without re-judge are forbidden.
- **Phase 5**: Audit loop ONLY exits to Quality Checks via an APPROVED verdict. Remediations without re-audit are forbidden.

### Escalation Format

```markdown
## Escalation Required

**Phase**: [current phase]
**Issue**: [what went wrong]
**Attempts**: [what was tried]

**Options**:
1. [option with tradeoffs]
2. [option with tradeoffs]

**What I need from you**: [specific decision or input]
```

---

## Quick Reference

### File Locations

```
.agents/
└── agents/                         # Shared subagent persona bodies (not auto-discovered)
    ├── pessimistic-judge.md
    ├── qa-judge.md
    ├── implementation-executor.md
    └── test-generator.md

.cursor/
├── agents/                         # Cursor wrappers (model: + read shared body)
│   ├── pessimistic-judge.md
│   ├── qa-judge.md
│   ├── implementation-executor.md
│   └── test-generator.md
└── rules/                          # Cursor alwaysApply + glob-scoped rules (model routing)

.claude/
├── agents/                         # Claude Code wrappers (model: + read shared body)
│   ├── pessimistic-judge.md
│   ├── qa-judge.md
│   ├── implementation-executor.md
│   └── test-generator.md
│
├── skills/
│   ├── feature-orchestrator/       # Feature coordination
│   │   ├── SKILL.md
│   │   └── templates/{goal.md,task.md}
│   │
│   ├── deep-research-orchestrator/ # Research → Plan
│   │   ├── SKILL.md
│   │   └── templates/{research-prompt.md,research-report.md}
│   │
│   ├── judge-goal/SKILL.md         # Goal judgment criteria
│   ├── judge-task/SKILL.md         # Task judgment criteria
│   ├── judge-qa/SKILL.md           # User-facing QA judgment criteria
│   │
│   ├── gnucash-data-model/SKILL.md # Canonical GnuCash domain skill (guardrails, schema, tiers)
│   ├── tauri-qa-testing/SKILL.md   # Dev-run + evidence-capture QA workflow
│   │
│   └── (installed from mattpocock/skills:)
│       tdd/  codebase-design/  setup-ts-deep-modules/  design-an-interface/
│       domain-modeling/  diagnosing-bugs/  qa/  implement/  grill-me/

CLAUDE.md                           # Project instructions, frozen model table, duplicate-load guard

docs/
├── RESEARCH.md                     # Ground-truth research & decisions
└── ORCHESTRATION-ARCHITECTURE.md   # This file

goals/                              # Goal/task structure (see goals/README.md)
_research/                          # Scratch research area (prompts + raw reports)
```

### Critical Reference Files

| File | Purpose | When to Include |
|------|---------|-----------------|
| `.claude/skills/gnucash-data-model/SKILL.md` | GnuCash backends, data model, write guardrails | Any task touching GnuCash files (mandatory) |
| `docs/RESEARCH.md` | Stack decision, spreadsheet analysis (§2), data model (§5), GnuCash strategy (§4) | Goal creation; importer, schema, and GnuCash work |
| `goals/README.md` | Goal index, dependency table, status convention | Orchestration planning |
| `goals/NN-*/GOAL.md` + `tasks/` | The contract for each feature | Every executor/judge context package |
| `.claude/skills/tdd/SKILL.md` | Red-green-refactor conventions | Parser, writer, and query tasks |
| `.claude/skills/tauri-qa-testing/SKILL.md` | Evidence-capture QA workflow | After user-facing changes |
| `dataviz` skill (built-in) | Chart design rules | Goal 04 report UI tasks |

### Quality Checks

The TS workspace uses Vitest via npm; the Rust side lives in `src-tauri/` (once Goal 01 Task 1
scaffolds it). Quality checks are:

| Step | Command |
|------|---------|
| TS core tests | `npm test` |
| Rust tests | `cargo test` (from `src-tauri/`) |
| Lint | `npm run lint` |
| Rust lint | `cargo clippy -- -D warnings` (from `src-tauri/`) |
| Format check | `cargo fmt --check`; Prettier via lint config |
| QA evidence (only after user-facing changes) | workflow in `.claude/skills/tauri-qa-testing/SKILL.md` |

Don't invent commands for tools that aren't configured yet — until Goal 01 lands, none of these
exist. Tests must never touch the user's real book, real GnuCash file, or write to the real xlsx —
fixtures and temp dirs only.

### Common Commands

**Setup (after Goal 01 scaffolding):**
```bash
npm install          # JS deps; Rust deps resolve on first build
```

**Run the app:**
```bash
npm run tauri dev    # dev window with hot reload
npm run tauri build  # production bundle
```

**Linux Snap runtime note (VS Code / Code Insiders):**

If `npm run tauri dev` fails with a symbol lookup error involving
`/snap/core20/.../libpthread.so.0` and `__libc_pthread_init`, run:

```bash
env -u GTK_PATH -u GTK_EXE_PREFIX -u GTK_IM_MODULE_FILE npm run tauri dev
```

This avoids Snap GTK module path injection that can pull in incompatible runtime
libraries for the host `glibc`.

**Tests:**
```bash
npm test                      # Vitest (TS core)
cd src-tauri && cargo test    # Rust (cell parser, GnuCash modules)
```

### Invoking Skills

```
/feature-orchestrator        - Start a new feature implementation
/deep-research-orchestrator  - Research → Plan workflow for an uncertain topic
```

The judge skills (`judge-goal`, `judge-task`, `judge-qa`) are reference criteria used by the
judge subagents — they are not invoked directly. `gnucash-data-model` is a domain reference
included in context packages (and readable by anyone).

### Subagent Behaviors

| Subagent | Default Stance | Key Behavior | Auto-Fail Triggers |
|----------|----------------|--------------|-------------------|
| `pessimistic-judge` | Score starts at 2/5 | Actively looks for code problems | Float money math, missing GnuCash guardrail, silent import drops, SQL in UI, tests on real user data, unmet acceptance criteria, weakened tests |
| `qa-judge` | Score starts at 2/5 | User-perspective behavioral QA (app, DB, exports) | Crash/white screen, wrong totals, data loss on restart, silent drops, GnuCash file mutated by a read, success-without-effect, raw tracebacks in UI |
| `implementation-executor` | Must complete ALL | Checklist-driven execution | Skipping requirements |
| `test-generator` | Full coverage of scope | Outcome-verifying tests | Untested public functions, live user data, approximate money assertions |

### Workflow State Tracking

The orchestrator maintains this state throughout execution:

```markdown
## Orchestration Progress: [Goal Name]

### Phase 1: Alignment (structured discovery — no files created)
- [ ] Discovery questions asked via AskUserQuestion
- [ ] Follow-up questions asked (if needed)
- [ ] Summary presented to user
- [ ] User confirmed understanding ("yes, proceed")

### Phase 2: Goal Creation
- [ ] GOAL.md created (goals/NN-name/)
- [ ] Decision gates passed (or user decided)
- [ ] Task files created

### Phase 3: Goal Judgment (must loop until PASS)
- [ ] Judge subagent invoked (attempt 1)
- [ ] Verdict: [PASS/NEEDS REVISION/REJECT]
- [ ] Final verdict that allowed progression: PASS

### Phase 4: Execution (each task must loop judge until PASS)
| Task | Cycle 1 | Cycle 2 | Cycle 3 | Final Verdict |
|------|---------|---------|---------|---------------|
| 01-schema-migration | ⬜ | - | - | ⬜ |
| 02-core-repository | ⬜ | - | - | ⬜ |
| 03-rust-command | ⬜ | - | - | ⬜ |
| 04-ui-surface | ⬜ | - | - | ⬜ |
| 05-tests | ⬜ | - | - | ⬜ |

### Phase 5: Final Audit (must loop until APPROVED)
- [ ] Audit subagent invoked (attempt 1)
- [ ] Verdict: [APPROVED/ISSUES FOUND]
- [ ] Final verdict that allowed progression: APPROVED
- [ ] Quality checks (npm test, cargo test, lint, clippy) passed
```

---

## Summary

1. **Orchestrators coordinate, never execute** — they prepare context and make decisions
2. **Subagents execute with fresh context** — no fatigue, no bias
3. **Judgment is always separate** — pessimistic judges review all work (code AND behavior)
4. **Re-judge is mandatory** — fixes/revisions MUST be re-verified by a judge subagent
5. **Retries have limits (3 cycles)** — prevents infinite loops, forces escalation
6. **Escalation is explicit** — user gets clear options and required decisions
7. **Money is exact** — integer cents in fin-app, rationals in GnuCash; floats are an auto-fail
8. **The core is deep** — all SQL and domain logic in the TS core layer; UI stays thin; GnuCash access only through the guarded Rust modules
9. **Tests never touch live user data** — the real book, the real GnuCash file, and the real xlsx are off-limits; fixtures and temp dirs only
