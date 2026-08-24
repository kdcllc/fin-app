# Model Map

Model IDs are **configuration, not constants**. This file is the single place they are
defined; re-run `/setup` (or edit here and re-emit) when providers rotate model names.

Resolved 2026-08-24 for the two installed harnesses (Claude Code, Cursor), from the
project's frozen model table in `CLAUDE.md`. Cursor IDs use the slug-suffix effort form
(`…-xhigh`, `…-fast`) confirmed against the live Cursor model list at emit time.

## Tier assignments

| Tier | Roles | Rationale |
|------|-------|-----------|
| `frontier` | orchestrator (main session), `evaluator`, `qa-evaluator` | Delegation and evaluation have a capability floor — don't cheap out on the roles that decide and verify |
| `light` | `implementer`, `test-writer`, `terminal` | Checklist-driven execution and compact command running retain most quality at a fraction of the cost when the plan and the verification are strong |

## Resolved models

| Tier | Claude Code | Cursor |
|------|-------------|--------|
| `frontier` | fable | cursor-grok-4.6-xhigh |
| `light` | sonnet | composer-2.5-fast |

Reasoning-effort pins: evaluators `high`, workers `medium` — Claude Code `effort:`
frontmatter. Cursor's effort is encoded in the slug-suffix model IDs themselves
(`-xhigh`, `-fast`, `-medium`), so Cursor agent files carry no separate effort key.

## Fallback chains

| Tier | Claude Code chain (first available wins) | Cursor chain (first available wins) |
|------|------------------------------------------|-------------------------------------|
| `frontier` | fable → opus → sonnet → (omit pin — harness default) | cursor-grok-4.6-xhigh → cursor-grok-4.5-high-fast → claude-fable-5-thinking-xhigh → (omit pin — harness default) |
| `light` | sonnet → haiku → (omit pin — harness default) | composer-2.5-fast → gpt-5.6-sol-medium → (omit pin — harness default) |

Rules (adapted from bradygaster/squad's model selector):

- **Never fall back UP a tier** — a light role must never silently land on a frontier
  model, and a frontier role never degrades below the standard rung of its chain.
- Fallbacks are silent to the user but **logged in the orchestration log**.
- Max 3 fallback attempts, then omit the model pin and take the harness default.
- Apply at most **one** complexity adjustment per spawn — no cascading bumps.
- **Cost ceiling policy**: an EXPLICIT human model choice above a plan/admin ceiling →
  warn loudly and honor it; an implicit (auto-selected) choice → downgrade to the
  ceiling; no compliant model at all → fail loud — never silently substitute.
- **Prompts are executable — treat like code**: tasks that author or edit agent, skill,
  or prompt files use the frontier tier, never the docs/light tier.

### Loop fallback chain

| Chain (first available wins) | Resolves |
|-------------------------------|----------|
| sonnet → haiku → (omit pin — harness default) | `sonnet,haiku` |

Light-tier by default — the loop's iterations are implementer/test-writer-shaped work,
same as the `light` row above. The loop drivers dispatch the Claude Code CLI (`claude`,
the primary harness), so the chain uses Claude Code IDs. Ends with the same
omit-the-pin rule as the tables above: a trip past the last chain entry clears the
model pin and the harness default takes over (no hardcoded model IDs outside this
file).

## Fix-cycle rotation (after evaluator rejections)

A model blind to its own class of mistake rarely fixes it on retry. Rotate:

| Fix cycle | Claude Code implementer model | Cursor implementer model |
|-----------|-------------------------------|--------------------------|
| 1 | `sonnet` (normal) | `composer-2.5-fast` (normal) |
| 2 | `opus` — a different model line at comparable tier (Claude Code runs Anthropic models only, so a different family is not available; a different line is the analytical-diversity rotation) | `gpt-5.6-sol-medium` — a different model **family** at comparable tier |
| 3 | `fable` | `cursor-grok-4.6-xhigh` |

## Harness caveats that shape tiering

- **Cursor silent fallback**: under team-admin/plan restrictions, or when the resolved
  ID is unknown/stale (a rotated-out or misspelled model name), Cursor substitutes a
  compatible model without erroring — evaluators should state their expected model in
  their prompt and report which model produced the verdict.
- **Claude Code env overrides**: `CLAUDE_CODE_SUBAGENT_MODEL` and
  `CLAUDE_CODE_EFFORT_LEVEL` override frontmatter; org `availableModels` allowlists can
  cause pins to be ignored.
