# Dependency map

## Purpose

This document defines artifact dependencies and the default staleness rules used by the orchestrator.

## Rule

If an upstream artifact changes, all dependent downstream artifacts should be considered stale unless an executor explicitly proves otherwise.

## Canonical direction: artifact → what it depends on

The single hand-authored adjacency table is `ARTIFACT_DEPENDS_ON_MAP` in
`src/audit/orchestrator/dependencyMap.ts`, keyed `{ artifact → dependsOn[] }` — the
natural direction for `computeArtifactMetadata`, which records each artifact's
upstream revisions and reduces stale detection to a revision/hash compare. The
inverse "upstream → its dependents" view (`ARTIFACT_DEPENDENTS_MAP`, used by
`computeStaleArtifacts` to propagate staleness downstream) is *derived* from this
table by `invertDependencyMap` — there is exactly one hand-authored adjacency
representation, so the two views can never drift. This document mirrors the
canonical (upstream) direction for the same reason.

### Phase 1 — intake

| Artifact | Depends on |
|---|---|
| `repo_manifest.json` | `tooling_manifest.json` |
| `file_disposition.json` | `repo_manifest.json` |

`repo_manifest.json` is rebuilt when the tooling/environment probe changes (a
different analyzer version can classify files differently).

### Phase 2 — structure

| Artifact | Depends on |
|---|---|
| `graph_bundle.json` | `repo_manifest.json`, `file_disposition.json` |
| `analyzer_capability.json` | `graph_bundle.json` |
| `unit_manifest.json` | `repo_manifest.json`, `file_disposition.json` |
| `surface_manifest.json` | `repo_manifest.json`, `file_disposition.json` |
| `critical_flows.json` | `repo_manifest.json`, `file_disposition.json`, `surface_manifest.json`, `critical-flow-fallback.json` |
| `risk_register.json` | `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `surface_manifest.json`, `critical_flows.json` |
| `git_history.json` | `repo_manifest.json`, `file_disposition.json` |
| `external_analyzer_acquisition.json` | `repo_manifest.json`, `file_disposition.json` |
| `design_assessment.json` | `unit_manifest.json`, `critical_flows.json` |
| `structure_decomposition.json` | `repo_manifest.json`, `file_disposition.json`, `graph_bundle.json` |
| `charter_register.json` | `structure_decomposition.json`, `intent_checkpoint.json`, `repo_manifest.json` |
| `charter_clarification.json` | `charter_register.json`, `intent_checkpoint.json`, `repo_manifest.json` |
| `systemic_challenge.json` | `charter_register.json`, `intent_checkpoint.json`, `repo_manifest.json` |

`charter_clarification.json` (Phase D charter-alignment triangulation loop) and
`systemic_challenge.json` (Phase E second-order-adversary challenge loop) both
anchor to the same triad as `charter_register.json` so the two conceptual-review
outputs stale together whenever the charter register, the intent ceiling, or the
repo manifest changes.

`critical-flow-fallback.json` is a durable HOST INPUT (a leaf, like
`intent_checkpoint.json`): the critical-flow LLM fallback pass writes the
host-authored flow enrichment there when the deterministic inference falls below
its confidence bar, and the structure phase merges it into `critical_flows.json`.
Declaring it upstream of `critical_flows.json` is what makes the enrichment take
effect cleanly — the submission re-stales `critical_flows.json`, so structure
rebuilds `critical_flows.json` AND its `risk_register.json` sibling atomically off
the merged flows (no self-clobber from a separate post-hoc rewrite). Absent on the
common bar-met path → recorded at revision 0, never stale.

`analyzer_capability.json` is the marker recording the outcome of the optional
graph-enrichment pass (`applied` / `omitted`, plus per-analyzer resolution +
provenance); the merged analyzer edges themselves live in `graph_bundle.json`
(with `analyzers_used[]` provenance). No cycle: the enrichment executor writes
`graph_bundle.json` **and** the marker in one `advanceAudit` call, and metadata
is computed dependency-first, so the marker records the post-enrichment graph
revision (mirrors `audit-findings.json` → `synthesis-narrative.json` below).

`external_analyzer_acquisition.json` is the external-analyzer acquisition marker
(gitleaks + consent-gated eslint/semgrep/jscpd) — a run-record + staleness anchor
with no downstream of its own; the findings it produces land in
`external_analyzer_results.json` (a leaf input to Phase 3, not itself part of
this table, since nothing declares an upstream dependency for it).

### Phase 3 — planning & execution

| Artifact | Depends on |
|---|---|
| `coverage_matrix.json` | `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `intent_checkpoint.json`, `external_analyzer_results.json`, `scope.json`, `audit_results.jsonl` |
| `audit_tasks.json` | `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `critical_flows.json`, `intent_checkpoint.json`, `external_analyzer_results.json`, `scope.json` |
| `audit_plan_metrics.json` | `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `critical_flows.json`, `intent_checkpoint.json`, `external_analyzer_results.json`, `coverage_matrix.json`, `audit_tasks.json`, `audit_results.jsonl` |
| `task_affinity_graph.json` | `audit_tasks.json` |
| `flow_coverage.json` | `repo_manifest.json`, `file_disposition.json`, `critical_flows.json`, `external_analyzer_results.json`, `coverage_matrix.json`, `audit_results.jsonl` |
| `requeue_tasks.json` | `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `critical_flows.json`, `intent_checkpoint.json`, `external_analyzer_results.json`, `coverage_matrix.json`, `flow_coverage.json`, `audit_results.jsonl` |
| `runtime_validation_tasks.json` | `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `surface_manifest.json`, `critical_flows.json`, `external_analyzer_results.json`, `coverage_matrix.json`, `flow_coverage.json`, `audit_results.jsonl` |
| `runtime_validation_report.json` | `repo_manifest.json`, `file_disposition.json`, `critical_flows.json`, `external_analyzer_results.json`, `coverage_matrix.json`, `flow_coverage.json`, `audit_results.jsonl` |
| `access_memory.json` | `audit_results.jsonl` |

