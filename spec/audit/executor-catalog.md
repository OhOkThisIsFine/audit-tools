# Executor catalog

## Purpose

This document defines the bounded executable steps available to the orchestrator.

## Source of truth

The canonical, machine-readable registry is `EXECUTOR_REGISTRY` in
`src/audit/orchestrator/executors.ts` — 26 entries, each declaring an `id`, a
`kind` (`deterministic` runs inline; `host_delegation` pauses the pipeline and
asks the active LLM/host agent to do the work), and the `obligation_ids` it
satisfies. `nextStep.ts`'s priority chain (see `CLAUDE.md` → audit-code
architecture) picks the highest-priority unsatisfied obligation and dispatches
to whichever executor's `obligation_ids` includes it. This document is the
declarative reference; that table is authoritative. For each artifact's exact
filename/format/staleness, see [`artifact-contract.md`](artifact-contract.md)
and [`dependency-map.md`](dependency-map.md) — not duplicated here.

Two executors carry `obligation_ids: []` and are never selected by the priority
scan — they run only via an explicit `preferredExecutor` override:
`runtime_validation_update_executor` (imported runtime-validation evidence) and
`external_analyzer_import_executor` (imported normalized external-analyzer
results). One executor, `agent`, is a legacy `host_delegation` placeholder with
`obligation_ids: []` — retained only so in-flight runs that still reference
`"agent"` in a persisted artifact resolve; it no longer owns
`audit_tasks_completed` (superseded by `rolling_dispatch_executor`). One
executor, `friction_capture_executor`, is retained for schema compatibility but
is currently **unreachable** — its obligation (`friction_capture_current`) is
not in `deriveAuditState`'s priority chain, so the engine never selects it; the
actual friction triage fires from the `present_report` terminal step
(`decideAuditFrictionCloseout`, called from `nextStepHelpers.ts`/
`nextStepCommand.ts`) instead.

## Executors

### Intake

| Executor | Kind | Obligation | Produces |
|---|---|---|---|
| `provider_confirmation_executor` | host_delegation | `provider_confirmation` | `provider_confirmation.json` |
| `intake_executor` | deterministic | `repo_manifest`, `file_disposition` | `repo_manifest.json`, `file_disposition.json` (one call, one obligation with two artifact names) |
| `intent_checkpoint_executor` | host_delegation | `intent_checkpoint_current` | `intent_checkpoint.json` |
| `auto_fix_executor` | deterministic | `auto_fixes_applied` | `auto_fixes_applied.json` |

### Analysis

| Executor | Kind | Obligation | Produces |
|---|---|---|---|
| `external_analyzer_acquisition_executor` | deterministic | `external_analyzers_current` | `external_analyzer_acquisition.json` (triggers `external_analyzer_results.json`) |
| `structure_executor` | deterministic | `structure_artifacts` | `unit_manifest.json`, `surface_manifest.json`, `graph_bundle.json`, `critical_flows.json`, `risk_register.json`, `git_history.json` — all in one call |
| `graph_enrichment_executor` | deterministic | `graph_enrichment_current` | `analyzer_capability.json` (+ refreshed `graph_bundle.json` when analyzer edges merge in) |
| `design_assessment_executor` | deterministic | `design_assessment_current` | `design_assessment.json` (deterministic pass) |
| `structure_decomposition_executor` | deterministic | `structure_decomposition_current` | `structure_decomposition.json` (overlay-and-delta structure operator) |
| `charter_extraction_executor` | host_delegation | `charter_extraction_current` | `charter_register.json` (Phase C.1 charter layer — charters ONLY); at a deep+ ceiling emits an LLM charter-extraction step, otherwise the runner omits deterministically at the default shallow ceiling. Sets `deltas_pending` when it produced ≥1 subsystem for the independent delta pass |
| `charter_delta_executor` | host_delegation | `charter_delta_current` | updates `charter_register.json` (Phase C.2 — the INDEPENDENT delta-miner routes+gates the deltas + goal_graph over the assembled charters); emits an LLM step when the register is `deltas_pending`, otherwise settles deterministically (no author marks its own homework) |
| `design_review_contract` | host_delegation | `design_review_contract_completed` | updates `design_assessment.json` (contract-assessment mode — invariants/boundaries/obligations) |
| `design_review_conceptual` | host_delegation | `design_review_conceptual_completed` | updates `design_assessment.json` (conceptual-critique mode — philosophy/alternatives) |
| `charter_clarification_executor` | host_delegation | `charter_clarification_current` | `charter_clarification.json` (Phase D triangulation loop; assembles deterministically at a shallow ceiling / zero attention) |
| `systemic_challenge_executor` | host_delegation | `systemic_challenge_current` | `systemic_challenge.json` (Phase E second-order-adversary loop-until-dry; omits deterministically at a shallow ceiling) |
| `syntax_resolution_executor` | deterministic | `syntax_resolved` | `syntax_resolution_status.json` |

### Execution

| Executor | Kind | Obligation | Produces |
|---|---|---|---|
| `planning_executor` | deterministic | `planning_artifacts` | `scope.json`, `coverage_matrix.json`, `flow_coverage.json`, `runtime_validation_tasks.json` (+ `runtime_validation_report.json` when tasks exist), `audit_tasks.json`, `audit_plan_metrics.json`, `task_affinity_graph.json`, `requeue_tasks.json` — all in one call |
| `rolling_dispatch_executor` | host_delegation | `audit_tasks_completed` | consumes `audit_tasks.json`; drives host-subagent or in-process dispatch until results are produced |
| `external_analyzer_import_executor` | deterministic | *(none — `preferredExecutor` only)* | `external_analyzer_results.json` |
| `result_ingestion_executor` | deterministic | `audit_results_ingested` | ingests into `audit_results.jsonl`; refreshes `coverage_matrix.json`, `flow_coverage.json`, `audit_tasks.json`, `audit_plan_metrics.json`, `requeue_tasks.json` (+ `runtime_validation_tasks.json`/`runtime_validation_report.json` when planned) |
| `runtime_validation_executor` | deterministic | `runtime_validation_current` | initial `runtime_validation_report.json` only — `runtime_validation_tasks.json` is produced by `planning_executor` and refreshed by `result_ingestion_executor` |
| `runtime_validation_update_executor` | deterministic | *(none — `preferredExecutor` only)* | refreshed `runtime_validation_report.json` from imported evidence |

### Reporting

| Executor | Kind | Obligation | Produces |
|---|---|---|---|
| `synthesis_executor` | deterministic | `synthesis_current` | `audit-report.md` + `audit-findings.json` (co-produced) |
| `synthesis_narrative_executor` | host_delegation | `synthesis_narrative_current` | `synthesis-narrative.json` (+ re-renders `audit-findings.json`/`audit-report.md` with the enriched narrative) |

### Legacy / unreachable

| Executor | Kind | Obligation | Note |
|---|---|---|---|
| `agent` | host_delegation | *(none)* | Legacy placeholder for `audit_tasks_completed`, superseded by `rolling_dispatch_executor`. Retained only for persisted-artifact compatibility. |
| `friction_capture_executor` | deterministic | `friction_capture_current` | Unreachable — never produced by `deriveAuditState`'s obligation scan (its id sits in `PRIORITY` only to satisfy the executor-registry-coverage invariant). Friction triage actually fires from the `present_report` terminal step. |

## Bounded-step expectations

Each executor should:

- have clear inputs
- have clear outputs
- verify its own result as much as possible
- avoid mixing unrelated responsibilities
