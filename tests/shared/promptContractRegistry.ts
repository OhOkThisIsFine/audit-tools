import type { ZodTypeAny } from "zod";

import { charterLaneSchema } from "../../src/audit/cli/laneValidators.js";
import { renderCharterDeltaPrompt } from "../../src/audit/cli/charterDeltaPrompt.js";
import { renderCharterKindLanePrompt } from "../../src/audit/cli/charterExtractionPrompt.js";
import { renderIntentEquivalencePrompt } from "../../src/audit/cli/nextStepCommand.js";
import { findingContractPromptLines } from "../../src/audit/contracts/findingContractPrompt.js";
import { WorkerFindingSchema } from "../../src/audit/contracts/workerSchemas.js";
import { renderCriticalFlowFallbackPrompt } from "../../src/audit/reporting/criticalFlowFallbackPrompt.js";
import { renderSynthesisNarrativePrompt } from "../../src/audit/reporting/synthesisNarrativePrompt.js";
import { renderSecondOrderAdversaryPrompt } from "../../src/audit/systemic/secondOrderAdversaryPrompt.js";
import {
  CP_ARTIFACT_NAMES,
  type ContractPipelineArtifactName,
} from "../../src/remediate/contractPipeline/artifactStore.js";
import { IntakeSummarySchema, intakePaths } from "../../src/remediate/intake.js";
import {
  renderContractPipelinePrompt,
  renderContractRepairPrompt,
} from "../../src/remediate/steps/contractPipelinePrompts.js";
import { synthesizeIntakePrompt } from "../../src/remediate/steps/prompts.js";
import { CharterDeltaSubmissionSchema } from "../../src/shared/decompose/charterExtraction.js";
import { SystemicChallengeSubmissionSchema } from "../../src/shared/decompose/systemicChallenge.js";
import { CriticalFlowFallbackResultSchema } from "../../src/shared/types/flows.js";
import { SynthesisNarrativeSchema } from "../../src/shared/types/finding.js";
import { IntentEquivalenceVerdictSchema } from "../../src/audit/orchestrator/intentEquivalenceExecutor.js";

export interface PromptContractRegistryRow {
  builder: string;
  file: string;
  disposition: "derived" | "projection" | "declared-gap";
  schema?: { name: string; file: string; object?: ZodTypeAny };
  projectionFields?: string[];
  gapReason?: string;
  render?: () => string;
}

const artifactPaths = Object.fromEntries(
  CP_ARTIFACT_NAMES.map((name) => [name, `registry-fixture/${name}.json`]),
) as Record<ContractPipelineArtifactName, string>;

const renderPipeline = (role: string): (() => string) => () =>
  renderContractPipelinePrompt({ role, artifactPaths }).prompt;

const renderRepair = (
  target: "finalized_module_contracts" | "obligation_ledger" | "contract_assessment_report",
): (() => string) => () =>
  renderContractRepairPrompt({
    target,
    instruction: "Repair the registered contract.",
    artifactPaths,
  }).prompt;

const intakeRender = (): string =>
  synthesizeIntakePrompt(
    "registry-fixture/source-manifest.json",
    [],
    intakePaths("registry-fixture"),
    false,
  );