`access_memory.json` is a pure per-run summary harvested from the ingested
result ledger (which files/lenses each step covered, with recency in
step-ordinal space) — the ingestion executor writes it in the same
`advanceAudit` call that appends the ledger, so it records the post-append
`audit_results.jsonl` revision (dependency-first, no cycle). Nothing plans off
it yet: it exists to bias later packet composition toward continuity, and that
bias threads in at the dispatch *code* level (reading `bundle.access_memory`),
deliberately **not** as a DAG edge — a `coverage_matrix → audit_results →
access_memory → coverage_matrix` edge would be a cycle.

`scope.json` records how a run was scoped (the `--since` delta mode): `full`
(default) or `delta` with the seed (changed) + expanded (graph-neighbour) file
sets. It is a *direct* input to `audit_tasks.json` (not just transitively via
`coverage_matrix.json`) so a scope change that produces an identical coverage
matrix (same files/buckets) still re-stales tasks. No cycle: planning writes
`scope.json`, `coverage_matrix.json`, and `audit_tasks.json` in one
`advanceAudit` call, dependency-first.

`task_affinity_graph.json` is the provider-neutral task-affinity graph derived
from `audit_tasks.json` (Phase A of the plan/dispatch seam); dispatch partitions
it just-in-time and persists nothing back — see
[`audit-workflow-design.md`](../audit-workflow-design.md).

Findings land in `audit_results.jsonl` (NDJSON, one `AuditResult` per line) —
note the extension: this is **not** a `.json` array.

### Phase 4 — reporting

| Artifact | Depends on |
|---|---|
| `audit-report.md` | `repo_manifest.json`, `file_disposition.json`, `unit_manifest.json`, `surface_manifest.json`, `critical_flows.json`, `design_assessment.json`, `structure_decomposition.json`, `charter_register.json`, `charter_clarification.json`, `systemic_challenge.json`, `syntax_resolution_status.json`, `external_analyzer_results.json`, `coverage_matrix.json`, `flow_coverage.json`, `runtime_validation_report.json`, `audit_results.jsonl`, `agent-feedback.jsonl` |
| `synthesis-narrative.json` | `audit-findings.json` |

The human render (`audit-report.md`) depends on every analysis artifact plus
`agent-feedback.jsonl` (see below). The canonical machine contract
(`audit-findings.json`) is co-produced by the same synthesis executor as
`audit-report.md` but is **not itself a row in this table** — it has no declared
upstream dependency of its own; it is written alongside `audit-report.md` by
`synthesis_executor` in one `advanceAudit` call. `synthesis-narrative.json` is
the marker recording whether the optional narrative pass (themes / executive
summary / top risks) was `applied` or `omitted`; it tracks `audit-findings.json`
so a re-synthesized contract re-stales the narrative pass and it regenerates.

### `agent-feedback.jsonl` (not a registry entry)

Opt-in worker-appended meta-audit reflections (NDJSON; schema `AgentReflectionSchema` in
`src/shared/agentReflections.ts`). Workers own this file — the orchestrator only
reads it (parsed leniently into `bundle.agent_reflections`; it is not a writable
registry entry, so it is never rewritten or pruned). Synthesis renders the
parsed reflections as the report's "Process Feedback" section. Only the human
render depends on it — `audit-findings.json` (the machine contract) carries no
reflections. Because no executor writes the file, `advanceAudit` treats it as
always-updated when computing metadata (the same pattern as `tooling_manifest.json`):
a reflection appended after synthesis bumps its revision and re-stales the report
exactly once; an unchanged file keeps its revision, so finalization converges.

## Which executor produces each artifact (authoritative)

This is the single declarative home for the executor→artifact production mapping
(the by-artifact view). [`executor-catalog.md`](executor-catalog.md) is the
by-executor reference and points here rather than re-listing producers, so the
relation is hand-maintained in exactly one place. The machine-readable ground
truth remains the pair of registries — `EXECUTOR_REGISTRY`
(`src/audit/orchestrator/executors.ts`) and `ARTIFACT_DEFINITIONS`
(`src/audit/io/artifacts.ts`); this table is their declarative render.

