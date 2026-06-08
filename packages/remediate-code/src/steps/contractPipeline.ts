/**
 * Contract-pipeline gate for non-structured free-form remediation starts.
 *
 * When intake is ready for document/conversation/mixed sources, next-step
 * routes through the resumable contract_goal → context → design → critique
 * → obligations → assessment → implementation DAG pipeline before producing
 * an extracted plan that feeds the existing document/implement/close flow.
 *
 * Structured audit-findings.json inputs bypass this pipeline entirely and
 * use the deterministic fast path.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  writeJsonFile,
  readOptionalJsonFile,
} from "@audit-tools/shared";
import {
  contractArtifactExists,
  readContractArtifact,
} from "../contractPipeline/artifactStore.js";
import {
  renderContractPipelinePrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "./contractPipelinePrompts.js";
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
import { contractPipelineDir } from "../contractPipeline/artifactStore.js";
import { writeCurrentStep } from "./stepWriter.js";
import { loaderCommand } from "./prompts.js";
import type { RemediationStep } from "./types.js";
import type { RemediationStepKind } from "./types.js";
import { intakePaths } from "../intake.js";

// ── Phase → artifact name mapping ─────────────────────────────────────────────

const PHASE_TO_ARTIFACT: Record<string, ContractPipelineArtifactName> = {
  goal_normalization: "goal_spec",
  context_collection: "context_bundle",
  design: "design_spec",
  critique: "conceptual_design_critique",
  assessment: "contract_assessment_report",
  implementation_planning: "implementation_dag",
  closing: "verification_report",
};

// obligation_ledger is produced alongside assessment as a precondition.
const OBLIGATION_LEDGER_ARTIFACT: ContractPipelineArtifactName = "obligation_ledger";

// ── Phase → step kind mapping ──────────────────────────────────────────────────

const CONTRACT_STEP_KIND: RemediationStepKind = "contract_pipeline";
const PRE_IMPLEMENTATION_PHASE_ORDER = CONTRACT_PIPELINE_PHASE_ORDER.filter(
  (phase) => phase !== "closing",
);

// ── Public helpers ────────────────────────────────────────────────────────────

export interface ContractPipelineCheckResult {
  /** True when the contract pipeline should handle the next step. */
  shouldHandleContractPipeline: boolean;
  /** True when all pipeline phases (up to implementation_dag) are complete. */
  pipelineComplete: boolean;
}

/**
 * Determine whether the contract pipeline should be entered for this run.
 * The pipeline is entered when:
 * - The intake source is NOT a structured audit-findings JSON.
 * - We have not yet produced an extracted-plan.json from the pipeline.
 */
export function shouldEnterContractPipeline(
  artifactsDir: string,
  intakeSourceType: string | undefined,
): ContractPipelineCheckResult {
  // Structured audit inputs use the deterministic fast path.
  if (intakeSourceType === "structured_audit") {
    return { shouldHandleContractPipeline: false, pipelineComplete: false };
  }

  const paths = intakePaths(artifactsDir);
  // If an extracted plan already exists, the pipeline has completed.
  if (existsSync(paths.extractedPlan)) {
    return { shouldHandleContractPipeline: false, pipelineComplete: true };
  }

  // Check whether the implementation_dag exists (pipeline complete, awaiting extraction).
  if (contractArtifactExists(artifactsDir, "implementation_dag")) {
    return { shouldHandleContractPipeline: true, pipelineComplete: true };
  }

  return { shouldHandleContractPipeline: true, pipelineComplete: false };
}

/** Return the first pipeline phase whose output artifact does not exist. */
export function nextMissingContractPhase(artifactsDir: string): string | null {
  for (const phase of PRE_IMPLEMENTATION_PHASE_ORDER) {
    const artifactName = PHASE_TO_ARTIFACT[phase];
    if (!artifactName) continue;

    // For assessment we also need obligation_ledger to exist first.
    if (phase === "assessment" && !contractArtifactExists(artifactsDir, OBLIGATION_LEDGER_ARTIFACT)) {
      return "obligation_ledger_phase";
    }

    if (!contractArtifactExists(artifactsDir, artifactName)) {
      return phase;
    }
  }
  return null;
}

export interface ContractPipelineStepOptions {
  root: string;
  artifactsDir: string;
  runId: string;
  sourcePaths?: string[];
}

/**
 * Build and write the next contract-pipeline step.
 * Returns null when the pipeline is complete and the extracted plan is ready.
 */
