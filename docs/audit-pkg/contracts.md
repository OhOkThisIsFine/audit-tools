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

The host writes `audit-host-result/v1alpha1` records. Ingestion verifies every
result before it accepts it; the check set below is the one list, rendered from
the registry both the audit and the remediation ingest cite on every refusal.
Malformed, fabricated, stale, or replayed-with-different-bytes records do not
advance the run.

<!-- BEGIN GENERATED INGESTION CHECKS — scripts/shared/generate-ingestion-checks.mjs — DO NOT EDIT BY HAND -->

> Rendered from `src/shared/submission/ingestionChecks.ts` — the registry both host-handoff twins cite on every
> refusal they emit. Add a check there and this table follows; the drift test refuses a
> row nothing cites.

| Check | What must hold for the result to be accepted | Draws |
|---|---|---|
| `result_path` | The submission is read only from the tool-derived bound path (`<run dir>/<sha256(work item id)>.json`) inside the run's artifacts directory; a result written anywhere else is never consulted. | `audit`, `remediate` |
| `result_json` | The bytes at the bound path parse as JSON. | `audit`, `remediate` |
| `result_envelope` | The top-level key set is exactly the draw's result contract and `contract_version` is the version the workload was issued under. | `audit`, `remediate` |
| `identity_binding` | `run_id` is the run that emitted the workload, `work_item_id` is the work item the result was read for, and `prompt_sha256` is the digest of the prompt that work item was issued with — an answer to another run, item or a stale prompt is refused. | `audit`, `remediate` |
| `workload_binding` | The persisted workload, result map and task bindings still derive from this run (versions, bound paths, prompt digests, scopes); a result cannot be accepted against a binding the tool cannot re-derive. | `audit`, `remediate` |
| `file_coverage` | `file_coverage` names exactly the assigned files, each fully reviewed, with `total_lines` equal to the line count bound at dispatch. | `audit` |
| `findings_contract` | Every finding satisfies the audit finding contract (lens, ids, evidence shape). | `audit` |
| `result_schema` | The bound result converts to the persisted `AuditResult` schema (`schemas/audit_result.schema.json`). | `audit` |
| `result_validation` | The per-result content rules hold before acceptance (evidence present, line spans inside the file, line counts matching disk); warnings ride an advisory channel and never refuse. | `audit` |
| `outcome_shape` | A decision result's `outcome` carries exactly the fields its status requires (`resolved_no_change` evidence, `blocked` failure reason, `needs_clarification` question). | `remediate` |
| `write_scope` | `changed_files` is non-empty, sorted, unique and normalized, lies within the prompt-bound `allowed_files`, and equals the files the landed commit actually changed. | `remediate` |
| `commit_evidence` | `commit_evidence` binds the workload baseline to a distinct landed commit; both exist, the baseline is an ancestor of the landed commit (waived only under a genuinely orphaned baseline in recovery), and the landed commit is reachable from HEAD. | `remediate` |
| `test_evidence` | `test_evidence` carries exactly one passed entry per required test echoing the bound command, and the tool's own mechanical rerun of those tests passes. | `remediate` |
| `obligation_evidence` | `obligation_evidence` cites non-empty evidence for every prompt-bound obligation, none twice, and none the work item does not bind. | `remediate` |
| `worktree_evidence` | `worktree_evidence` binds the workload baseline and the same changed-file list, and no landed file overlaps dirt that pre-dated the run. | `remediate` |
| `landing_attestation` | `acceptance` and `merge` both attest a completed landing. | `remediate` |
| `no_change_corroboration` | A `resolved_no_change` claim is corroborated against git and the persisted write-scope binding; attestation-only acceptance is refused. | `remediate` |
| `duplicate_result` | `result_id` has not already been accepted this run: a byte-identical replay is a no-op, a different body under an accepted id is refused. | `audit`, `remediate` |

<!-- END GENERATED INGESTION CHECKS -->

Per-result audit-results validation runs at acceptance, before the accepted
pair is written: a failing result is classified-rejected (warnings ride a
separate advisory channel, never the rejection list) and is re-read from its
bound path on the next `next-step`; `unaccept-results` removes an accepted
entry so its result is re-ingested from scratch.

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
in [`spec/audit/artifact-contract.md`](https://github.com/OhOkThisIsFine/audit-tools/blob/HEAD/spec/audit/artifact-contract.md)
(repository-only, so the link is absolute) covers the
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
