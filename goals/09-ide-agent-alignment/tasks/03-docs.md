# Task 09.3 — Orchestration docs and skill routing notes

Status: done

## Objective

Project docs and both orchestrator skills describe the dual-IDE layout and **require** passing the frozen-table model slug on every launch of the four named subagents (Cursor Task inherits the parent model when `model` is omitted).

## Notes

- Layer(s) touched: docs + orchestrator skill text. Depends on: 09.1, 09.2.
- Update `docs/ORCHESTRATION-ARCHITECTURE.md`:
  - File-locations tree: add `.agents/agents/` (shared bodies), `.cursor/agents/` (Cursor wrappers), `CLAUDE.md`, `.cursor/rules/`; keep `.claude/skills/` and `.claude/agents/` (wrappers).
  - Subagent / invocation sections: the persona prompt is `.agents/agents/<name>.md`. `model:` lives on the IDE wrapper. Orchestrators **must pass** the frozen-table slug for role + current IDE; do not say the full persona “loads automatically” from `.claude/agents/` alone.
  - Duplicate-load guard: do not copy skills into `.agents/skills/` or `.cursor/skills/`. Point at `CLAUDE.md` or `goals/09-ide-agent-alignment/GOAL.md` for the frozen table — do not invent a third conflicting table. If a table is inlined, slugs must match the goal exactly.
- Update `goals/README.md`: add goal 09 to the index (DX milestone, depends on none).
- Update `.claude/skills/feature-orchestrator/SKILL.md` **and** `.claude/skills/deep-research-orchestrator/SKILL.md` (the latter launches `pessimistic-judge` in Phase 4 — there is no N/A escape):
  - Launch subagents by registered name: `pessimistic-judge`, `implementation-executor`, `qa-judge`, `test-generator`.
  - **Mandatory model argument** on every such launch (both slugs in the shared skill, IDE-conditional):
    - Cursor: judges/orchestrator-side → `cursor-grok-4.6-xhigh`; coding agents → `composer-2.5-fast`.
    - Claude Code: judges/orchestrator-side → `fable`; coding agents → `sonnet`.
  - Do not hedge with “if the tool requires it” or “model is only on the wrapper.”
  - Do not rewrite the orchestration phases or judgment invariants.
- Leave supporting-skill paths as `.claude/skills/...` (skills did not move).
- Do not create `.agents/skills/`, `.cursor/skills/`, `.cursor/commands/`, or `.claude/commands/`.
- Do not modify application source.

## Acceptance criteria

- `docs/ORCHESTRATION-ARCHITECTURE.md` “File Locations” (or equivalent) lists `.agents/agents/`, `.cursor/agents/`, `.cursor/rules/`, and `CLAUDE.md`.
- The same doc’s subagent/invocation text states that prompt bodies live in `.agents/agents/<name>.md`, that `model:` is on the IDE wrapper, **and** that orchestrators pass the frozen-table slug for role + current IDE on named-subagent launches; it does **not** say the full agent definition in `.claude/agents/` loads automatically as the persona.
- That doc does not instruct copying skills into `.agents/skills/` or `.cursor/skills/`.
- `goals/README.md` has a row for goal 09 linking to `09-ide-agent-alignment/GOAL.md`.
- `feature-orchestrator/SKILL.md` requires passing the frozen-table slug for **role + current IDE** on every launch of the four named subagents, listing both Cursor slugs (`cursor-grok-4.6-xhigh`, `composer-2.5-fast`) and both Claude slugs (`fable`, `sonnet`). No “if the tool requires it” hedge. The Context Package “Role” bullet must state that the persona is `.agents/agents/<name>.md` and that the launch must pass the frozen-table slug — not that the agent definition loads automatically via `subagent_type` as the full persona/model.
- `deep-research-orchestrator/SKILL.md` contains the same mandatory model-routing rule for `pessimistic-judge` (and any other of the four it launches). No N/A branch.
- Frozen table values in docs and both skills match `goals/09-ide-agent-alignment/GOAL.md` (same slugs: `cursor-grok-4.6-xhigh`, `composer-2.5-fast`, `fable`, `sonnet`).
- No `.cursor/commands/` or `.claude/commands/` directory exists.