export async function buildNextContractPipelineStep(
  options: ContractPipelineStepOptions,
): Promise<RemediationStep | null> {
  const { root, artifactsDir, runId, sourcePaths } = options;
  const cpDir = contractPipelineDir(artifactsDir);
  const paths = intakePaths(artifactsDir);

  const nextPhase = nextMissingContractPhase(artifactsDir);

  // If all phases exist, convert the implementation_dag to an extracted plan.
  if (!nextPhase) {
    await promoteImplementationDagToExtractedPlan(artifactsDir);
    return null;
  }

  // Resolve artifact paths for the prompt renderer.
  const artifactPaths: Partial<Record<ContractPipelineArtifactName, string>> = {};
  for (const name of [
    "goal_spec",
    "context_bundle",
    "design_spec",
    "conceptual_design_critique",
    "obligation_ledger",
    "contract_assessment_report",
    "counterexample",
    "judge_report",
    "implementation_dag",
    "verification_report",
  ] as ContractPipelineArtifactName[]) {
    artifactPaths[name] = join(cpDir, `${name}.json`);
  }

  // Handle obligation_ledger_phase as a sub-phase before assessment.
  const renderPhase = nextPhase === "obligation_ledger_phase" ? "assessment" : nextPhase;

  let rendered: { prompt: string; outputPath: string };
  if (nextPhase === "obligation_ledger_phase") {
    // Special case: render the obligation ledger separately.
    rendered = renderObligationLedgerPrompt({
      goalSpecPath: artifactPaths.goal_spec!,
      designSpecPath: artifactPaths.design_spec!,
      outputPath: artifactPaths.obligation_ledger!,
      repoRoot: root,
    });
  } else {
    const result = renderContractPipelinePrompt({
      role: renderPhase,
      artifactPaths,
      sourcePaths,
      repoRoot: root,
    });
    rendered = result;
  }

  const nextCommand = loaderCommand("next-step");
  const prompt = `${rendered.prompt}

After writing the output file, run:

\`${nextCommand}\`
`;

  const stepArtifactPaths: Record<string, string> = {
    output: rendered.outputPath,
  };
  for (const [k, v] of Object.entries(artifactPaths)) {
    if (v && existsSync(v)) {
      stepArtifactPaths[k] = v;
    }
  }
  if (sourcePaths) {
    stepArtifactPaths.source_manifest = paths.sourceManifest;
    stepArtifactPaths.remediation_brief = paths.brief;
  }

  return writeCurrentStep({
    stepKind: CONTRACT_STEP_KIND,
    status: "ready",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt,
    allowedCommands: [nextCommand],
    stopCondition: `Stop after writing the contract-pipeline output for phase "${nextPhase}" and running next-step.`,
    artifactPaths: stepArtifactPaths,
  });
}

// ── Obligation ledger prompt ──────────────────────────────────────────────────

function renderObligationLedgerPrompt(options: {
  goalSpecPath: string;
  designSpecPath: string;
  outputPath: string;
  repoRoot: string;
}): { prompt: string; outputPath: string } {
  const { goalSpecPath, designSpecPath, outputPath, repoRoot } = options;
  const prompt = `# Obligation Ledger

Derive a bounded set of implementation obligations from the goal spec and design spec.

> Set the shell/tool working directory to \`${repoRoot}\` before running any commands.

## Required Inputs

- \`${goalSpecPath}\` (goal_spec)
- \`${designSpecPath}\` (design_spec)

## Your Task

Read only the files listed above. Do not read unrelated source files.

Write your result to exactly:

\`${outputPath}\`

\`\`\`json
{
  "contract_version": "remediate-code-contract-pipeline/obligation-ledger/v1alpha1",
  "goal_id": "<from goal_spec>",
  "obligations": [{
    "id": "<obligation-id>",
    "description": "<concrete obligation>",
    "kind": "invariant|behavioral|structural|test",
    "depends_on": [],
    "status": "pending"
  }],
  "created_at": "<ISO-8601>"
}
\`\`\`

**Stop after writing the output file.** Do not edit source files.
`;
  return { prompt, outputPath };
}

// ── DAG → extracted plan conversion ──────────────────────────────────────────

/**
 * Convert a completed ImplementationDAG into the extracted-plan.json format
 * that the existing handlePendingExtractedPlan/applyPlanPipeline path consumes.
 */
export async function promoteImplementationDagToExtractedPlan(
  artifactsDir: string,
): Promise<void> {
  const paths = intakePaths(artifactsDir);
  const dagEnvelope = await readContractArtifact(artifactsDir, "implementation_dag");
  if (!dagEnvelope) return;

  const dag = dagEnvelope.payload as {
    goal_id?: string;
    nodes?: Array<{
      id: string;
      title: string;
      description: string;
      satisfies_obligations?: string[];
      verification_obligation_ids?: string[];
      targeted_commands?: string[];
      status?: string;
    }>;
  };

  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  const findings = nodes.map((node, index) => {
    const id = node.id ?? `CP-${String(index + 1).padStart(3, "0")}`;
    const contractObligations = [...new Set(node.satisfies_obligations ?? [])];
    const verificationObligations = [
      ...new Set(node.verification_obligation_ids ?? []),
    ];
    const obligationEvidence = [
      ...contractObligations.map((obligationId) => `Satisfies contract obligation: ${obligationId}`),
      ...verificationObligations.map((obligationId) => `Verifies contract obligation: ${obligationId}`),
    ];
    return {
      id,
      title: node.title ?? node.description ?? `Contract-pipeline task ${index + 1}`,
      category: "General",
      severity: "medium",
      confidence: "high",
      lens: "correctness",
      summary: node.description ?? node.title ?? "",
      affected_files: [],
      evidence:
        obligationEvidence.length > 0
          ? obligationEvidence
          : [node.description ?? node.title ?? `Contract-pipeline task ${id}`],
      concrete_change: node.description ?? "",
      contract_goal_id: dag?.goal_id,
      contract_obligation_ids: contractObligations,
      verification_obligation_ids: verificationObligations,
      targeted_commands: node.targeted_commands ?? [],
    };
  });

  const blocks = nodes.map((node) => ({
    block_id: `CP-BLOCK-${node.id}`,
    items: [node.id],
    parallel_safe: true,
    dependencies: ((node as { depends_on?: string[] }).depends_on ?? []).map(
      (depId) => `CP-BLOCK-${depId}`,
    ),
  }));

  const extractedPlan = {
    plan_id: dag?.goal_id ?? `CP-PLAN-${Date.now()}`,
    goal_id: dag?.goal_id,
    findings,
    blocks,
    project_type: "unknown",
    candidate_closing_actions: ["none"],
    source: "contract_pipeline",
  };

  await writeJsonFile(paths.extractedPlan, extractedPlan);
}
