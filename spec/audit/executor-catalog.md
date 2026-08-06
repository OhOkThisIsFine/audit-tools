# Executor catalog

## Purpose

This document defines the bounded executable steps available to the orchestrator.

## Source of truth

The canonical, machine-readable registry is `EXECUTOR_REGISTRY` in
`src/audit/orchestrator/executors.ts` — one entry per executor, each declaring an `id`, a
`kind` (`deterministic` runs inline; `host_delegation` pauses the pipeline and
asks the active LLM/host agent to do the work), and the `obligation_ids` it
satisfies. `nextStep.ts`'s priority chain (see `CLAUDE.md` → audit-code
architecture) picks the highest-priority unsatisfied obligation and dispatches
to whichever executor's `obligation_ids` includes it. This document is the
declarative reference; that table is authoritative. For each artifact's exact
filename/format/staleness, see [`artifact-contract.md`](artifact-contract.md)
and [`dependency-map.md`](dependency-map.md) — not duplicated here.

**Executor → artifact mapping lives in one place.** Which executor produces which
artifact is hand-maintained authoritatively in
[`dependency-map.md`](dependency-map.md) → *"Which executor produces each
artifact"* (the by-artifact home). This catalog is the by-executor view and
deliberately does **not** re-list producers, so the relation can't drift between
two docs — consult dependency-map.md for the producing/refreshing executors of any
artifact.

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
`executorRunners.ts`) instead.

## Executors

### Intake

| Executor | Kind | Obligation | Notes |
|---|---|---|---|
| `intake_executor` | deterministic | `repo_manifest`, `file_disposition` | one call, one obligation with two artifact names |
| `intent_checkpoint_executor` | host_delegation | `intent_checkpoint_current` | — |
| `intent_equivalence_executor` | host_delegation | `intent_equivalence_current` | DD-9 intent-equivalence gate. A prose-only delta emits the bounded judge step; every other arm (baseline stamp, gate-version stale, structured delta) resolves deterministically via the runner — mirroring `charter_extraction`'s emit-vs-run gating in `nextStepHelpers` |
| `auto_fix_executor` | deterministic | `auto_fixes_applied` | — |

### Analysis

| Executor | Kind | Obligation | Notes |
|---|---|---|---|
| `external_analyzer_acquisition_executor` | deterministic | `external_analyzers_current` | acquisition marker; triggers `external_analyzer_results.json` |
| `structure_executor` | deterministic | `structure_artifacts` | emits all structure artifacts in one call (merges any persisted `critical-flow-fallback.json` host enrichment into `critical_flows.json`) |
| `critical_flow_fallback_executor` | host_delegation | `critical_flow_fallback_current` | the durable host-authored flow enrichment. Fires ONLY when the deterministic flow inference set `critical_flows.fallback_required`; emits a host step to author the enrichment, otherwise self-satisfies. Persisting the submission re-stales `critical_flows.json` so the structure phase merges it |
| `graph_enrichment_executor` | deterministic | `graph_enrichment_current` | records the graph-enrichment marker (+ refreshes `graph_bundle.json` when analyzer edges merge in) |
| `design_assessment_executor` | deterministic | `design_assessment_current` | deterministic design pass |
| `structure_decomposition_executor` | deterministic | `structure_decomposition_current` | overlay-and-delta structure operator |
| `docs_digest_executor` | deterministic | `docs_digest_current` | bounded telos extraction over the doc universe (change 3); renders into the confirm-intent prompt |
| `charter_extraction_executor` | host_delegation | `charter_extraction_current` | Phase C.1 charter layer — teleologies/charters ONLY, three blind estimator lanes fed channel-pure evidence packets; the tool grounds file scopes against the repo universe and joins lanes by file-set overlap (decomposition = hint). At a deep+ ceiling emits the lane step, otherwise the runner omits deterministically at the default shallow ceiling. Sets `deltas_pending` when it produced ≥1 subsystem for the independent delta pass |
| `charter_delta_executor` | host_delegation | `charter_delta_current` | Phase C.2 — the INDEPENDENT delta-miner + triangulation engine: routes+gates the channel-pair deltas, persists the triangulated teloses + disagreement density + goal_graph, and (deepest ceiling only) admits gate-surviving True nominations; emits an LLM step when the register is `deltas_pending`, otherwise settles deterministically (no author marks its own homework) |
| `design_review_contract` | host_delegation | `design_review_contract_completed` | contract-assessment mode — invariants/boundaries/obligations |
| `design_review_conceptual` | host_delegation | `design_review_conceptual_completed` | conceptual-critique mode — philosophy/alternatives |
| `charter_clarification_executor` | host_delegation | `charter_clarification_current` | Phase D triangulation loop; assembles deterministically at a shallow ceiling / zero attention |
| `systemic_challenge_executor` | host_delegation | `systemic_challenge_current` | Phase E second-order-adversary loop-until-dry; omits deterministically at a shallow ceiling |
| `syntax_resolution_executor` | deterministic | `syntax_resolved` | — |

### Execution

| Executor | Kind | Obligation | Notes |
|---|---|---|---|
| `planning_executor` | deterministic | `planning_artifacts` | emits all planning artifacts in one call |
| `rolling_dispatch_executor` | host_delegation | `audit_tasks_completed` | consumes `audit_tasks.json`; drives host-subagent or in-process dispatch until results are produced |
| `external_analyzer_import_executor` | deterministic | *(none — `preferredExecutor` only)* | imported normalized external-analyzer results |
| `result_ingestion_executor` | deterministic | `audit_results_ingested` | ingests into `audit_results.jsonl` and refreshes the downstream planning/coverage artifacts |
| `runtime_validation_executor` | deterministic | `runtime_validation_current` | produces the initial runtime-validation report (+ adds tasks/metrics when selective deepening applies) |
| `runtime_validation_update_executor` | deterministic | *(none — `preferredExecutor` only)* | refreshes the runtime-validation report from imported evidence (+ adds tasks/metrics when selective deepening applies) |

### Reporting

| Executor | Kind | Obligation | Notes |
|---|---|---|---|
| `synthesis_executor` | deterministic | `synthesis_current` | co-produces the machine contract + its human render |
| `synthesis_narrative_executor` | host_delegation | `synthesis_narrative_current` | optional LLM narrative pass (+ re-renders the contract/report with the enriched narrative) |

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
