# Task 09.2 — CLAUDE.md, Cursor rules, and `.agents` map

Status: done

## Objective

Always-on project instructions live in one `CLAUDE.md`. Cursor glob rules add file-type detail. `.agents/README.md` is the map of what each IDE actually loads and why skills are not copied.

## Notes

- Layer(s) touched: tooling (instruction markdown). Depends on: 09.1 (agent layout should already exist so the README can describe it accurately).
- **No `AGENTS.md`.** Cursor reads `CLAUDE.md` for Claude compatibility; a second always-on file would double-load.
- `CLAUDE.md` (repo root) must include:
  1. One-paragraph stack: Tauri 2.x, React/TypeScript UI, TypeScript core over SQLite, Rust for xlsx/GnuCash.
  2. These five non-negotiables, named explicitly: integer cents (never floats); SQL only in the core data-access layer; GnuCash access follows `.claude/skills/gnucash-data-model/SKILL.md`; tests use fixtures/temp dirs only — never the user’s real book, real GnuCash file, or real xlsx for writes; importers never silently drop cells.
  3. The **frozen model table** from `goals/09-ide-agent-alignment/GOAL.md` (both IDE columns).
  4. Pointers: skills in `.claude/skills/`; shared agent bodies in `.agents/agents/`; Claude wrappers in `.claude/agents/`; Cursor wrappers in `.cursor/agents/`.
  5. Duplicate-load guard: do not add `.agents/skills/` or `.cursor/skills/`. Do not add `.cursor/commands/` or `.claude/commands/`. Do not symlink `.claude/skills`.
  6. Claude Code parent-session hint (required in the file, not optional): run orchestrator/judge sessions on `fable`; coding sessions on `sonnet`. Also state that orchestrators must pass the frozen-table slug on every named-subagent launch (wrapper `model:` is not enough when the Task tool inherits the parent).
- `.cursor/rules/model-routing.mdc`: `alwaysApply: true`. States Cursor slugs (`cursor-grok-4.6-xhigh` for orchestrators/judges, `composer-2.5-fast` for coding agents/skills), tells the agent to pass that slug when launching the four named subagents, and repeats the duplicate-load guard. Must not restate the five non-negotiables essay — that belongs in `CLAUDE.md`.
- Additional `.cursor/rules/*.mdc` files, each `alwaysApply: false` with globs (keep each file short, one concern):
  - TypeScript/UI (`**/*.{ts,tsx}`): UI components never issue SQL; money is integer cents.
  - Rust (`src-tauri/**/*.rs`): GnuCash paths follow the gnucash-data-model skill; no float money.
  - Tests (`**/*.{test,spec}.{ts,tsx}` and `src-tauri/**/*test*`): fixtures and temp dirs only.
- `.agents/README.md` must document, in a table (this table is required, not optional):
  - Cursor reads: `.claude/skills/`, `.cursor/agents/` (wins on name clash), `.claude/agents/`, `CLAUDE.md`, `.cursor/rules/`.
  - Claude Code reads: `.claude/skills/`, `.claude/agents/`, `CLAUDE.md`, `.claude/rules/` (if present — this goal does not require creating `.claude/rules/`).
  - `.agents/agents/` is **not** auto-loaded; it is the shared prompt source for wrappers.
  - Why `.agents/skills/` is absent (Cursor duplicate discovery).
- Do not create `.agents/skills/`, `.cursor/skills/`, `.cursor/commands/`, or `.claude/commands/`.
- Do not symlink `.claude/skills`.
- Do not modify application source.

## Acceptance criteria

- `CLAUDE.md` exists at the repo root and contains: the frozen model table with both Cursor and Claude columns; all five non-negotiables (cents, SQL-in-core, GnuCash skill pointer, fixtures-only tests, no silent drop); the Claude parent-session hint (`fable` for orchestrator/judge sessions, `sonnet` for coding sessions); a sentence that named-subagent launches must pass the frozen-table slug; **and** the duplicate-load guard (do not create `.agents/skills/`, `.cursor/skills/`, `.cursor/commands/`, or `.claude/commands/`; do not symlink `.claude/skills`).
- No `AGENTS.md` file exists at the repo root.
- `.cursor/rules/model-routing.mdc` has `alwaysApply: true` and names `cursor-grok-4.6-xhigh` and `composer-2.5-fast`, and tells the agent to pass those slugs when launching named subagents.
- At least three glob-scoped `.cursor/rules/*.mdc` files exist covering TS/UI, Rust, and tests as specified; none of them set `alwaysApply: true`; none of them paste the full `CLAUDE.md` (no frozen model table, no five-non-negotiable essay — file-type detail only).
- `.agents/README.md` contains a per-IDE load table covering Cursor, Claude Code, and `.agents/agents/` (not a discovery path), and states that `.agents/skills/` / `.cursor/skills/` / command trees must not be created.
- Glob: no `.agents/skills/**`, no `.cursor/skills/**`, no `.cursor/commands/**`, no `.claude/commands/**`. `.claude/skills` is not a symlink.
- `CLAUDE.md` and `.agents/README.md` describe the four wrappers from task 09.1 (paths match the repo).
