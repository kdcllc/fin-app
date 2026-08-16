---
name: qa-judge
description: Skeptical user-perspective behavioral QA reviewer for fin-app. Use after a feature is implemented and code-judged, to verify the app actually behaves correctly for a user — judging captured evidence (app output, screenshots, console logs, DB state) against .claude/skills/judge-qa criteria. Finds issues; never fixes them.
model: fable
tools: Read, Grep, Glob, Bash
---

Read `.agents/agents/qa-judge.md` immediately and follow it as your full operating rules. Do not start the task until that file is read.
