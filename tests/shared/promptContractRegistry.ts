import type { ZodTypeAny } from "zod";

import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";

import { charterLaneSchema } from "../../src/audit/cli/laneValidators.js";
import { renderCharterClarificationPrompt } from "../../src/audit/cli/charterClarificationPrompt.js";
import { renderCharterComparisonPrompt } from "../../src/audit/cli/charterComparisonPrompt.js";
import { renderCharterFidelityPrompt } from "../../src/audit/cli/charterFidelityPrompt.js";
import { renderCharterKindLanePrompt } from "../../src/audit/cli/charterExtractionPrompt.js";
import { renderIntentEquivalencePrompt } from "../../src/audit/cli/nextStepCommand.js";
import { findingContractPromptLines } from "../../src/audit/contracts/findingContractPrompt.js";
import { WorkerFindingSchema } from "../../src/audit/contracts/workerSchemas.js";
import { renderConceptualJudgePrompt } from "../../src/audit/orchestrator/designReviewPrompt.js";
import { ConceptualJudgeSubmissionSchema } from "../../src/audit/types/conceptualAdjudication.js";
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
import {
  CharterComparisonSubmissionSchema,
  CharterFidelitySubmissionSchema,
} from "../../src/shared/decompose/charterExtraction.js";
import { ClarificationAnswersSubmissionSchema } from "../../src/shared/decompose/charterClarification.js";
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

// The two repair TRIGGERS render different prompts (different framing, different
// Required Inputs) against the same output schema, so each is its own registry
// row: a rendered prompt nobody registers is a projection nobody checks.
const renderRepair = (
  target: "finalized_module_contracts" | "obligation_ledger" | "contract_assessment_report",
  trigger: "judge" | "critique" = "judge",
): (() => string) => () =>
  renderContractRepairPrompt({
    trigger,
    target,
    instruction: "Repair the registered contract.",
    artifactPaths,
  }).prompt;

/**
 * The smallest bundle a design-review prompt renders from: one in-scope unit and
 * one manifest file. The manifest entry is load-bearing — the worked example
 * cites `affected_files` from it (`examplePath`), so the example a host copies
 * grounds against the repository instead of quarantining.
 */
const designReviewBundleFixture = {
  unit_manifest: {
    units: [
      {
        unit_id: "u1",
        path: "src/scheduling",
        disposition: "in_scope",
        files: ["src/scheduling/window.ts"],
        required_lenses: ["architecture"],
      },
    ],
  },
  repo_manifest: {
    repository: { name: "registry-fixture" },
    generated_at: "2026-01-01T00:00:00.000Z",
    files: [
      { path: "src/scheduling/window.ts", language: "typescript", size_bytes: 100 },
    ],
  },
} as unknown as ArtifactBundle;

const intakeRender = (): string =>
  synthesizeIntakePrompt(
    "registry-fixture/source-manifest.json",
    [],
    intakePaths("registry-fixture"),
    false,
  );

/**
 * A two-question clarification queue — the smallest fixture that exercises both
 * halves of prompt 10's worked example: the first question supplies the
 * `governs` entry (and its own first account's channel), the second supplies the
 * `leave_open` entry. EXPORTED because the prompt's own pin re-renders from it
 * and parses the example back out; two fixtures would let the registry and the
 * pin drift onto different queues.
 */
