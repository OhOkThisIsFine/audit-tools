# Completion Criteria

This document follows [audit-goals.md](C:/Code/auditor-lambda/spec/audit-goals.md).

An audit is complete only when all of the following are true:

1. Intake, structure, and planning artifacts are current.
2. Every auditable file/lens obligation is complete.
3. Every required critical-flow obligation is complete.
4. Every planned deterministic runtime-validation task is resolved.
5. `audit-report.md` has been rendered from the final completed audit state.
6. No blocking condition remains active.

The audit is not complete if any remaining work exists inside auditable scope,
even if that work is low priority.
