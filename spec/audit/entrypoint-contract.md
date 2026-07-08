# Entrypoint contract

## Public product surface

The intended public product surface is a single logical skill call, `advance_audit` — the
aspirational entrypoint name this contract is written against. The current shipped surface for that
call is the conversation-first `audit-code next-step` CLI / `/audit-code` slash command (with
`audit-code advance-audit` as a direct CLI precursor); `advance_audit` is the logical name those
executors sit behind.

Everything else in the repository should be treated as internal support for that entrypoint unless explicitly documented otherwise.

## Entrypoint purpose

A single invocation of `advance_audit` should:

1. load current audit state and artifacts
2. validate current state
3. drain the deterministic obligation frontier — repeatedly: determine the highest-priority valid
   next obligation, select one executor, execute that bounded step, persist — folding successive
   deterministic steps into the one invocation
4. halt the drain at the first host-input pause, non-drainable step, or the drain ceiling
5. return a single structured execution summary covering the whole drain

## Required inputs

### Audit target

At minimum, the entrypoint needs a repository target or a previously initialized artifact/state location.

### Artifact/state location

A persistent location where continuity artifacts are stored.

### Optional execution context

Examples:

- available tools
- LLM/runtime constraints
- external analyzer availability
- budget or step limits
- user policy overrides

## Required outputs

Each invocation must return a structured execution summary with at least:

- current top-level audit state
- executor chosen
- obligation targeted
- artifacts created or refreshed
- whether progress was made
- whether the audit is blocked
- whether the audit is complete
- likely next obligation

## Execution summary shape

The real return type is `AdvanceAuditResult` (`src/audit/orchestrator/advanceTypes.ts`):

- `audit_state`: `AuditState` — nested object; carries `status` (`not_started` | `active` | `blocked` |
  `complete`) and optional `blockers`: string[] internally, not as top-level fields
- `selected_obligation`: string | null
- `selected_executor`: string | null
- `progress_made`: boolean
- `artifacts_written`: string[]
- `progress_summary`: string
- `next_likely_step`: string | null
- `updated_bundle`: `ArtifactBundle`

There is no `artifacts_marked_stale` field.

## Bounded-step guarantee

An invocation performs a **fold-aware drain of the deterministic obligation frontier**, not a single
obligation. It repeatedly selects and executes the highest-priority *valid* bounded step, folding
successive deterministic steps into the one call, and halts at the first of: a host-input pause (any
operator-interactive step breaks the fold), a non-drainable step, or the drain ceiling. "Bounded" is
the guarantee that no invocation runs the audit to completion and no invocation crosses a host-input
boundary — not that it performs exactly one obligation.

Each folded step is itself a bounded unit. Examples of valid bounded steps:

- create repo manifest
- refresh structure artifacts
- generate audit tasks
- ingest one batch of audit results
- refresh requeue and runtime validation artifacts
- refresh synthesis artifacts

Examples of invalid unbounded behavior:

- continue draining past a host-input boundary instead of pausing for the operator
- select an executor for an obligation whose upstream dependencies are not yet valid
- refresh downstream artifacts before validating upstream consistency

## Selection contract

The entrypoint must be able to explain:

- why this obligation was selected
- why this executor was selected
- why higher-priority alternatives were not taken

## Failure contract

If execution fails, the entrypoint must:

- not pretend progress succeeded
- preserve continuity artifacts that remain valid
- record the failure as part of state
- report whether the failure is retryable or blocking

## Completion contract

The entrypoint may report `complete` only when the completion criteria document is satisfied.

## Internal mapping

The current CLI commands should be treated as precursors to internal executors, not as the final public interaction model.

The implementation goal is that those internal executors eventually sit behind `advance_audit`.