export const clarificationBundleFixture: ArtifactBundle = {
  charter_clarification: {
    generated_at: "2026-01-01T00:00:00.000Z",
    target: "charter_clarification",
    ceiling: { rung: "deep" },
    attention: 2,
    asked: [
      {
        request_id: "chq-registry-0001",
        difference_id: "cd-registry-0001",
        subsystem_id: "scheduling",
        dimension: "purpose",
        relation: "incompatible",
        split: { kind: "two_against_one", odd: "stated" },
        accounts: [
          {
            kind: "stated",
            claim: "Gives a dispatcher a delivery window the customer can rely on",
            provenance: [
              { kind: "doc", ref: "docs/scheduling.md#promises", quote: "a window we can keep" },
            ],
          },
          {
            kind: "structural",
            claim: "Groups delivery windows by driver so a driver's day stays contiguous",
            provenance: [
              {
                kind: "code",
                ref: "src/scheduling/window.ts#DeliveryWindow",
                quote: "class DeliveryWindow {",
              },
            ],
          },
          {
            kind: "revealed",
            claim: "Offers as many windows as it can, and re-books the ones the fleet misses",
            provenance: [
              {
                kind: "code",
                ref: "src/scheduling/rebook.ts#rebookOnMiss",
                quote: "function rebookOnMiss(",
              },
              {
                kind: "code",
                ref: "src/scheduling/rebook.ts#RETRY_LIMIT",
                quote: "const RETRY_LIMIT = 5;",
              },
            ],
          },
        ],
        question: "Which account of the delivery-window goal governs?",
        value: { blast_radius: 3, cascade_count: 4 },
        disposition: "interactive",
      },
      {
        request_id: "chq-registry-0002",
        difference_id: "cd-registry-0002",
        dimension: "presence",
        relation: "complementary",
        accounts: [
          {
            kind: "revealed",
            claim: "Keeps a per-driver audit trail of every window change",
            provenance: [
              {
                kind: "code",
                ref: "src/scheduling/audit.ts#recordChange",
                quote: "function recordChange(",
              },
            ],
          },
        ],
        question: "The code keeps a per-driver audit trail. Is that a goal?",
        value: { blast_radius: 1, cascade_count: 0 },
        disposition: "interactive",
      },
    ],
    banked: [],
    findings: [],
    validation_issues: [],
  },
};

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
  {
    builder: "renderContractRepairPrompt[finalized_module_contracts:critique]",
    schema: { name: "validateFinalizedModuleContracts", file: "src/remediate/validation/contractPipeline.ts" },
    projectionFields: ["contract_version", "goal_id", "module_contracts"],
    render: renderRepair("finalized_module_contracts", "critique"),
  },
].map((row) => ({
  ...row,
  file: "src/remediate/steps/contractPipelinePrompts.ts",
  disposition: "projection",
}));

const DRIVER_GAP = "driver-facing operator prompt — no worker output contract";

