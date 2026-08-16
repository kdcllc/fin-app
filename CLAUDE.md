# fin-app — project instructions

fin-app is a Tauri 2.x cross-platform desktop personal-finance app: React and TypeScript for the UI, a TypeScript core data-access layer over SQLite (`tauri-plugin-sql`), and Rust commands for xlsx parsing (`calamine`) and GnuCash file access.

## Non-negotiables

1. **Integer cents** — money is stored and computed as integer cents in application code; never use floats for money.
2. **SQL only in core** — all SQL lives in the core data-access layer; UI components never issue queries.
3. **GnuCash access** — any GnuCash file access follows `.claude/skills/gnucash-data-model/SKILL.md` (read-only connections for reads; lock/version/backup discipline for writes; never touch `slots`/`versions`).
4. **Fixtures and temp dirs only** — tests use fixtures and temporary directories; never the user's real book, real GnuCash file, or real xlsx for writes.
5. **Importers never silently drop cells** — every input cell is parsed or surfaced as unparsed; importers must not silently discard data.

## Frozen model table (2026-08-16)

| Role | Cursor | Claude Code |
|---|---|---|
| Orchestrators (`feature-orchestrator`, `deep-research-orchestrator`) | `cursor-grok-4.6-xhigh` | `fable` |
| Judges (`pessimistic-judge`, `qa-judge`, `judge-*` skills) | `cursor-grok-4.6-xhigh` | `fable` |
| Coding agents (`implementation-executor`, `test-generator`) | `composer-2.5-fast` | `sonnet` |
| Coding skills (`tdd`, `implement`, `codebase-design`, …) | `composer-2.5-fast` | `sonnet` |
| Domain reference (`gnucash-data-model`) | no pin | no pin |

Supporting skills not named in the table inherit the **parent session** model. Slash commands are the existing skills (`/feature-orchestrator`, etc.) — no parallel command tree.

**Claude Code parent sessions:** run orchestrator and judge sessions on `fable`; run coding sessions on `sonnet`.

**Named-subagent launches:** orchestrators must pass the frozen-table slug for **role + current IDE** on every launch of the four named subagents (`implementation-executor`, `pessimistic-judge`, `qa-judge`, `test-generator`). Wrapper `model:` frontmatter is not enough when the Task tool inherits the parent model.

## Agent and skill layout

- **Skills:** `.claude/skills/` (canonical skill definitions)
- **Shared agent bodies:** `.agents/agents/` (full persona text; not auto-loaded by either IDE)
- **Claude Code wrappers:** `.claude/agents/` (thin wrappers pinning Claude models)
- **Cursor wrappers:** `.cursor/agents/` (thin wrappers pinning Cursor models; wins over `.claude/agents/` on name clash)

The four named subagents:

| Subagent | Shared body | Claude wrapper | Cursor wrapper |
|---|---|---|---|
| `implementation-executor` | `.agents/agents/implementation-executor.md` | `.claude/agents/implementation-executor.md` | `.cursor/agents/implementation-executor.md` |
| `pessimistic-judge` | `.agents/agents/pessimistic-judge.md` | `.claude/agents/pessimistic-judge.md` | `.cursor/agents/pessimistic-judge.md` |
| `qa-judge` | `.agents/agents/qa-judge.md` | `.claude/agents/qa-judge.md` | `.cursor/agents/qa-judge.md` |
| `test-generator` | `.agents/agents/test-generator.md` | `.claude/agents/test-generator.md` | `.cursor/agents/test-generator.md` |

Each wrapper instructs the subagent to read its shared body in `.agents/agents/` before doing work.

## Duplicate-load guard

Do **not** create:

- `.agents/skills/` or `.cursor/skills/` (Cursor would discover the same `SKILL.md` twice)
- `.cursor/commands/` or `.claude/commands/` (use existing skills as slash commands instead)

Do **not** symlink `.claude/skills` — skills stay as real files under `.claude/skills/`.

Do **not** add `AGENTS.md` at the repo root (Cursor would load it alongside this file).

See `.agents/README.md` for the per-IDE load map.
