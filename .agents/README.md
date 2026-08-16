# fin-app agent layout

This directory holds **shared agent prompt bodies** and documentation for how Cursor and Claude Code discover project skills and subagents.

## What each IDE loads

| Path | Cursor | Claude Code | Notes |
|---|---|---|---|
| `.claude/skills/` | auto-loaded | auto-loaded | Canonical skill definitions (single copy) |
| `.cursor/agents/` | auto-loaded | — | Cursor wrappers; **wins over** `.claude/agents/` on name clash |
| `.claude/agents/` | auto-loaded | auto-loaded | Claude Code wrappers (also loaded by Cursor) |
| `CLAUDE.md` | auto-loaded | auto-loaded | Always-on project instructions |
| `.cursor/rules/` | auto-loaded | — | Cursor glob and always-on rules |
| `.claude/rules/` | — | auto-loaded (if present) | Not created by this repo layout |
| `.agents/agents/` | **not** auto-loaded | **not** auto-loaded | Shared prompt source; wrappers point here |

## Why `.agents/skills/` is absent

Cursor already auto-loads `.claude/skills/`. Copying the same `SKILL.md` files into `.agents/skills/` (or `.cursor/skills/`) would make Cursor discover each skill twice. Skills therefore live only under `.claude/skills/`.

## Shared bodies and IDE wrappers

Full subagent personas live in `.agents/agents/`. IDE-specific folders hold thin wrappers that pin `model:` and instruct the subagent to read the shared body first.

| Subagent | Shared body | Claude wrapper | Cursor wrapper |
|---|---|---|---|
| `implementation-executor` | `.agents/agents/implementation-executor.md` | `.claude/agents/implementation-executor.md` (`sonnet`) | `.cursor/agents/implementation-executor.md` (`composer-2.5-fast`) |
| `pessimistic-judge` | `.agents/agents/pessimistic-judge.md` | `.claude/agents/pessimistic-judge.md` (`fable`) | `.cursor/agents/pessimistic-judge.md` (`cursor-grok-4.6-xhigh`) |
| `qa-judge` | `.agents/agents/qa-judge.md` | `.claude/agents/qa-judge.md` (`fable`) | `.cursor/agents/qa-judge.md` (`cursor-grok-4.6-xhigh`) |
| `test-generator` | `.agents/agents/test-generator.md` | `.claude/agents/test-generator.md` (`sonnet`) | `.cursor/agents/test-generator.md` (`composer-2.5-fast`) |

## Do not create

- `.agents/skills/` or `.cursor/skills/` (duplicate skill discovery in Cursor)
- `.cursor/commands/` or `.claude/commands/` (use existing skills as slash commands)
- Symlinks of `.claude/skills`
- `AGENTS.md` at repo root (would double-load with `CLAUDE.md`)
