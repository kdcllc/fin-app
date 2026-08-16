# Goal 09 — Cursor / Claude Code agent alignment

**Milestone:** DX · **Depends on:** none

## Objective

A developer opening this repo in **Cursor** or **Claude Code** uses the same project skills and the same four subagent personas, with **per-IDE model pins**, and without Cursor loading the same `SKILL.md` twice. The app’s schema, TypeScript core, Rust commands, and UI are unchanged.

## Frozen model table (2026-08-16)

| Role | Cursor | Claude Code |
|---|---|---|
| Orchestrators (`feature-orchestrator`, `deep-research-orchestrator`) | `cursor-grok-4.6-xhigh` | `fable` |
| Judges (`pessimistic-judge`, `qa-judge`, `judge-*` skills) | `cursor-grok-4.6-xhigh` | `fable` |
| Coding agents (`implementation-executor`, `test-generator`) | `composer-2.5-fast` | `sonnet` |
| Coding skills (`tdd`, `implement`, `codebase-design`, …) | `composer-2.5-fast` | `sonnet` |
| Domain reference (`gnucash-data-model`) | no pin | no pin |

Supporting skills not named in the table inherit the **parent session** model. Slash commands are the existing skills (`/feature-orchestrator`, etc.) — no parallel `.cursor/commands/` or `.claude/commands/` tree.

**Runtime pin (required):** Cursor’s Task tool inherits the parent model when `model` is omitted. Wrapper `model:` frontmatter is not enough. Orchestrator skills must pass the frozen-table slug for **role + current IDE** on every launch of the four named subagents.

## Why this layout (Phase 1)

- Cursor already auto-loads `.claude/skills/` and `.claude/agents/`. Claude Code does **not** auto-load `.agents/`.
- Copying the same `SKILL.md` into both `.agents/skills/` and `.claude/skills/` makes Cursor discover each skill twice.
- Cursor slugs (`cursor-grok-4.6-xhigh`, `composer-2.5-fast`) are not Claude Code aliases (`fable`, `sonnet`), so **one agent file cannot pin both IDEs**. Cursor prefers `.cursor/agents/` over `.claude/agents/` when names match.
- Shared prompt bodies therefore live in `.agents/agents/` (not a discovery path). IDE folders hold **thin wrappers** that pin `model:` and instruct the subagent to read the shared body first.

## Constraints

- **Do not** create `.agents/skills/` or `.cursor/skills/` (duplicate-load guard).
- **Do not** symlink `.claude/skills` to anything; skills stay as real files under `.claude/skills/`.
- **Do not** add `AGENTS.md` (Cursor would load it plus `CLAUDE.md`).
- **Do not** create `.cursor/commands/` or `.claude/commands/`.
- **Do not** set `readonly: true` on Cursor judge wrappers — judges must still be able to run Shell (`npm test`, `cargo test`) to verify.
- **Do not** change application code, schema, tests, or GnuCash modules.
- Preserve existing agent prompt text when relocating it; do not “improve” personas. Wrappers must not paste the full persona (no auto-fail lists, no verdict templates).
- No parser/writer/query work — **no test task**. Verification is file-layout inspection, not `npm test` / `cargo test` (those gates still must not be broken; this goal must not touch them).
- GnuCash: out of scope except leaving existing skill/agent pointers at `.claude/skills/gnucash-data-model/SKILL.md`.

## Success criteria

- Four shared bodies exist at `.agents/agents/{implementation-executor,pessimistic-judge,qa-judge,test-generator}.md` and contain **no** `model:` or `tools:` field. YAML `name:` on each shared body and each wrapper is exactly that registered `subagent_type` string.
- `.claude/agents/` has four wrappers pinning `fable` (judges) and `sonnet` (coding agents); judge wrappers keep a Claude `tools:` allowlist. Wrappers do not contain the full persona (no auto-fail lists, verdict/completion templates, or operating-rules checklists).
- `.cursor/agents/` has four wrappers pinning `cursor-grok-4.6-xhigh` (judges) and `composer-2.5-fast` (coding agents). No `readonly: true`. Wrappers do not contain the full persona.
- Each wrapper’s body requires reading its `.agents/agents/<name>.md` file before doing work.
- `CLAUDE.md` exists at repo root, includes the frozen table, the Claude parent-session hint (`fable` vs `sonnet`), the five non-negotiables (integer cents; SQL only in core; GnuCash follows `.claude/skills/gnucash-data-model/SKILL.md`; fixtures-only tests; importers never silently drop cells), **and** the duplicate-load guard.
- `.cursor/rules/` includes an `alwaysApply` model-routing rule for Cursor slugs and glob-scoped rules that add file-type detail (not a second copy of `CLAUDE.md`).
- `.agents/README.md` has a per-IDE load table (what Cursor reads vs what Claude Code reads vs `.agents/agents/` not discovered) and states the duplicate-load guard.
- `docs/ORCHESTRATION-ARCHITECTURE.md` describes this layout: file tree **and** subagent invocation (bodies in `.agents/agents/`, `model:` on wrappers, orchestrators pass explicit slugs). `goals/README.md` lists this goal.
- `feature-orchestrator` and `deep-research-orchestrator` skills require passing the frozen-table slug for role + current IDE on every named-subagent launch (no “if the tool requires it” hedge; no N/A escape).
- No `.agents/skills/`, `.cursor/skills/`, `.cursor/commands/`, or `.claude/commands/` directories exist. `.claude/skills` is not a symlink.

## Tasks

1. [Shared agent bodies and IDE wrappers](tasks/01-agent-bodies-and-wrappers.md)
2. [CLAUDE.md, Cursor rules, and `.agents` map](tasks/02-instructions-and-map.md)
3. [Orchestration docs and skill routing notes](tasks/03-docs.md)
