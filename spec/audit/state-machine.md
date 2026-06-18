# State Machine Specification

This state machine follows [audit-goals.md](C:/Code/auditor-lambda/spec/audit-goals.md).

## Top-level states

- `not_started`
- `active`
- `blocked`
- `complete`

## Obligations

The orchestrator advances through deterministic obligations in this order:

1. intake
2. structure
3. planning
4. audit result ingestion
5. runtime validation when planned
6. final report rendering

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
