# Contracts

## Versioned surfaces

The public contract is schema-first. Hosts, workers, prompts, and examples
should point at schemas and validated examples instead of duplicating fragile
field descriptions.

Important schemas live under `schemas/`, including:

- `audit-code-v1alpha1.schema.json`
- `audit_result.schema.json`
- `audit_task.schema.json`
- `audit_plan_metrics.schema.json`
- `graph_bundle.schema.json`
- `review_packets.schema.json`
- `runtime_validation_update.example.json` in `examples/`

## Wrapper envelope

Until completion, `audit-code` returns a JSON envelope with:

- `contract_version`
- `audit_state`
- `selected_obligation`
- `selected_executor`
- `progress_made`
- `artifacts_written`
- `progress_summary`
- `next_likely_step`
- `handoff`

On completion, the canonical output is repo-root `audit-report.md`. Intermediate
`.audit-artifacts/` state is cleaned up when the completed report is promoted.

## AuditResult

Workers submit `AuditResult[]` shaped by
`schemas/audit_result.schema.json`.

Important rules:

- `task_id`, `unit_id`, `pass_id`, and `lens` must match the assigned task
- every finding lens must match the assigned task lens
- `file_coverage` is required and must include assigned files only
- `file_coverage[].total_lines` must match the current file line count
- finding `affected_files` entries must be objects, not strings
- finding `evidence` must be an array of plain strings
- lens steward tasks emit `findings: []` plus `verification` metadata

Validate before ingestion:

```bash
audit-code validate-results --results /path/to/results.json
```

## Artifact bundle

The backend stores resumable artifacts under `.audit-artifacts/`, including:

- `repo_manifest.json`
- `file_disposition.json`
- `surface_manifest.json`
- `critical_flows.json`
- `graph_bundle.json`
- `unit_manifest.json`
- `coverage_matrix.json`
- `risk_register.json`
- `audit_tasks.json`
- `review_packets.json`
- `audit_plan_metrics.json`
- `audit_results.jsonl`
- `runtime_validation_tasks.json`
- `runtime_validation_report.json`
- `synthesis_report.json`

Consumers should treat these as versioned JSON artifacts and validate them with
`audit-code validate` rather than inferring state from filenames alone.

## Step artifacts

The conversation-first `/audit-code` prompt is a loader. It runs
`audit-code next-step` and then follows only the returned step prompt. The
backend writes the current step contract to:

- `<artifacts_dir>/steps/current-step.json`
- `<artifacts_dir>/steps/current-prompt.md`

`current-step.json` uses `contract_version: "audit-code-step/v1alpha1"` and
includes `step_kind`, `prompt_path`, `status`, `run_id`, `allowed_commands`,
`stop_condition`, `repo_root`, `artifacts_dir`, and relevant `artifact_paths`.

When semantic review is reached, the backend resolves host dispatch capability
from `--host-can-dispatch-subagents true|false` (optional) → session config
(`host_can_dispatch_subagents`) → `AUDIT_CODE_HOST_CAN_DISPATCH` → default
`true`, then renders exactly one review path: packet dispatch (`dispatch_review`)
or the single-task fallback (`single_task_fallback`). No capability handshake is
required; pass the flag only to override the resolved default.

`run-to-completion` renders the same step when it reaches the semantic-review
boundary, so a host on the batch entrypoint can act on `steps/current-step.json`
directly instead of issuing a second `next-step`.

## Dispatch packets

Packet dispatch preserves the existing `AuditTask` and `AuditResult`
contracts. It changes the worker-facing unit of work.

Planning artifacts are shaped by:

- `schemas/review_packets.schema.json`
- `schemas/audit_plan_metrics.schema.json`
- `examples/review_packets.example.json`
- `examples/audit_plan_metrics.example.json`

Normal packet flow:

```text
audit-code next-step --host-can-dispatch-subagents true
backend prepares dispatch-plan.json
conversation launches one worker per dispatch-plan entry
worker reads entry.prompt_path
worker submits AuditResult[] through submit-packet
audit-code merge-and-ingest --run-id <run_id> --artifacts-dir <artifacts_dir>
```