"Primary" = the executor that authoritatively writes the artifact; "refreshed by"
= executors that rewrite it later in the pipeline (staleness-driven).

| Artifact | Primary producer | Also written / refreshed by |
|---|---|---|
| `provider_confirmation.json` | `provider_confirmation_executor` | — |
| `repo_manifest.json` | `intake_executor` | — |
| `file_disposition.json` | `intake_executor` | `structure_executor` |
| `intent_checkpoint.json` | `intent_checkpoint_executor` | — |
| `auto_fixes_applied.json` | `auto_fix_executor` | — |
| `external_analyzer_acquisition.json` | `external_analyzer_acquisition_executor` | — |
| `unit_manifest.json` | `structure_executor` | — |
| `surface_manifest.json` | `structure_executor` | — |
| `graph_bundle.json` | `structure_executor` | `graph_enrichment_executor` (merges analyzer edges) |
| `critical_flows.json` | `structure_executor` | — (merges persisted `critical-flow-fallback.json`) |
| `risk_register.json` | `structure_executor` | — |
| `git_history.json` | `structure_executor` | — |
| `critical-flow-fallback.json` | `critical_flow_fallback_executor` | — (durable host input) |
| `analyzer_capability.json` | `graph_enrichment_executor` | — |
| `design_assessment.json` | `design_assessment_executor` | `design_review_contract`, `design_review_conceptual` |
| `structure_decomposition.json` | `structure_decomposition_executor` | — |
| `charter_register.json` | `charter_extraction_executor` | `charter_delta_executor` |
| `charter_clarification.json` | `charter_clarification_executor` | — |
| `systemic_challenge.json` | `systemic_challenge_executor` | — |
| `external_analyzer_results.json` | `syntax_resolution_executor` | `external_analyzer_import_executor` (`preferredExecutor` only) |
| `syntax_resolution_status.json` | `syntax_resolution_executor` | — |
| `scope.json` | `planning_executor` | — |
| `coverage_matrix.json` | `planning_executor` | `result_ingestion_executor` |
| `flow_coverage.json` | `planning_executor` | `result_ingestion_executor` |
| `runtime_validation_tasks.json` | `planning_executor` | `result_ingestion_executor` |
| `runtime_validation_report.json` | `runtime_validation_executor` | `planning_executor` (when tasks exist), `result_ingestion_executor`, `runtime_validation_update_executor` (`preferredExecutor` only) |
| `audit_tasks.json` | `planning_executor` | `result_ingestion_executor`, `runtime_validation_executor` (selective deepening) |
| `audit_plan_metrics.json` | `planning_executor` | `result_ingestion_executor`, `runtime_validation_executor` (selective deepening) |
| `task_affinity_graph.json` | `planning_executor` | — |
| `requeue_tasks.json` | `planning_executor` | `result_ingestion_executor` |
| `audit_results.jsonl` | `result_ingestion_executor` (appends; results produced by `rolling_dispatch_executor`) | — |
| `access_memory.json` | `result_ingestion_executor` | — |
| `audit-report.md` | `synthesis_executor` | `synthesis_narrative_executor` (re-render with narrative) |
| `audit-findings.json` | `synthesis_executor` | `synthesis_narrative_executor` (re-render with narrative) |
| `synthesis-narrative.json` | `synthesis_narrative_executor` | — |

## Staleness policy examples

### Example 1

If `repo_manifest.json` changes, every structure artifact (`graph_bundle.json`,
`unit_manifest.json`, `surface_manifest.json`, `critical_flows.json`,
`risk_register.json`, `git_history.json`, `design_assessment.json`,
`structure_decomposition.json`, `charter_register.json`, `charter_clarification.json`,
`systemic_challenge.json`) and every
downstream planning/execution/reporting artifact that lists it as a dependency
is stale.

### Example 2

If `audit_results.jsonl` changes (new findings ingested), `coverage_matrix.json`,
`flow_coverage.json`, `requeue_tasks.json`, `runtime_validation_tasks.json`,
`runtime_validation_report.json`, `audit_plan_metrics.json`, and `audit-report.md`
are all stale — but `audit-findings.json` is not directly in this table, so its
own staleness follows from the synthesis executor's obligation logic, not this
DAG.

### Example 3

If `runtime_validation_report.json` changes, `audit-report.md` is stale, but
upstream planning artifacts (`coverage_matrix.json`, `audit_tasks.json`) are
not — the dependency only runs downstream.

## Implementation note

The canonical machine-readable form of this map is `ARTIFACT_DEPENDS_ON_MAP` in
`src/audit/orchestrator/dependencyMap.ts`. That table is the single hand-authored
adjacency representation: it is keyed `{ artifact → dependsOn[] }`, and the
forward "upstream → dependents" view (`ARTIFACT_DEPENDENTS_MAP`) is derived from
it via `invertDependencyMap` — so the two adjacency views can never drift.
`computeStaleArtifacts` (in `src/audit/orchestrator/staleness.ts`) uses the
derived dependents map to propagate staleness downstream deterministically.
This document is the declarative reference; the TypeScript table is the
authoritative implementation.
