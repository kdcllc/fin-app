---
paths:
  - "**/*.{ts,tsx}"
---

# TypeScript / UI

- UI components never issue SQL — all database access goes through the TypeScript core data-access layer.
- Money is **integer cents** in TypeScript code; never use floats for monetary values.
