export interface ExecutorDefinition {
  id: string;
  obligation_ids: string[];
  description: string;
}

export const EXECUTOR_REGISTRY: ExecutorDefinition[] = [
  {
    id: "intake_executor",
    obligation_ids: ["repo_manifest", "file_disposition"],
    description:
      "Create intake artifacts for repository discovery and disposition.",
  },
  {
    id: "structure_executor",
    obligation_ids: ["structure_artifacts"],
    description:
      "Build structure artifacts such as units, surfaces, graphs, flows, and risk.",
  },
  {
    id: "graph_enrichment_executor",
    obligation_ids: ["graph_enrichment_current"],
    description:
      "Layer optional language-analyzer edges onto the deterministic graph (regex floor preserved); record analyzer provenance.",
  },
  {
    id: "design_assessment_executor",
    obligation_ids: ["design_assessment_current"],
    description:
      "Run deterministic structural analysis to assess overall project design.",
  },
  {
    id: "design_review",
    obligation_ids: ["design_review_completed"],
    description:
      "Pause the pipeline and delegate a holistic project design review to the active LLM agent.",
  },
  {
    id: "planning_executor",
    obligation_ids: ["planning_artifacts"],
    description:
      "Build coverage, tasks, runtime validation planning artifacts, and related planning outputs.",
  },
  {
    id: "result_ingestion_executor",
    obligation_ids: ["audit_results_ingested"],
    description:
      "Ingest available audit result artifacts and refresh dependent coverage artifacts.",
  },
  {
    id: "runtime_validation_executor",
    obligation_ids: ["runtime_validation_current"],
    description: "Merge runtime validation evidence updates when provided.",
  },
  {
    id: "runtime_validation_update_executor",
    obligation_ids: [],
    description: "Merge imported runtime validation evidence updates.",
  },
  {
    id: "synthesis_executor",
    obligation_ids: ["synthesis_current"],
    description:
      "Emit the canonical audit-findings.json and render the deterministic Markdown audit report.",
  },
  {
    id: "synthesis_narrative_executor",
    obligation_ids: ["synthesis_narrative_current"],
    description:
      "Resolve the optional synthesis narrative (themes, executive summary, top risks); omit deterministically without a provider.",
  },
  {
    id: "external_analyzer_import_executor",
    obligation_ids: [],
    description:
      "Import normalized external analyzer results into the artifact set.",
  },
  {
    id: "auto_fix_executor",
    obligation_ids: ["auto_fixes_applied"],
    description:
      "Run configured deterministic code formatters to apply surface-level fixes automatically.",
  },
  {
    id: "syntax_resolution_executor",
    obligation_ids: ["syntax_resolved"],
    description:
      "Run deterministic static analysis/compilers and extract any remaining unfixable syntactical errors into external signals.",
  },
  {
    id: "agent",
    obligation_ids: ["audit_tasks_completed"],
    description:
      "Pause the pipeline and delegate pending codebase review tasks or syntax resolutions to the active LLM agent.",
  },
];
