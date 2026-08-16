# Task 09.1 — Shared agent bodies and IDE wrappers

Status: done

## Objective

The four fin-app subagent personas live as **shared prompt bodies** under `.agents/agents/` (not auto-discovered). Claude Code and Cursor each have a **thin wrapper** that pins that IDE’s model and tells the subagent to read the shared body first.

## Notes

- Layer(s) touched: tooling (markdown agent definitions only). Depends on: none.
- Source files to relocate (preserve wording; do not rewrite personas):
  - `.claude/agents/implementation-executor.md`
  - `.claude/agents/pessimistic-judge.md`
  - `.claude/agents/qa-judge.md`
  - `.claude/agents/test-generator.md`
- Shared body path: `.agents/agents/<name>.md` with YAML `name` + `description` only — **no** `model:`, **no** `tools:`, **no** Cursor `readonly:`.
- After the move, `.claude/agents/<name>.md` must be the Claude wrapper, not a second full copy of the prompt.
- Claude wrapper frontmatter:
  - Judges (`pessimistic-judge`, `qa-judge`): `model: fable`, keep existing `tools:` allowlist (`Read, Grep, Glob, Bash`).
  - Coding (`implementation-executor`, `test-generator`): `model: sonnet` (no `tools:` unless the original file had one — originals do not).
- Cursor wrapper path: `.cursor/agents/<name>.md` (flat files only — Cursor recursively treats nested markdown with frontmatter as extra subagents).
  - Judges: `model: cursor-grok-4.6-xhigh`. **Do not** set `readonly: true` (judges must still run Shell to re-run tests).
  - Coding: `model: composer-2.5-fast`.
- Wrapper body (both IDEs): keep `name`/`description` in sync with the shared file. Instruct: read `.agents/agents/<name>.md` immediately and follow it as the full operating rules; do not start the task until that file is read. Do **not** paste the full persona prompt into the wrapper — no auto-fail lists, no verdict/completion-report templates, no operating-rules checklists. Those exist only in `.agents/agents/`.
- Do not create `.agents/skills/`, `.cursor/skills/`, `.cursor/commands/`, or `.claude/commands/`.
- Do not symlink `.claude/skills`.
- Do not edit `.claude/skills/` in this task.
- Paths inside shared bodies that mention `.claude/skills/...` stay as-is.

## Acceptance criteria

- `.agents/agents/` contains exactly these four `*.md` files: `implementation-executor.md`, `pessimistic-judge.md`, `qa-judge.md`, `test-generator.md`.
- Each of those four shared bodies **and** each of the eight wrappers has YAML `name:` exactly equal to its filename stem (`implementation-executor` | `pessimistic-judge` | `qa-judge` | `test-generator`) — the same strings used as `subagent_type`.
- None of the four shared bodies contain a `model:` or `tools:` frontmatter field (grep).
- Each shared body still contains the original operating rules / verdict formats from the pre-move `.claude/agents/` files (same checklists and auto-fail lists, not a summary).
- `.claude/agents/` contains four wrappers; `model:` is `fable` on the two judges and `sonnet` on the two coding agents; judge wrappers still declare `tools: Read, Grep, Glob, Bash`.
- `.cursor/agents/` contains four wrappers; `model:` is `cursor-grok-4.6-xhigh` on the two judges and `composer-2.5-fast` on the two coding agents; **no** wrapper sets `readonly: true`.
- Every wrapper (8 files) names `.agents/agents/<matching-name>.md` and requires reading it before work.
- No wrapper contains the persona’s auto-fail list, verdict template, completion-report template, **or** operating-rules checklist (those strings appear only under `.agents/agents/`).
- No `.cursor/agents/**/*.md` files exist except the four top-level wrappers (no nested docs).
- No `.agents/skills/`, `.cursor/skills/`, `.cursor/commands/`, or `.claude/commands/` directory exists. `.claude/skills` is a real directory, not a symlink.
- No application source under `src/`, `src-tauri/`, or test trees is modified.
