# Product specification

## Product identity

Auditor Lambda is a resumable audit orchestrator for arbitrary codebases.

Its primary product behavior is not “run a particular phase” or “run a particular tool.” Its product behavior is:

**advance the audit by executing the highest-priority valid next step from the current audit state.**

## Product boundary

Auditor Lambda is:

- a single logical skill entrypoint
- a stateful audit engine
- a deterministic artifact producer and consumer
- a bounded LLM orchestration system
- a resumable workflow that can be invoked repeatedly until completion

Auditor Lambda is not:

- just a prompt pack
- just a CLI toolbox
- just a static-analysis wrapper
- just a report generator
- just a collection of one-off audit phases

## Core user interaction model

The intended user interaction is a single skill call such as `advance_audit`.

Each invocation should:

1. load current audit state
2. determine the next required obligation
3. execute one bounded next step
4. persist updated state and artifacts
5. report what happened, what remains, and whether the audit is complete or blocked

## Product goal

For any arbitrary repository, repeated invocations of the single skill entrypoint should eventually produce:

- normalized repository understanding
- bounded audit tasks
- verified coverage state
- synthesized findings
- runtime validation follow-up where needed
- a final completion or blocked status

## Product invariants

1. The system is obligation-driven, not phase-driven.
2. Deterministic artifacts are the source of continuity.
3. LLM work must be bounded and attributable.
4. Progress must be resumable across invocations.
5. Every invocation must either:
   - make valid progress,
   - report a blocker,
   - or report completion.
6. The system must prefer deterministic execution whenever possible.
7. The orchestration layer must be able to explain why a particular next step was chosen.

## Single-entrypoint contract

### Conceptual entrypoint

`advance_audit`

### Required capabilities

- inspect current state
- validate artifact consistency
- detect stale or missing obligations
- choose the next step
- execute exactly one bounded step
- update state
- emit execution summary

### Bounded-step rule

A single invocation should generally perform one bounded unit of progress rather than trying to complete the entire audit in one run.

Examples of bounded steps:

- generate repo manifest
- generate unit and flow artifacts
- generate next batch of audit tasks
- ingest one batch of task results
- refresh coverage and requeue
- merge runtime validation updates
- rebuild synthesis

## Completion model

The product is complete for a given audit target when:

- all required audit obligations are satisfied
- no mandatory coverage gaps remain
- no stale synthesis remains relative to evidence
- unresolved blockers are either cleared or explicitly recorded as blocking completion

## Blocking model

An audit can be blocked by:

- missing repository access
- unreadable or invalid artifacts
- external tools required but unavailable
- missing user-supplied evidence or result imports
- contradictions that invalidate state continuity

## Anti-drift rule

Every repository component should support one of these purposes only:

- define audit state and obligations
- perform a bounded audit step
- validate or persist continuity
- help the single entrypoint choose the next step

If a component does not serve one of those roles, it is likely product drift.
