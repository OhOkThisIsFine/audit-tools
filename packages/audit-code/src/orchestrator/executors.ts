export interface ExecutorDefinition {
  id: string;
  kind: "deterministic" | "host_delegation";
  obligation_ids: string[];
  description: string;
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
    description:
      "Pause for the host to discover and confirm the provider pool (capability tiers, quota state); writes provider_confirmation.json.",
  },
  {
    id: "intake_executor",
    kind: "deterministic",
    obligation_ids: ["repo_manifest", "file_disposition"],
    description:
      "Create intake artifacts for repository discovery and disposition.",
  },
  {
    id: "intent_checkpoint_executor",
    kind: "host_delegation",
    obligation_ids: ["intent_checkpoint_current"],
    description:
      "Pause for the host to confirm scope and intent (the confirm_intent step writes intent_checkpoint.json); deterministic auto-complete writes a default full-scope checkpoint when run headless.",
  },
  {
    id: "structure_executor",
    kind: "deterministic",
    obligation_ids: ["structure_artifacts"],
    description:
      "Build structure artifacts such as units, surfaces, graphs, flows, and risk.",
  },
  {
    id: "graph_enrichment_executor",
    kind: "deterministic",
    obligation_ids: ["graph_enrichment_current"],
    description:
      "Layer optional language-analyzer edges onto the deterministic graph (regex floor preserved); record analyzer provenance.",
  },
  {
    id: "design_assessment_executor",
    kind: "deterministic",
    obligation_ids: ["design_assessment_current"],
    description:
      "Run deterministic structural analysis to assess overall project design.",
  },
  {
    id: "design_review_contract",
    kind: "host_delegation",
    obligation_ids: ["design_review_contract_completed"],
    description:
      "Pause the pipeline and delegate the contract-assessment pass (adversarial: inferred contracts, counterexamples, trust boundaries) to the active LLM agent.",
  },
  {
    id: "design_review_conceptual",
    kind: "host_delegation",
    obligation_ids: ["design_review_conceptual_completed"],
    description:
      "Pause the pipeline and delegate the conceptual-design-critique pass (generative: tool opportunities, architecture patterns, simplification, integration, missing capabilities) to the active LLM agent.",
  },
  {
    id: "planning_executor",
    kind: "deterministic",
    obligation_ids: ["planning_artifacts"],
    description:
      "Build coverage, tasks, runtime validation planning artifacts, and related planning outputs.",
  },
  {
    id: "result_ingestion_executor",
    kind: "deterministic",
    obligation_ids: ["audit_results_ingested"],
    description:
      "Ingest available audit result artifacts and refresh dependent coverage artifacts.",
  },
  {
    id: "runtime_validation_executor",
    kind: "deterministic",
    obligation_ids: ["runtime_validation_current"],
    description: "Merge runtime validation evidence updates when provided.",
  },
  {
    id: "runtime_validation_update_executor",
    kind: "deterministic",
    obligation_ids: [],
    description: "Merge imported runtime validation evidence updates.",
  },
  {
    id: "synthesis_executor",
    kind: "deterministic",
    obligation_ids: ["synthesis_current"],
    description:
      "Emit the canonical audit-findings.json and render the deterministic Markdown audit report.",
  },
  {
    id: "synthesis_narrative_executor",
    kind: "host_delegation",
    obligation_ids: ["synthesis_narrative_current"],
    description:
      "Pause for the host to supply a synthesis narrative (themes, executive summary, top risks); headless auto-complete writes status:omitted when narrative is disabled.",
  },
  {
    id: "external_analyzer_import_executor",
    kind: "deterministic",
    obligation_ids: [],
    description:
      "Import normalized external analyzer results into the artifact set.",
  },
  {
    id: "auto_fix_executor",
    kind: "deterministic",
    obligation_ids: ["auto_fixes_applied"],
    description:
      "Run configured deterministic code formatters to apply surface-level fixes automatically.",
  },
  {
    id: "syntax_resolution_executor",
    kind: "deterministic",
    obligation_ids: ["syntax_resolved"],
    description:
      "Run deterministic static analysis/compilers and extract any remaining unfixable syntactical errors into external signals.",
  },
  {
    id: "agent",
    kind: "host_delegation",
    obligation_ids: [],
    description:
      "Legacy host-delegation placeholder (no longer owns audit_tasks_completed; superseded by rolling_dispatch_executor). Kept for backward compatibility in ongoing runs.",
  },
  {
    id: "rolling_dispatch_executor",
    kind: "host_delegation",
    obligation_ids: ["audit_tasks_completed"],
    description:
      "Drive the rolling dispatch loop: check quota, dispatch fitting packets to worker sub-agents, fold ingestion inline after each result, and proceed until all pending tasks are complete or a partial-coverage terminal fires.",
  },
];