const reconciliationGapRows: PromptContractRegistryRow[] = [
  ["renderConfirmIntentPrompt", "src/audit/cli/confirmIntentStep.ts", DRIVER_GAP],
  ["renderAnalyzerConsentPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["renderAnalyzerInstallPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["renderEdgeReasoningDispatchPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["renderPresentReportPrompt", "src/audit/cli/prompts.ts", DRIVER_GAP],
  ["ambiguityReviewPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["clarificationPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["collectIntakeClarificationsPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["collectStartingPointPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
  ["extractedPlanDiscardedPrompt", "src/remediate/steps/prompts.ts", DRIVER_GAP],
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
  ["normalizePromptBodyPaths", "src/shared/tooling/exec.ts", "path normalizer applied to an already-rendered prompt body by writeStepContract — states no contract of its own"],
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
    schema: { name: "charterLaneSchema", file: "src/audit/cli/laneValidators.ts", object: charterLaneSchema(new Set()) },
    render: () => renderCharterKindLanePrompt({ kind: "stated", submissionPath: "registry-fixture/submission.json", packetPath: "registry-fixture/packet.json" }),
  },
  {
    builder: "renderCharterComparisonPrompt",
    file: "src/audit/cli/charterComparisonPrompt.ts",
    disposition: "derived",
    schema: { name: "CharterComparisonSubmissionSchema", file: "src/shared/decompose/charterExtraction.ts", object: CharterComparisonSubmissionSchema },
    render: () => renderCharterComparisonPrompt({}, { submissionPath: "registry-fixture/submission.json", laneGraphPaths: { stated: "registry-fixture/stated.json", structural: "registry-fixture/structural.json", revealed: "registry-fixture/revealed.json" } }),
  },
  {
    builder: "renderCharterFidelityPrompt",
    file: "src/audit/cli/charterFidelityPrompt.ts",
    disposition: "derived",
    schema: { name: "CharterFidelitySubmissionSchema", file: "src/shared/decompose/charterExtraction.ts", object: CharterFidelitySubmissionSchema },
    render: () => renderCharterFidelityPrompt({ submissionPath: "registry-fixture/submission.json", packetPath: "registry-fixture/packet.md" }),
  },
  {
    builder: "renderSecondOrderAdversaryPrompt",
    file: "src/audit/systemic/secondOrderAdversaryPrompt.ts",
    disposition: "derived",
    schema: { name: "SystemicChallengeSubmissionSchema", file: "src/shared/decompose/systemicChallenge.ts", object: SystemicChallengeSubmissionSchema },
    render: () => renderSecondOrderAdversaryPrompt({ round: 1, metrics: { rollups: [], max_fan_out: 0, total_edges: 0, metric_covered_nodes: 0 }, submissionPath: "registry-fixture/submission.json", bundle: {}, evidencePaths: [] }),
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
  // The four design-review doors. Each ITEM is parsed with
  // `SubmittedDesignFindingSchema` since 2026-09-17 (owner review, prompt 11),
  // and the prompt-11 pin in `prompt-renders-its-contract.test.ts` parses each
  // rendered example back out against that schema. What these three rows still
  // declare is a gap in the ENVELOPE, not in the item: the submission is a bare
  // JSON array, so there is no top-level object schema for a derived row to name.
  {
    builder: "renderContractReviewPrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "declared-gap",
    schema: { name: "consumeArraySubmission<Finding>", file: "src/audit/cli/nextStepHelpers.ts" },
    gapReason:
      "each finding is parsed with SubmittedDesignFindingSchema at ingestion; the ENVELOPE is a bare array with no zod object schema, so no derived row can name one",
  },
  {
    builder: "renderConceptualReviewPrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "declared-gap",
    schema: { name: "consumeArraySubmission<Finding>", file: "src/audit/cli/nextStepHelpers.ts" },
    gapReason:
      "each finding is parsed with SubmittedDesignFindingSchema at ingestion; the ENVELOPE is a bare array with no zod object schema, so no derived row can name one",
  },
  {
    builder: "renderConceptualPerspectivePrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "declared-gap",
    schema: { name: "submissionFindings", file: "src/audit/types/conceptualAdjudication.ts" },
    gapReason:
      "the perspective LOADER already parses each finding with SubmittedDesignFindingSchema; the lane GATE that admits the file checks array shape only, and that gate is the gap",
  },
  {
    builder: "renderConceptualJudgePrompt",
    file: "src/audit/orchestrator/designReviewPrompt.ts",
    disposition: "derived",
    schema: {
      name: "ConceptualJudgeSubmissionSchema",
      file: "src/audit/types/conceptualAdjudication.ts",
      object: ConceptualJudgeSubmissionSchema,
    },
    render: () =>
      renderConceptualJudgePrompt(
        designReviewBundleFixture,
        [
          {
            name: "The Simplifier",
            path: ".audit-tools/audit/x/p1.json",
            contributor_id: "perspective:the-simplifier",
          },
        ],
        "round-0001",
        { lenses: ["architecture", "security"] },
      ),
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
    // It sat in the DRIVER_GAP list — "driver-facing operator prompt, no worker
    // output contract" — and that was false: this prompt's host writes a
    // `ClarificationAnswersSubmission` and the tool parses it. The false gap is
    // why nothing caught the prompt teaching `"governs": "stated | structural |
    // revealed"`, a value the strict enum refuses (measured 2026-09-17).
    builder: "renderCharterClarificationPrompt",
    file: "src/audit/cli/charterClarificationPrompt.ts",
    disposition: "derived",
    schema: {
      name: "ClarificationAnswersSubmissionSchema",
      file: "src/shared/decompose/charterClarification.ts",
      object: ClarificationAnswersSubmissionSchema,
    },
    render: () => renderCharterClarificationPrompt(clarificationBundleFixture, {
      answersPath: "registry-fixture/answers.json",
      continueCommand: "audit-code next-step",
    }),
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
