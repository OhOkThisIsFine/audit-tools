# State Machine Specification

This state machine follows [audit-goals.md](audit-goals.md).

## Top-level states

- `not_started`
- `active`
- `blocked`
- `complete`

## Obligations

The orchestrator advances through obligations in priority order, at the same
abstraction level as [orchestration-policy.md](orchestration-policy.md):

1. repair invalid or contradictory state
2. create missing upstream artifacts (intake, structure, design assessment,
   structure decomposition, the user gates, charter extraction, and design review)
3. generate missing planning artifacts
4. ingest newly available evidence
5. refresh coverage and requeue
6. refresh runtime validation artifacts
7. refresh synthesis
8. check completion

This is the abstract policy-category list; for the literal ordered chain of named
obligations, see the `PRIORITY` chain in `src/audit/orchestrator/nextStep.ts`.

## Rules

- Excluded files must not create obligations.
- `audit_tasks_completed` is satisfied only when all auditable coverage is done.
- `runtime_validation_current` is satisfied when either no deterministic runtime
  validation was planned, or all planned runtime tasks are resolved.
- `synthesis_current` is satisfied only when `audit-report.md` is current.
- The audit reaches `complete` only when no required obligation is missing or
  stale and the final report exists.

## Blocked behavior

If deterministic progress cannot continue and the next step requires semantic
review or explicit external input, the audit becomes `blocked` and writes only
minimal resumable state.
