# Orchestration policy

## Purpose

This document defines how the single entrypoint chooses the next step.

## Core rule

The orchestrator must choose the **highest-priority valid next obligation** and execute one bounded step toward satisfying it.

## Priority order

Default priority order:

1. repair invalid or contradictory state
2. create or refresh upstream artifacts
3. generate missing planning artifacts
4. ingest newly available evidence
5. refresh coverage and requeue
6. refresh runtime validation artifacts
7. refresh synthesis
8. check completion

## Selection principles

### Prefer validity over progress speed

If state is invalid, repair or halt before proceeding.

### Prefer deterministic over inferential

If a deterministic step can satisfy an obligation, do that before invoking LLM-heavy work.

### Prefer upstream over downstream

Do not refresh synthesis when upstream artifacts are missing or stale.

### Prefer bounded execution

Choose a step that can complete cleanly within one invocation.

## Stale artifact policy

An artifact should be treated as stale if any dependency artifact changed after it was produced.

The orchestrator should maintain an explicit dependency map rather than inferring this ad hoc.

## Requeue policy

Requeue generation should happen when:

- file-level required lenses remain incomplete
- flow-level required lenses remain incomplete
- runtime validation remains required for unresolved critical flows or high-risk units

## LLM usage policy

LLM-driven work should be used for:

- blind-spot discovery
- semantic review tasks
- synthesis
- architecture judgment
- ambiguity resolution

LLM-driven work should not be used when deterministic extractors or validators are sufficient.

## Failure policy

If a chosen step fails, the orchestrator should:

1. record the failure
2. determine whether the failure is retryable
3. either mark blocked or leave the obligation unsatisfied
4. avoid pretending the step succeeded

## Completion policy

The orchestrator may mark completion only when:

- all required obligations are satisfied
- no mandatory downstream artifact is stale
- no required requeue remains
- no mandatory runtime validation obligation is unresolved in a way that blocks completion

## State machine

The orchestration above is expressed as a small state machine (following
[audit-goals.md](audit-goals.md)).

### Top-level states

- `not_started`
- `active`
- `blocked`
- `complete`

The orchestrator advances through obligations in priority order (the *Priority
order* section above is the canonical abstract ordering; the literal ordered chain
of named obligations is the `PRIORITY` chain in
`src/audit/orchestrator/nextStep.ts`).

### Obligation-satisfaction rules

- Excluded files must not create obligations.
- `audit_tasks_completed` is satisfied only when all auditable coverage is done.
- `runtime_validation_current` is satisfied when either no deterministic runtime
  validation was planned, or all planned runtime tasks are resolved.
- `synthesis_current` is satisfied only when `audit-report.md` is current.
- The audit reaches `complete` only when no required obligation is missing or
  stale and the final report exists.

### Blocked behavior

If deterministic progress cannot continue and the next step requires semantic
review or explicit external input, the audit becomes `blocked` and writes only
minimal resumable state.

## Anti-drift rule

No new feature or component should be added without answering:

1. which obligation does it satisfy?
2. which executor owns it?
3. how does the orchestrator know when to run it?
4. which artifacts does it read and write?
5. what becomes stale when it changes?

A component that answers none of these is likely product drift.
