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
    // DD-9 intent-equivalence gate. host_delegation: a prose-only delta emits
    // the bounded judge step; every other arm (baseline stamp, gate-version
    // stale, structured delta) resolves deterministically via the runner —
    // mirroring charter_extraction's emit-vs-run gating in nextStepHelpers.
    id: "intent_equivalence_executor",
    kind: "host_delegation",
    obligation_ids: ["intent_equivalence_current"],
  },
  {
    id: "external_analyzer_acquisition_executor",
    kind: "deterministic",
    obligation_ids: ["external_analyzers_current"],
  },
  {
    id: "structure_executor",
    kind: "deterministic",
    obligation_ids: ["structure_artifacts"],
  },
  {
    // Critical-flow LLM fallback. host_delegation (NON-DRAINABLE): when the
    // deterministic flow inference marked itself below the confidence bar it emits
    // a host step; when the bar was met the obligation self-satisfies and this is
    // never selected. The consume path persists the host submission via the
    // deterministic runner (the durable upstream input the structure phase merges).
    id: "critical_flow_fallback_executor",
    kind: "host_delegation",
    obligation_ids: ["critical_flow_fallback_current"],
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
    id: "structure_decomposition_executor",
    kind: "deterministic",
    obligation_ids: ["structure_decomposition_current"],
  },
  {
    // Phase C charter extraction. host_delegation: at a deep+ ceiling it emits an
    // LLM charter-extraction step; at a shallow ceiling (default) the runner omits
    // deterministically (the branch in buildAuditObligations gates emit vs run,
    // mirroring synthesis_narrative).
    id: "charter_extraction_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_extraction_current"],
  },
  {
    // Phase C.2 delta-mining, mirrors charter_extraction. host_delegation: at a
    // deep+ ceiling that produced ≥1 subsystem (charter_register.deltas_pending)
    // it emits an LLM step for the INDEPENDENT delta-miner; otherwise the runner
    // settles the register deterministically (the branch in nextStepHelpers gates
    // emit vs run, mirroring charter_extraction).
    id: "charter_delta_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_delta_current"],
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
    // Phase D charter-clarification triangulation loop. host_delegation (NON-
    // DRAINABLE): at a deep+ ceiling WITH attention > 0 and open interactive
    // questions it emits an LLM step surfacing the VOI-ranked queue; otherwise the
    // runner assembles the loop deterministically (autonomous mode / omit) — the
    // branch in nextStepHelpers gates emit vs run, mirroring charter_extraction.
    id: "charter_clarification_executor",
    kind: "host_delegation",
    obligation_ids: ["charter_clarification_current"],
  },
  {
    // Phase E systemic improvement-seeking challenge loop. host_delegation (NON-
    // DRAINABLE): at a deep+ ceiling it emits a second-order-adversary step
    // (loop-until-dry, optimization/better-way mandate); at a shallow ceiling
    // (default) the runner omits deterministically — the branch in nextStepHelpers
    // gates emit vs run, mirroring charter_clarification.
    id: "systemic_challenge_executor",
    kind: "host_delegation",
    obligation_ids: ["systemic_challenge_current"],
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
  {
    // No obligation_ids: dispatched only via an explicit preferredExecutor
    // (imported runtime-validation evidence), never selected by the priority scan.
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
  {
    // No obligation_ids: dispatched only via an explicit preferredExecutor
    // (imported normalized external-analyzer results), never selected by the scan.
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
  {
    // Legacy host-delegation placeholder: no longer owns audit_tasks_completed
    // (superseded by rolling_dispatch_executor). No obligation_ids; retained only
    // so in-flight runs that still reference "agent" in a persisted artifact resolve.
    id: "agent",
    kind: "host_delegation",
    obligation_ids: [],
  },
  {
    id: "rolling_dispatch_executor",
    kind: "host_delegation",
    obligation_ids: ["audit_tasks_completed"],
  },
  {
    id: "friction_capture_executor",
    kind: "deterministic",
    obligation_ids: ["friction_capture_current"],
  },
];
