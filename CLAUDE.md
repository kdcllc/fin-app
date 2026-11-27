# fin-app — project instructions

fin-app is a Tauri 2.x cross-platform desktop personal-finance app: React and TypeScript for the UI, a TypeScript core data-access layer over SQLite (app-owned `rusqlite` backend in `src-tauri/src/db.rs`), and Rust commands for xlsx parsing (`calamine`) and GnuCash file access.

## Non-negotiables

1. **Integer cents** — money is stored and computed as integer cents in application code; never use floats for money.
2. **SQL only in core** — all SQL lives in the core data-access layer; UI components never issue queries.
3. **GnuCash access** — any GnuCash file access follows `.claude/skills/gnucash-data-model/SKILL.md` (read-only connections for reads; lock/version/backup discipline for writes; never touch `slots`/`versions`).
4. **Fixtures and temp dirs only** — tests use fixtures and temporary directories; never the user's real book, real GnuCash file, or real xlsx for writes.
5. **Importers never silently drop cells** — every input cell is parsed or surfaced as unparsed; importers must not silently discard data.

## Orchestration

Feature work runs through the orchestrator/worker/evaluator system — see
`.claude/ORCHESTRATION.md`. Start features with `/feature`; research-first topics with
`/research`.

The orchestration kit (`ai-orchestration` v0.19.0, manifest:
`orchestration-kit.manifest.json`) is installed for both harnesses:

- **Claude Code**: `.claude/agents/` (`evaluator`, `qa-evaluator`, `implementer`,
  `test-writer`, `terminal`), the orchestration skills under `.claude/skills/`
  (`feature`, `research`, `goal-criteria`, `task-criteria`, `qa-criteria`,
  `test-ladder`, `align-docs`, `ship-pr`, `auto-loop`), and `.claude/ORCHESTRATION.md`.
- **Cursor**: self-contained copies under `.cursor/agents/`, `.cursor/skills/`, and
  `.cursor/ORCHESTRATION.md` (`.cursor/` wins name conflicts when Cursor reads both
  trees).

**Model tiers** are configuration with a single source:
`.claude/skills/setup-models.map.md` (reference copy at
`.cursor/skills/setup-models.map.md`).

| Tier | Roles | Claude Code | Cursor |
|------|-------|-------------|--------|
| frontier | orchestrator (main session), `evaluator`, `qa-evaluator` | `fable` | `cursor-grok-4.6-xhigh` |
| light | `implementer`, `test-writer`, `terminal` | `sonnet` | `composer-2.5-fast` |

Re-run `/setup` to upgrade the kit or re-pin models when providers rotate names.

**Autonomous loop** (optional, installed): `_loop/loop.sh` / `pwsh _loop/loop.ps1`
drive one `auto-loop` iteration per story from `_goals/backlog.md`. The loop never
pushes; `_goals/breaker-state.json` is gitignored runtime scratch; the loop may not
modify `_loop/`, kit agents/skills, the manifest, or `.gitattributes`.

## Skill layout

- **Domain and supporting skills** (`gnucash-data-model`, `tauri-qa-testing`, `tdd`,
  `codebase-design`, …) keep a single canonical copy in `.claude/skills/` — Cursor
  loads that tree natively. Do not duplicate them into `.cursor/skills/`.
- **Orchestration skills and agents** are kit-emitted per harness (both `.claude/` and
  `.cursor/` copies) and managed by `/setup` — edit the kit templates or re-run
  `/setup` rather than hand-editing emitted copies.
- Do **not** add `AGENTS.md` at the repo root (Cursor would load it alongside this
  file).
- The legacy `goals/` directory is a pre-kit historical archive — read-only. New goals
  go to `_goals/`.
