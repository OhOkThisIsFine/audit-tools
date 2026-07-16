# Artifact contract

## Purpose

Artifacts are the continuity layer for the single-entrypoint audit engine. They are the authoritative representation of current audit state between invocations.

## Artifact rules

1. Every artifact must have a defined producer.
2. Every artifact must have defined freshness dependencies.
3. Artifacts must be machine-readable and stable.
4. Orchestration decisions should be based on artifacts, not hidden transient reasoning.

## Source of truth

The canonical, machine-readable artifact registry is `ARTIFACT_DEFINITIONS` in
`src/audit/io/artifacts.ts` — 38 entries, each declaring a filename, a phase
(`intake` / `analysis` / `execution` / `reporting` / `supervisor`), and typed
read/write functions (JSON, NDJSON, or plain text). This document is the
declarative reference; that table is authoritative. For exact upstream
dependencies (staleness edges) per artifact, see
[`dependency-map.md`](dependency-map.md) — not duplicated here. For which
executor produces which artifact and its obligation id, see
[`executor-catalog.md`](executor-catalog.md) — also not duplicated here.

Three artifacts participate in orchestrator state but are **not**
`ARTIFACT_DEFINITIONS` entries (loaded/written specially, not staleness-DAG
nodes): `active-dispatch.json` (in-flight dispatch state), design-review
snapshots (per-pass semantic projections), and the per-file graph-edge cache
(C2 incremental graph-build reuse). `agent-feedback.jsonl` is also outside the
registry — worker-appended, orchestrator-read-only — but *does* participate in
the staleness DAG (see dependency-map.md).

## Artifacts by phase

### Intake

| Artifact | Format | Purpose |
|---|---|---|
| `provider_confirmation.json` | JSON | Auto-discovered/confirmed provider set for this run. |
| `repo_manifest.json` | JSON | Repository structure and file classification. |
| `file_disposition.json` | JSON | Per-file audit-scope disposition derived from the manifest. |
| `auto_fixes_applied.json` | JSON | Record of mechanical auto-fixes applied before review. |
| `intent_checkpoint.json` | JSON | User/host-confirmed audit intent and lens propositions. |

### Analysis

| Artifact | Format | Purpose |
|---|---|---|
| `unit_manifest.json` | JSON | Parsed units (functions/classes/modules). |
| `graph_bundle.json` | JSON | Dependency/call graph, with optional external-analyzer edge enrichment. |
| `surface_manifest.json` | JSON | Public API surface and exports. |
| `critical_flows.json` | JSON | Identified critical execution/data flows. |
| `critical-flow-fallback.json` | JSON | Durable host input: the LLM fallback flow enrichment authored when `critical_flows.fallback_required` is set. Merged into `critical_flows.json` by the structure phase. |
| `flow_coverage.json` | JSON | Coverage of critical flows by ingested results. |
| `risk_register.json` | JSON | Per-unit risk signals (see `src/audit/extractors/risk.ts` for the full signal list). |
| `git_history.json` | JSON | Deterministic co-change/churn/authorship mined from the commit log. |
| `design_assessment.json` | JSON | Deterministic + optional host-delegated design assessment (see below). |
| `structure_decomposition.json` | JSON | Deterministic structure-layer decomposition (overlay-and-delta operator over behavior-graph + intent sources); emits non-co-localization findings. |
| `charter_register.json` | JSON | Phase-C charter layer over the structure decomposition, gated by the confirmed intent-checkpoint ceiling. |
| `charter_clarification.json` | JSON | Phase-D charter-alignment triangulation loop over the charter register, gated by the confirmed intent-checkpoint ceiling. |
| `systemic_challenge.json` | JSON | Phase-E second-order-adversary improvement-seeking challenge loop over the charter register, gated by the confirmed intent-checkpoint ceiling. |
| `analyzer_capability.json` | JSON | Marker: outcome of the optional graph-enrichment pass (`applied`/`omitted`) + per-analyzer provenance. |
| `external_analyzer_acquisition.json` | JSON | Marker: external-analyzer acquisition run record (gitleaks + consent-gated eslint/semgrep/jscpd). |

`flow_coverage.json` is listed here at `analysis` phase per `ARTIFACT_DEFINITIONS`
even though it's computed after execution — the phase tag reflects where it's
declared in the registry, not a strict pipeline-order guarantee.

The design-assessment portion may include observational contract assessment.
That mode infers existing contracts from the repository artifacts and inspected
code: invariants, trust boundaries, preconditions, postconditions, data
lifecycle obligations, and critical-flow guarantees. It should attack those
inferred contracts with concrete counterexamples and report evidenced gaps using
categories such as `inferred_contract_gap`, `trust_boundary_gap`,
`invariant_counterexample`, and `critical_invariant_coverage_gap`. It must not
invent a new contract DSL, create a remediation plan, edit source code, or turn
audit-code into an implementation pipeline.

### Execution

| Artifact | Format | Purpose |
|---|---|---|
| `scope.json` | JSON | How this run was scoped (`full` vs. `delta` with `--since` seed/expanded file sets). |
| `coverage_matrix.json` | JSON | Task allocation matrix: files × lens buckets, tracks which are queued/complete. |
| `runtime_validation_tasks.json` | JSON | Runtime-validation task specs derived from risk + coverage. |
| `runtime_validation_report.json` | JSON | Runtime-validation results (initial + import-refreshed). |
| `external_analyzer_results.json` | JSON | Normalized findings from acquired external analyzers. |
| `syntax_resolution_status.json` | JSON | Per-file syntax-parse status and failures. |
| `audit_results.jsonl` | **NDJSON** | Ingested `AuditResult` records, one per line — not a `.json` array. |
| `audit_tasks.json` | JSON | Task specifications for external (host-delegated) audit execution. |
| `audit_plan_metrics.json` | JSON | Planning metrics and cost estimates for the current task set. |
| `task_affinity_graph.json` | JSON | Provider-neutral task-affinity graph derived from `audit_tasks.json`; partitioned just-in-time at dispatch, never persisted back. |
| `requeue_tasks.json` | JSON | Re-audit tasks derived from coverage/flow-coverage gaps. |
| `access_memory.json` | JSON | Per-run access-memory: deterministic path-level summary harvested from the ingested result ledger (frequency + step-ordinal recency + lenses), used to bias later packet composition toward continuity. Raw counters only; the ranking that consumes them is derived JIT at dispatch. |

### Reporting

| Artifact | Format | Purpose | Deliverable? |
|---|---|---|---|
| `audit-report.md` | **Markdown** | Human-readable rendered report. | **Promoted** on completion. |
| `audit-findings.json` | JSON | Canonical machine contract (`AuditFindingsReport`) — source of truth. | **Promoted** on completion. |
| `synthesis-narrative.json` | JSON | Marker: whether the optional LLM narrative pass (themes/exec-summary/top-risks) was `applied` or `omitted`. | internal |

`audit-report.md` and `audit-findings.json` are co-produced by
`synthesis_executor` in one call — `audit-report.md` is the render of
`audit-findings.json`, not an independently-derived artifact.

### Supervisor

| Artifact | Format | Purpose |
|---|---|---|
| `audit_state.json` | JSON | Orchestrator state snapshot (stateless — re-derivable from the rest of the bundle). |
| `artifact_metadata.json` | JSON | Per-artifact staleness metadata (recorded upstream revisions/hashes). |
| `tooling_manifest.json` | JSON | Detected tooling/analyzer versions (rebuilt fresh every `advanceAudit` call — never stale by construction). |
