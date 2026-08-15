# Contracts

## Versioned surfaces

The public surface is schema-first. Important schemas live under `schemas/`,
including audit results, tasks, findings, and lenses. Hosts should consume
versioned artifacts rather than infer state from
filenames or duplicate field descriptions.

The canonical final outputs are:

```text
.audit-tools/audit-findings.json
.audit-tools/audit-report.md
```

The JSON contract is authoritative; Markdown is its render.

## Step artifacts

`audit-code next-step` advances one bounded transition and writes:

```text
<artifacts_dir>/steps/current-step.json
<artifacts_dir>/steps/current-prompt.md
```

`current-step.json` uses `audit-code-step/v1alpha1` and names the current prompt,
run, allowed commands, stop condition, repository root, artifact directory, and
relevant artifact paths. The conversation loader reads only `prompt_path` and
follows the rendered prompt.

## Provider-neutral host workload

When semantic review is ready, audit-tools writes a complete
`audit-host-workload/v1alpha1` artifact. Each work item contains:

- a stable id and lens
- provider-neutral complexity, risk, and deterministic token-estimate metadata
- the complete prompt text plus its SHA-256 binding
- the file and unit scope
- the repository-contained result path

A companion `audit-host-result-map/v1alpha1` binds each work-item id, prompt
digest, and result path. No backend, model, routing, quota, transport, launch
command, or worker identity is part of either contract.

The host writes `audit-host-result/v1alpha1` records. Ingestion requires exact
top-level fields and verifies:

- run id, work-item id, prompt digest, and result path against tool-owned
  bindings
- assigned file coverage only, with current total-line counts
- finding and lens consistency through the normal `AuditResult` schema
- repository containment for every artifact path
- append-time idempotency through the accepted-results ledger

Malformed, fabricated, stale, or replayed-with-different-bytes records do not
advance the run. A byte-identical accepted replay is a no-op.

## AuditResult

The normalized ingested form follows `schemas/audit_result.schema.json`.
Important invariants are:

- `task_id`, `unit_id`, `pass_id`, and `lens` match the assigned task
- every finding uses the assigned lens
- `file_coverage` contains assigned files only
- `file_coverage[].total_lines` matches current source
- affected files are structured entries and evidence is plain text
- verification-only tasks may return no findings with explicit verification
  metadata

Validate recovery input before ingestion:

```bash
audit-code validate-results --results /path/to/results.json
```

## Artifact bundle

Resumable state lives under `.audit-tools/audit/`. The registry-backed contract
in [`artifact-contract.md`](../../spec/audit/artifact-contract.md) covers the
complete set. Representative artifacts include repository and unit manifests,
file disposition, graph and critical-flow data, coverage, risk, audit tasks,
runtime validation, accepted host results, synthesis narrative, and the final
deliverables.

Run `audit-code validate` instead of treating file presence as proof of a valid
state transition.

## Graph contract

`graph_bundle.json` is language-neutral. Edges carry `from`, `to`, `kind`, and
optional direction, confidence, and reason. Deterministic import, entrypoint,
test/source, and ownership evidence may drive grouping; weak affinity and
high-fan-in edges remain explainable context unless corroborated.

Planning metrics record which edges merged work and which stayed boundary
context. New analyzers enrich the same graph contract rather than teaching the
planner a second language-specific artifact.

## Guided recovery

Failures distinguish rerunning a command, importing a result/update file,
repairing strict repository intent, retrying a schema-invalid host result, and
performing the assigned semantic review manually. Backend-execution failures
are not an audit-tools state: the host reports or retries them without inventing
provider-specific fields in persisted contracts.