`audit-code prepare-dispatch --run-id <run_id> --artifacts-dir
<artifacts_dir>` remains available for compatibility and tests, but generic
handoff fields point users and prompts to `next-step`.

Packet artifacts:

- `<artifacts_dir>/runs/<run_id>/dispatch-plan.json`
- `<artifacts_dir>/runs/<run_id>/dispatch-result-map.json`
- `<artifacts_dir>/runs/<run_id>/task-results/*.prompt.md`
- `<artifacts_dir>/runs/<run_id>/task-results/*.anchors.json` for isolated
  large-file packets
- `<artifacts_dir>/runs/<run_id>/task-results/*.json`
- `<artifacts_dir>/runs/<run_id>/dispatch-warnings.json` when needed

Workers should reply exactly:

```text
valid: <packet_id>, findings=<total finding count>
```

## Graph contract

`graph_bundle.json` is language-neutral. Language-specific extractors may add
metadata, but consumers should rely on shared edge concepts:

- `from`
- `to`
- `kind`
- optional `direction`
- optional `confidence` from 0 to 1
- optional `reason`

Packet planning should use graph edges to explain why files belong together,
not merely to merge every connected group. Weak or high-fan-in edges should
become context hints rather than unlimited packet expansion.
Current deterministic import edges include JS/TS import kinds and Python
`python-import` / `python-from-import` edges when local modules resolve.
Current deterministic reference edges also include package entrypoints, package
script links, workspace/project module links, JSON Schema `$ref` links, schema
contract test links, bounded JSON Schema suite links, bounded GitHub Actions
workflow suite links, bounded package script suite links, bounded TypeScript
type contract suite links, and deterministic test/source naming links.

Consumers should treat graph evidence by authority:

- deterministic directed edges may drive packet expansion when confidence,
  budget, and fan-in/fan-out guards allow it
- ownership edges may cluster small bounded groups, but should remain explainable
  through `key_edges` and packet `quality`
- semantic-affinity or NLP-style relationships, if added, should default to
  low-authority context and candidate `boundary_files` unless corroborated by a
  deterministic edge

Bounded suite links are intentionally narrow: they connect small, same-directory
contract suites such as `*.schema.json` files, `.github/workflows/*.yml`
files, package-script-seeded `scripts/` files, or TypeScript files under
`types/` directories without turning broad directory proximity into packet
evidence.

Analyzer-supplied ownership roots should use this same graph contract instead
of requiring packet planners to understand a new language-specific artifact.
Normalized `external_analyzer_results.json` may include `ownership_roots`;
structure planning translates each bounded root/path membership into
`analyzer-ownership-root-link` reference edges. Packet planning then consumes
those edges through the same bounded `module-ownership-link` clustering path as
project-file evidence.
Planner metrics should make it possible to see which edge kinds changed packet
grouping and which stayed context-only.

`audit_plan_metrics.packet_quality` records that plan-level evidence through
`merge_edge_kind_counts`, `boundary_edge_kind_counts`, and weak-packet
diagnostics. Merge counts only include graph edges that joined distinct task
groups in a final packet; boundary counts include concrete graph edges that
remained adjacent context instead of internal packet evidence.
`weakly_explained_gap_counts` summarizes the primary gap type across all weak
packets, and `weakly_explained_file_extension_counts` summarizes the unique file
extensions represented by those packets. `weakly_explained_packet_samples` adds
a bounded snapshot of the weakest packet quality records, including sample file
paths and the primary gap, so extractor work can be prioritized without scanning
every packet first.

Review packets may expose graph-derived context for workers:

- `entrypoints` for route or handler context inside the packet
- `key_edges` for the strongest internal file relationships
- `boundary_files` for adjacent files that should only be checked when evidence
  genuinely crosses the packet
- `quality` metrics for cohesion, internal edges, boundary edges, and
  unexplained files

## Guided recovery

Failure responses should distinguish:

- rerun the same command
- import these result/update files
- fix session config
- retry a worker submission after schema validation errors
- perform manual semantic review

Malformed results, invalid config, stale artifacts, and provider failures
should include field-level or action-level remediation whenever possible.
