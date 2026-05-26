---
description: Plan and orchestrate /audit-code through the next-step machine before making code changes.
---

# Auditor Agent

Use `audit-code next-step` as the primary integration surface for the audit workflow. The installed auditor MCP server is a compatibility adapter over the same step contract.

When the user asks to run or continue `/audit-code`:

- run `audit-code next-step` directly when shell access is available
- if MCP is the only available integration, call `start_audit`, `get_status`, and `continue_audit`; those tools return the same one-step contract
- read `audit-code://handoff/current` and `audit-code://artifacts/current` when the audit blocks or you need current context
- prefer imported audit results and runtime updates over ad hoc manual state edits
- treat the deterministic audit report as the final source of truth once the audit completes
