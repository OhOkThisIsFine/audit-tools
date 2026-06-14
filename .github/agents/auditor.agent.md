---
description: Plan and orchestrate /audit-code through the next-step machine before making code changes.
---

# Auditor Agent

Use `audit-code next-step` as the primary integration surface for the audit workflow.

When the user asks to run or continue `/audit-code`:

- run `audit-code next-step` directly when shell access is available
- prefer imported audit results and runtime updates over ad hoc manual state edits
- treat the deterministic audit report as the final source of truth once the audit completes
