# Dependency map

## Purpose

This document defines artifact dependencies and the default staleness rules used by the orchestrator.

## Rule

If an upstream artifact changes, all dependent downstream artifacts should be considered stale unless an executor explicitly proves otherwise.

## Dependency map

### `repo_manifest.json`

Downstream:

- `file_disposition.json`
- `unit_manifest.json`
- `surface_manifest.json`
- `graph_bundle.json`
- `critical_flows.json`
- `risk_register.json`
- `coverage_matrix.json`
- `flow_coverage.json`
- `audit_tasks.json`
- `requeue_tasks.json`
- `runtime_validation_tasks.json`
- `runtime_validation_report.json`
- `synthesis_report.json`

### `file_disposition.json`

Downstream:

- `unit_manifest.json`
- `surface_manifest.json`
- `graph_bundle.json`
- `critical_flows.json`
- `risk_register.json`
- `coverage_matrix.json`
- `flow_coverage.json`
- `audit_tasks.json`
- `requeue_tasks.json`
- `runtime_validation_tasks.json`
- `runtime_validation_report.json`
- `synthesis_report.json`

### `unit_manifest.json`

Downstream:

- `risk_register.json`
- `design_assessment.json`
- `coverage_matrix.json`
- `audit_tasks.json`
- `runtime_validation_tasks.json`
- `requeue_tasks.json`
- `synthesis_report.json`

### `surface_manifest.json`

Downstream:

- `critical_flows.json`
- `risk_register.json`
- `runtime_validation_tasks.json`
- `synthesis_report.json`

### `graph_bundle.json`

Downstream:

- `analyzer_capability.json`
- `design_assessment.json`
- future clustering or structural synthesis layers

### `analyzer_capability.json`

Marker recording the outcome of the optional Phase 5 graph-enrichment pass
(`applied` / `omitted`, plus per-analyzer resolution + provenance). Tracks
`graph_bundle.json` so a re-built (structure) graph re-stales the marker and the
analyzer edges regenerate. Satisfies the `graph_enrichment_current` obligation.
The merged analyzer edges themselves live in `graph_bundle.json` (with
`analyzers_used[]` provenance). No cycle: the enrichment executor writes
`graph_bundle.json` **and** the marker in one `advanceAudit` call, and metadata
is computed dependency-first, so the marker records the post-enrichment graph
revision (mirrors `audit-findings.json` → `synthesis-narrative.json`).

### `critical_flows.json`

Downstream:

- `flow_coverage.json`
- `risk_register.json`
- flow-aware task augmentation in `audit_tasks.json`
- flow-aware `requeue_tasks.json`
- `design_assessment.json`
- `runtime_validation_tasks.json`
- `runtime_validation_report.json`
- `synthesis_report.json`

### `design_assessment.json`

Downstream:

- `audit-report.md`

### `risk_register.json`

Downstream:

- `runtime_validation_tasks.json`
- priority-sensitive synthesis layers

### `audit_results.json`

Downstream:

- `coverage_matrix.json`
- `flow_coverage.json`
- `requeue_tasks.json`
- `runtime_validation_tasks.json`
- `runtime_validation_report.json`
- `merged_findings.json`
- `root_cause_clusters.json`
- `synthesis_report.json`

### `scope.json`

Records how a run was scoped (Phase 3 `--since` delta mode): `full` (default) or
`delta` with the seed (changed) + expanded (graph-neighbour) file sets. Produced
by the planning executor and consumed by it to decide which `coverage_matrix.json`
entries are (re)queued vs. inherited-complete/excluded. A changed scope (different
`--since` / seed set → new content hash) re-stales coverage so the plan rebuilds.
No cycle: planning writes `scope.json` **and** `coverage_matrix.json` in one
`advanceAudit` call, and metadata is computed dependency-first, so coverage
records the post-write scope revision (mirrors `graph_bundle.json` →
`analyzer_capability.json`).

Downstream:

- `coverage_matrix.json`

### `coverage_matrix.json`

Downstream:

- `flow_coverage.json`
- `requeue_tasks.json`
- `runtime_validation_tasks.json`
- `runtime_validation_report.json`
- `synthesis_report.json`

### `flow_coverage.json`

Downstream:

- `requeue_tasks.json`
- `runtime_validation_tasks.json`
- `runtime_validation_report.json`
- `synthesis_report.json`

### `runtime_validation_tasks.json`

Downstream:

- `runtime_validation_report.json`
- `synthesis_report.json`

### `runtime_validation_report.json`

Downstream:

- `merged_findings.json`
- `root_cause_clusters.json`
- `synthesis_report.json`

### `audit-findings.json`

The canonical machine contract (shared `AuditFindingsReport`), co-produced with
`audit-report.md` by the synthesis executor. The optional synthesis-narrative
pass merges themes / executive summary / top risks into it.

Downstream:

- `synthesis-narrative.json`

### `synthesis-narrative.json`

Marker recording whether the synthesis narrative was `applied` or `omitted`.
Tracks `audit-findings.json` so a re-synthesized (base) findings report
re-stales the narrative and it regenerates. Satisfies the
`synthesis_narrative_current` obligation.

### `agent-feedback.jsonl`

Opt-in worker-appended meta-audit reflections (NDJSON; schema
`agent_reflection.schema.json`). Workers own this file — the orchestrator only
reads it (parsed leniently into `bundle.agent_reflections`; it is not a
writable registry entry, so it is never rewritten or pruned). Synthesis renders
the parsed reflections as the report's "Process Feedback" section.

Only the human render depends on it: `audit-findings.json` (the machine
contract) carries no reflections. Because no executor writes the file,
`advanceAudit` treats it as always-updated when computing metadata (the
`tooling_manifest.json` pattern): a reflection appended after synthesis bumps
its revision and re-stales the report exactly once; an unchanged file keeps its
revision, so finalization converges.

Downstream:

- `audit-report.md`

### `external_analyzer_results.json`

Downstream:

- future risk enrichment
- future synthesis enrichment
- future planning enrichment

## Staleness policy examples

### Example 1

If `repo_manifest.json` changes, all structure and planning artifacts are stale.

### Example 2

If `audit_results.json` changes, synthesis artifacts are stale, and coverage-related artifacts may be stale.

### Example 3

If `runtime_validation_report.json` changes, synthesis artifacts are stale, but upstream planning artifacts are not.

## Implementation note

This dependency map should eventually become machine-readable so the orchestrator can compute stale obligations deterministically rather than relying on hand-coded special cases.
