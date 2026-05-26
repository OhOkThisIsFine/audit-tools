# Entrypoint contract

## Public product surface

The intended public product surface is a single logical skill call:

`advance_audit`

Everything else in the repository should be treated as internal support for that entrypoint unless explicitly documented otherwise.

## Entrypoint purpose

A single invocation of `advance_audit` should:

1. load current audit state and artifacts
2. validate current state
3. determine the highest-priority valid next obligation
4. select one executor for that obligation
5. execute exactly one bounded step
6. persist updated artifacts and state
7. return a structured execution summary

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

Conceptually, the response should look like:

- `status`: `active` | `blocked` | `complete`
- `selected_obligation`: string
- `selected_executor`: string
- `artifacts_written`: string[]
- `artifacts_marked_stale`: string[]
- `progress_summary`: string
- `blockers`: string[]
- `next_likely_step`: string | null

## Bounded-step guarantee

One invocation should perform one bounded step only.

Examples of valid bounded steps:

- create repo manifest
- refresh structure artifacts
- generate audit tasks
- ingest one batch of audit results
- refresh requeue and runtime validation artifacts
- refresh synthesis artifacts

Examples of invalid unbounded behavior:

- recursively attempt to finish the entire audit in one invocation
- perform several unrelated executors just because they are easy
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