const pipelineProjectionRows: PromptContractRegistryRow[] = [
  {
    builder: "renderContractPipelinePrompt[goal_normalization]",
    schema: { name: "validateGoalSpec", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "objective", "non_goals", "success_criteria", "source_type"],
    render: renderPipeline("goal_normalization"),
  },
  {
    builder: "renderContractPipelinePrompt[context_collection]",
    schema: { name: "validateContextBundle", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "entries.path", "entries.kind", "entries.relevance_reason", "context_summary"],
    render: renderPipeline("context_collection"),
  },
  {
    builder: "renderContractPipelinePrompt[decomposition]",
    schema: { name: "validateModuleDecomposition", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "modules.name", "modules.responsibilities", "modules.file_scope", "modules.source_work_block_ids", "modules.prepares_seam_ids"],
    render: renderPipeline("decomposition"),
  },
  {
    builder: "renderContractPipelinePrompt[module_contract_drafting]",
    schema: { name: "validateModuleContracts", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "module_contracts.name", "module_contracts.inputs", "module_contracts.outputs", "module_contracts.invariants", "module_contracts.side_effects", "module_contracts.validation_boundary", "module_contracts.failure_modes", "module_contracts.neighbor_needs"],
    render: renderPipeline("module_contract_drafting"),
  },
  {
    builder: "renderContractPipelinePrompt[seam_reconciliation]",
    schema: { name: "validateSeamReconciliationReport", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "mismatches.seam_id", "mismatches.module_a", "mismatches.module_b", "mismatches.description", "mismatches.resolution.decision", "mismatches.resolution.agreed_interface"],
    render: renderPipeline("seam_reconciliation"),
  },
  {
    builder: "renderContractPipelinePrompt[contract_finalization]",
    schema: { name: "validateFinalizedModuleContracts", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "module_contracts.name", "module_contracts.inputs", "module_contracts.outputs", "module_contracts.invariants", "module_contracts.side_effects", "module_contracts.validation_boundary", "module_contracts.failure_modes", "module_contracts.seam_adjustments"],
    render: renderPipeline("contract_finalization"),
  },
  {
    builder: "renderContractPipelinePrompt[cyclic_seam_resolution]",
    schema: { name: "validateCyclicSeamResolution", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "cycles.members", "cycles.break_strategy", "cycles.resolution_description", "cycles.exception_registration", "status"],
    render: renderPipeline("cyclic_seam_resolution"),
  },
  {
    builder: "renderContractPipelinePrompt[obligation_ledger]",
    schema: { name: "validateObligationLedger", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "obligations.id", "obligations.description", "obligations.kind", "obligations.depends_on", "obligations.status"],
    render: renderPipeline("obligation_ledger"),
  },
  {
    builder: "renderContractPipelinePrompt[critique]",
    schema: { name: "validateConceptualDesignCritique", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "items.id", "items.kind", "items.description", "items.severity", "verdict"],
    render: renderPipeline("critique"),
  },
  {
    builder: "renderContractPipelinePrompt[test_validator_plan]",
    schema: { name: "validateTestValidatorPlan", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "test_specs.obligation_id", "test_specs.name", "test_specs.kind", "test_specs.assertions", "test_specs.inapplicable_claim.obligation_id", "test_specs.inapplicable_claim.reason"],
    render: renderPipeline("test_validator_plan"),
  },
  {
    builder: "renderContractPipelinePrompt[assessment]",
    schema: { name: "validateContractAssessmentReport", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "findings.obligation_id", "findings.status", "findings.evidence", "findings.rationale", "verdict"],
    render: renderPipeline("assessment"),
  },
  {
    builder: "renderContractPipelinePrompt[critic]",
    schema: { name: "validateCounterexample", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "counterexamples.id", "counterexamples.claim", "counterexamples.reproduction_steps", "counterexamples.expected", "counterexamples.actual", "counterexamples.violated_obligation_ids"],
    render: renderPipeline("critic"),
  },
  {
    builder: "renderContractPipelinePrompt[judge]",
    schema: { name: "validateJudgeReport", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "verdict", "classifications.counterexample_id", "classifications.classification", "classifications.rationale", "repair_directive.target", "repair_directive.instruction"],
    render: renderPipeline("judge"),
  },
  {
    builder: "renderContractPipelinePrompt[implementation_planning]",
    schema: { name: "validateImplementationDAG", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "nodes.id", "nodes.title", "nodes.description", "nodes.satisfies_obligations", "nodes.addresses_counterexamples", "nodes.addressed_critique_items", "nodes.depends_on", "nodes.verification_obligation_ids", "nodes.targeted_commands", "nodes.status", "edges.from", "edges.to", "edges.kind"],
    render: renderPipeline("implementation_planning"),
  },
  {
    builder: "renderContractPipelinePrompt[closing]",
    schema: { name: "validateVerificationReport", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "findings.finding_id", "findings.traces.trace_id", "findings.traces.kind", "findings.traces.label", "findings.traces.evidence", "findings.traces.status", "findings.overall_status", "overall_status"],
    render: renderPipeline("closing"),
  },
  {
    builder: "renderContractRepairPrompt[finalized_module_contracts]",
    schema: { name: "validateFinalizedModuleContracts", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "module_contracts"],
    render: renderRepair("finalized_module_contracts"),
  },
  {
    builder: "renderContractRepairPrompt[obligation_ledger]",
    schema: { name: "validateObligationLedger", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "obligations"],
    render: renderRepair("obligation_ledger"),
  },
  {
    builder: "renderContractRepairPrompt[contract_assessment_report]",
    schema: { name: "validateContractAssessmentReport", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "findings", "verdict"],
    render: renderRepair("contract_assessment_report"),
  },
].map((row) => ({
  ...row,
  file: "src/remediate/steps/contractPipelinePrompts.ts",
  disposition: "projection",
}));

const DRIVER_GAP = "driver-facing operator prompt — no worker output contract";

