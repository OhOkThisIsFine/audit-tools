export interface ExecutorDefinition {
  id: string;
  kind: "deterministic" | "host_delegation";
  obligation_ids: string[];
}

/**
 * Returns true when the executor identified by `id` is a host-delegation point
 * (i.e. it pauses the deterministic pipeline and asks the active LLM agent to
 * perform work) rather than a deterministic executor.
 */
export function isHostDelegationExecutor(id: string): boolean {
  const entry = EXECUTOR_REGISTRY.find((e) => e.id === id);
  return entry?.kind === "host_delegation";
}

/**
 * The executor catalog: maps each obligation (via `obligation_ids`) to the
 * executor that satisfies it, and records whether that executor is deterministic
 * or a host-delegation pause (`isHostDelegationExecutor`). Dispatch itself lives
 * in `EXECUTOR_RUNNERS` (`executorRunners.ts`); an executor with an empty
 * `obligation_ids` is *forced-only* — never selected by the priority scan, only
 * dispatched via `advanceAudit`'s `preferredExecutor`.
 */
export const EXECUTOR_REGISTRY: ExecutorDefinition[] = [
  {
    id: "provider_confirmation_executor",
    kind: "host_delegation",
    obligation_ids: ["provider_confirmation"],
  },
  {
    id: "intake_executor",
    kind: "deterministic",
    obligation_ids: ["repo_manifest", "file_disposition"],
  },
  {
    id: "intent_checkpoint_executor",
    kind: "host_delegation",
    obligation_ids: ["intent_checkpoint_current"],
  },
  {
    id: "structure_executor",
    kind: "deterministic",
    obligation_ids: ["structure_artifacts"],
  },
  {
    id: "graph_enrichment_executor",
    kind: "deterministic",
    obligation_ids: ["graph_enrichment_current"],
  },
  {
    id: "design_assessment_executor",
    kind: "deterministic",
    obligation_ids: ["design_assessment_current"],
  },
  {
    id: "design_review_contract",
    kind: "host_delegation",
    obligation_ids: ["design_review_contract_completed"],
  },
  {
    id: "design_review_conceptual",
    kind: "host_delegation",
    obligation_ids: ["design_review_conceptual_completed"],
  },
  {
    id: "planning_executor",
    kind: "deterministic",
    obligation_ids: ["planning_artifacts"],
  },
  {
    id: "result_ingestion_executor",
    kind: "deterministic",
    obligation_ids: ["audit_results_ingested"],
  },
  {
    id: "runtime_validation_executor",
    kind: "deterministic",
    obligation_ids: ["runtime_validation_current"],
  },
  // Forced-only: merges imported runtime-validation evidence; no PRIORITY obligation.
  {
    id: "runtime_validation_update_executor",
    kind: "deterministic",
    obligation_ids: [],
  },
  {
    id: "synthesis_executor",
    kind: "deterministic",
    obligation_ids: ["synthesis_current"],
  },
  {
    id: "synthesis_narrative_executor",
    kind: "host_delegation",
    obligation_ids: ["synthesis_narrative_current"],
  },
  // Forced-only: imports normalized external-analyzer results; no PRIORITY obligation.
  {
    id: "external_analyzer_import_executor",
    kind: "deterministic",
    obligation_ids: [],
  },
  {
    id: "auto_fix_executor",
    kind: "deterministic",
    obligation_ids: ["auto_fixes_applied"],
  },
  {
    id: "syntax_resolution_executor",
    kind: "deterministic",
    obligation_ids: ["syntax_resolved"],
  },
  // Legacy host-delegation placeholder: no longer owns `audit_tasks_completed`
  // (superseded by `rolling_dispatch_executor`); kept for backward compatibility
  // with runs already in flight. No runner — produces the no-progress handoff.
  {
    id: "agent",
    kind: "host_delegation",
    obligation_ids: [],
  },
  // Drives the rolling dispatch loop: check quota, dispatch fitting packets to
  // worker sub-agents, fold ingestion inline after each result, and proceed until
  // all pending tasks complete or a partial-coverage terminal fires. Host-delegated
  // (no deterministic runner) — routed through host dispatch before advanceAudit.
  {
    id: "rolling_dispatch_executor",
    kind: "host_delegation",
    obligation_ids: ["audit_tasks_completed"],
  },
];
