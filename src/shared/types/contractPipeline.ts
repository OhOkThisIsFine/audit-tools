/**
 * Contract-pipeline artifact contracts. These represent the bounded roles of
 * the contract-driven implementation pipeline used by remediate-code for
 * free-form feature/change requests that flow through the full
 * goal→context→design→critique→obligations→assessment→critic→judge→
 * implementation DAG before producing a remediation plan.
 *
 * Each artifact carries a `contract_version` field that must match the
 * exported constant so callers can detect version skew without reading the
 * payload.
 *
 * This file is a barrel re-export. The implementation is split by pipeline
 * phase for navigability:
 *
 *   contractPipeline/goal.ts          — GoalSpec, ContextBundle
 *   contractPipeline/design.ts        — DesignSpec, ConceptualDesignCritique
 *   contractPipeline/obligations.ts   — ObligationLedger, TestValidatorPlan,
 *                                       ContractAssessmentReport,
 *                                       CounterexampleReport, JudgeReport
 *   contractPipeline/implementation.ts — ImplementationDAG
 *   contractPipeline/verification.ts  — VerificationReport, SeamNegotiationRecord
 *
 * Add new artifact types to the appropriate phase file, or create a new phase
 * file if the artifact belongs to a new pipeline stage.
 */

export {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
} from "./contractPipeline/goal.js";
export type { GoalSpec, ContextBundleEntry, ContextBundle } from "./contractPipeline/goal.js";

export {
  CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
} from "./contractPipeline/design.js";
export type {
  DesignSpecInvariant,
  DesignSpecModule,
  DesignSpecSideEffect,
  DesignSpecExternalDependency,
  DesignSpecTrustBoundary,
  DesignSpec,
  DesignCritiqueItem,
  ConceptualDesignCritique,
} from "./contractPipeline/design.js";

export {
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
} from "./contractPipeline/obligations.js";
export type {
  ObligationChangeClassification,
  ObligationEntry,
  ObligationLedger,
  TestSpec,
  TestValidatorPlan,
  ContractAssessmentFinding,
  ContractAssessmentReport,
  Counterexample,
  CounterexampleReport,
  CounterexampleClassification,
  JudgedCounterexample,
  JudgeRepairTarget,
  JudgeRepairDirective,
  JudgeReport,
} from "./contractPipeline/obligations.js";

export { CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION } from "./contractPipeline/implementation.js";
export type {
  ImplementationDAGNode,
  ImplementationDAGEdge,
  ImplementationDAG,
} from "./contractPipeline/implementation.js";

export {
  CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
  CONTRACT_PIPELINE_SEAM_NEGOTIATION_VERSION,
} from "./contractPipeline/verification.js";
export type {
  VerificationTraceEntry,
  FindingVerificationTrace,
  VerificationReport,
  SeamRole,
  AgentSeam,
  SeamNegotiationRecord,
} from "./contractPipeline/verification.js";