const reconciliationGapRows: PromptContractRegistryRow[] = [
  ["renderCharterClarificationPrompt", "src/audit/cli/charterClarificationPrompt.ts", DRIVER_GAP],
  ["renderConfirmIntentPrompt", "src/audit/cli/confirmIntentStep.ts", DRIVER_GAP],
  ["renderAnalyzerConsentPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["renderAnalyzerInstallPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["renderEdgeReasoningDispatchPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["renderPresentReportPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["ambiguityReviewPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["clarificationPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["collectIntakeClarificationsPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["collectStartingPointPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["reviewApprovalPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["triagePrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["renderBlockedStepPrompt", "src/shared/io/stepContractWriter.ts", DRIVER_GAP],
  ["renderContractPipelinePrompt", "src/remediate/steps/contractPipelinePrompts.ts", "multi-contract dispatcher — branch projection rows are registered separately"],
  ["renderContractRepairPrompt", "src/remediate/steps/contractPipelinePrompts.ts", "multi-contract dispatcher — repair-target projection rows are registered separately"],
  ["synthesizeIntakePrompt", "src/remediate/steps/prompts.ts", "multi-artifact worker prompt — output-material rows are registered separately"],
  ["currentPromptPath", "src/shared/io/stepContractWriter.ts", "path helper matched by the prompt-name scan — no rendered output contract"],
  ["buildCacheablePrompt", "src/shared/prompts.ts", "generic prompt composition helper — no worker output contract"],
  ["quotePromptCommandArg", "src/shared/tooling/exec.ts", "command quoting helper matched by the prompt-name scan — no rendered output contract"],
  ["renderPromptCommand", "src/shared/tooling/exec.ts", "command rendering helper matched by the prompt-name scan — no worker output contract"],
  ["toPromptPathToken", "src/shared/tooling/exec.ts", "path token helper matched by the prompt-name scan — no rendered output contract"],
].map(([builder, file, gapReason]) => ({
  builder,
  file,
  disposition: "declared-gap",
  gapReason,
}));

export const promptContractRegistry: readonly PromptContractRegistryRow[] = [
  ...pipelineProjectionRows,
  {
    builder: "synthesizeIntakePrompt[intake_summary]",
    file: "src/remediate/steps/prompts.ts",
    disposition: "derived",
    schema: { name: "IntakeSummarySchema", file: "src/remediate/intake.ts", object: IntakeSummarySchema },
    render: intakeRender,
  },
  {
    builder: "synthesizeIntakePrompt[intent_checkpoint]",
    file: "src/remediate/steps/prompts.ts",
    disposition: "projection",
    schema: { name: "buildConfirmIntentStep draft reader", file: "src/remediate/steps/nextStep.ts" },
    projectionFields: ["schema_version", "confirmed_at", "confirmed_by", "scope_summary", "intent_summary", "filters", "pre_draft_questions", "closing_action"],
    render: intakeRender,
  },
  {
    builder: "synthesizeIntakePrompt[remediation_brief]",
    file: "src/remediate/steps/prompts.ts",
    disposition: "declared-gap",
    gapReason: "worker-authored Markdown launch brief has a prose section list but no parsing schema",
  },
  {
    builder: "renderCharterKindLanePrompt",
    file: "src/audit/cli/charterExtractionPrompt.ts",
    disposition: "derived",
    schema: { name: "charterLaneSchema", file: "src/audit/cli/laneValidators.ts", object: charterLaneSchema("stated", new Set()) },
    render: () => renderCharterKindLanePrompt({ structure_decomposition: { generated_at: "2026-01-01T00:00:00.000Z", target: "structure", node_universe_size: 0, source_ids: ["call_import"], consensus: [], contested: [], findings: [] } }, { kind: "stated", submissionPath: "registry-fixture/submission.json", packetPath: "registry-fixture/packet.json" }),
  },
  {
    builder: "renderCharterDeltaPrompt",
    file: "src/audit/cli/charterDeltaPrompt.ts",
    disposition: "derived",
    schema: { name: "CharterDeltaSubmissionSchema", file: "src/shared/decompose/charterExtraction.ts", object: CharterDeltaSubmissionSchema },
    render: () => renderCharterDeltaPrompt({}, { submissionPath: "registry-fixture/submission.json" }),
  },
  {
    builder: "renderSecondOrderAdversaryPrompt",
    file: "src/audit/systemic/secondOrderAdversaryPrompt.ts",
    disposition: "derived",
    schema: { name: "SystemicChallengeSubmissionSchema", file: "src/shared/decompose/systemicChallenge.ts", object: SystemicChallengeSubmissionSchema },
    render: () => renderSecondOrderAdversaryPrompt({ round: 1, priorFindingCount: 0, metrics: { rollups: [], max_fan_out: 0, total_edges: 0, metric_covered_nodes: 0 }, submissionPath: "registry-fixture/submission.json" }),
  },
  {
    builder: "renderSynthesisNarrativePrompt",
    file: "src/audit/reporting/synthesisNarrativePrompt.ts",
    disposition: "derived",
    schema: { name: "SynthesisNarrativeSchema", file: "src/shared/types/finding.ts", object: SynthesisNarrativeSchema },
    render: () => renderSynthesisNarrativePrompt({ findings: [], summary: { finding_count: 0, work_block_count: 0 } } as unknown as Parameters<typeof renderSynthesisNarrativePrompt>[0]),
  },
  {
    builder: "renderCriticalFlowFallbackPrompt",
    file: "src/audit/reporting/criticalFlowFallbackPrompt.ts",
    disposition: "derived",
    schema: { name: "CriticalFlowFallbackResultSchema", file: "src/shared/types/flows.ts", object: CriticalFlowFallbackResultSchema },
    render: () => renderCriticalFlowFallbackPrompt({ flows: [] } as Parameters<typeof renderCriticalFlowFallbackPrompt>[0]),
  },
  {
    builder: "renderContractReviewPrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "declared-gap",
    schema: { name: "consumeArraySubmission<Finding>", file: "src/audit/cli/nextStepHelpers.ts" },
    gapReason: "ingestion validates only a tolerant array envelope before later grounding; no zod schema parses each finding",
  },
  {
    builder: "renderConceptualReviewPrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "declared-gap",
    schema: { name: "consumeArraySubmission<Finding>", file: "src/audit/cli/nextStepHelpers.ts" },
    gapReason: "ingestion validates only a tolerant array envelope before later grounding; no zod schema parses each finding",
  },
  {
    builder: "renderConceptualPerspectivePrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "declared-gap",
    schema: { name: "consumeArraySubmission<Finding>", file: "src/audit/cli/nextStepHelpers.ts" },
    gapReason: "perspective submissions become judge inputs without a zod item schema",
  },
  {
    builder: "renderConceptualJudgePrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "declared-gap",
    schema: { name: "consumeArraySubmission<Finding>", file: "src/audit/cli/nextStepHelpers.ts" },
    gapReason: "final conceptual-review ingestion validates only a tolerant array envelope; no zod schema parses each finding",
  },
  {
    builder: "buildEdgeReasoningPrompt",
    file: "src/audit/orchestrator/edgeReasoning.ts",
    disposition: "declared-gap",
    schema: { name: "applyEdgeReasoning manual guards", file: "src/audit/orchestrator/edgeReasoning.ts" },
    gapReason: "EdgeReasoningResults is a TypeScript interface and ingestion uses manual field guards, not zod",
  },
  {
    builder: "renderIntentEquivalencePrompt",
    file: "src/audit/cli/nextStepCommand.ts",
    disposition: "derived",
    schema: { name: "IntentEquivalenceVerdictSchema", file: "src/audit/orchestrator/intentEquivalenceExecutor.ts", object: IntentEquivalenceVerdictSchema },
    render: () => renderIntentEquivalencePrompt({ verdictPath: "registry-fixture/verdict.json", continueCommand: "audit-code next-step", pending: { prior_prose: "prior", current_prose: "current", prior_hash: "prior-hash", new_hash: "new-hash" } }),
  },
  {
    builder: "findingContractPromptLines",
    file: "src/audit/contracts/findingContractPrompt.ts",
    disposition: "derived",
    schema: { name: "WorkerFindingSchema", file: "src/audit/contracts/workerSchemas.ts", object: WorkerFindingSchema },
    render: () => findingContractPromptLines().join("\n"),
  },
  {
    builder: "buildPrompt",
    file: "src/audit/cli/dispatch/hostHandoff.ts",
    disposition: "declared-gap",
    schema: { name: "parseHostResult manual envelope", file: "src/audit/cli/dispatch/hostHandoff.ts" },
    gapReason: "the raw audit host-result envelope is manually enforced; only nested findings are zod-backed",
  },
  {
    builder: "buildPrompt",
    file: "src/remediate/steps/dispatch/hostHandoff.ts",
    disposition: "declared-gap",
    schema: { name: "parseResult manual exact-key validator", file: "src/remediate/steps/dispatch/hostHandoff.ts" },
    gapReason: "remediation host-result and host-decision envelopes use a manual exact-key validator, not zod",
  },
  ...reconciliationGapRows,
];
