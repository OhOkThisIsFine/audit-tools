// Declared in its own module BELOW both `artifactStore.ts` and
// `semanticProjection.ts`: artifactStore imports values from semanticProjection,
// and semanticProjection needs this name type — which closed a type-only import
// cycle. `artifactStore.ts` re-exports both symbols, so every existing importer
// is unchanged and there is exactly ONE runtime copy of the array.

/**
 * The canonical contract-pipeline artifact names, in dependency order. The ORDER
 * is load-bearing: the dependency DAG in `artifactStore.ts` and the phase
 * iteration in `steps/contractPipeline.ts` both read it.
 */
export const CP_ARTIFACT_NAMES = [
  "goal_spec",
  "context_bundle",
  "module_decomposition",
  "module_contracts",
  "seam_reconciliation_report",
  "finalized_module_contracts",
  "conceptual_design_critique",
  "obligation_ledger",
  "cyclic_seam_resolution",
  "test_validator_plan",
  "contract_assessment_report",
  "counterexample",
  "judge_report",
  "implementation_dag",
  "verification_report",
] as const;

export type ContractPipelineArtifactName = (typeof CP_ARTIFACT_NAMES)[number];
