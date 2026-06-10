/**
 * Contract-pipeline gate for non-structured free-form remediation starts.
 *
 * When intake is ready for document/conversation/mixed sources, next-step
 * routes through the resumable contract_goal → context → design → critique
 * → obligations → assessment → critic → judge → implementation DAG pipeline
 * before producing an extracted plan that feeds the existing
 * document/implement/close flow.
 *
 * Structured audit-findings.json inputs bypass this pipeline entirely and
 * use the deterministic fast path.
 *
 * Worker outputs are untrusted until validated: each invocation first ingests
 * raw worker-written payloads into validated envelopes (recording dependency
 * content hashes), then archives stale artifacts so the staleness DAG
 * re-derives everything downstream of a repair. The adversarial critic →
 * judge → repair loop lives across next-step invocations with its state in
 * the contract artifacts plus repair-state.json; repairs are capped so a
 * non-converging judge can never oscillate forever.
 */
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  writeJsonFile,
  readOptionalJsonFile,
  formatValidationIssues,
  isRecord,
  withFsRetry,
  type ValidationIssue,
  type JudgeReport,
  type JudgeRepairDirective,
  type ImplementationDAG,
  type ObligationLedger,
} from "@audit-tools/shared";
import {
  CP_ARTIFACT_NAMES,
  contractArtifactExists,
  contractArtifactFilePath,
  contractPipelineDir,
  detectStaleArtifacts,
  readContractArtifact,
  writeContractArtifact,
  type ContractPipelineArtifactEnvelope,
} from "../contractPipeline/artifactStore.js";
import {
  renderContractPipelinePrompt,
  renderContractRepairPrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "./contractPipelinePrompts.js";
import { CONTRACT_PIPELINE_VALIDATORS } from "../validation/contractPipeline.js";
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
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
  critic: "counterexample",
  judge: "judge_report",
  implementation_planning: "implementation_dag",
  closing: "verification_report",
};

// obligation_ledger is produced alongside assessment as a precondition.
const OBLIGATION_LEDGER_ARTIFACT: ContractPipelineArtifactName = "obligation_ledger";
const OBLIGATION_LEDGER_PHASE = "obligation_ledger_phase";

/** Producing phase per artifact, for re-emitting a step after failed validation. */
const ARTIFACT_TO_PHASE: Partial<Record<ContractPipelineArtifactName, string>> = {
  ...Object.fromEntries(
    Object.entries(PHASE_TO_ARTIFACT).map(([phase, artifact]) => [artifact, phase]),
  ),
  [OBLIGATION_LEDGER_ARTIFACT]: OBLIGATION_LEDGER_PHASE,
};

// ── Phase → step kind mapping ──────────────────────────────────────────────────

const CONTRACT_STEP_KIND: RemediationStepKind = "contract_pipeline";
const PRE_IMPLEMENTATION_PHASE_ORDER = CONTRACT_PIPELINE_PHASE_ORDER.filter(
  (phase) => phase !== "closing",
);

// ── Bounded-loop caps ─────────────────────────────────────────────────────────

/**
 * Maximum judge-ordered contract repairs per run. After the cap, the run
 * proceeds to implementation planning with the unrepaired counterexamples
 * carried as residual risks — an unbounded critic↔repair oscillation is the
 * failure mode this exists to prevent.
 */
export const MAX_CONTRACT_REPAIR_ITERATIONS = 2;

/** Maximum implementation_dag regenerations after traceability rejections. */
export const MAX_DAG_REGENERATION_ATTEMPTS = 2;

// ── Repair-state ledger ───────────────────────────────────────────────────────

interface ContractRepairState {
  schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1";
  /** One entry per judge-ordered repair step emission (keyed by judge hash). */
  repairs: { judge_hash: string; target: JudgeRepairDirective["target"]; at: string }[];
  /** One entry per implementation_dag traceability rejection. */
  dag_regenerations: { violations: string[]; at: string }[];
}

function repairStatePath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), "repair-state.json");
}

async function readRepairState(artifactsDir: string): Promise<ContractRepairState> {
  const state = await readOptionalJsonFile<ContractRepairState>(
    repairStatePath(artifactsDir),
  );
  return (
    state ?? {
      schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1",
      repairs: [],
      dag_regenerations: [],
    }
  );
}

async function writeRepairState(
  artifactsDir: string,
  state: ContractRepairState,
): Promise<void> {
  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  await writeJsonFile(repairStatePath(artifactsDir), state);
}

// ── Envelope handling ─────────────────────────────────────────────────────────

function isEnvelope(value: unknown): value is ContractPipelineArtifactEnvelope {
  return (
    isRecord(value) &&
    typeof value.artifact_name === "string" &&
    typeof value.content_hash === "string" &&
    "payload" in value
  );
}

/** Payload of a stored artifact whether or not it has been enveloped yet. */
function envelopePayload(envelope: ContractPipelineArtifactEnvelope | null): unknown {
  if (!envelope) return undefined;
  return isEnvelope(envelope) ? envelope.payload : envelope;
}

/**
 * Archive an artifact file into `<contract>/history/` instead of deleting it,
 * so a repair loop never silently destroys an LLM output.
 */
async function archiveContractArtifact(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  label: "stale" | "invalid",
): Promise<void> {
  const source = contractArtifactFilePath(artifactsDir, name);
  if (!existsSync(source)) return;
  const historyDir = join(contractPipelineDir(artifactsDir), "history");
  await mkdir(historyDir, { recursive: true });
  await withFsRetry(() =>
    rename(source, join(historyDir, `${name}.${label}-${Date.now()}.json`)),
  );
}

export interface ContractIngestionResult {
  /** Raw worker payloads that validated and were wrapped into envelopes. */
  ingested: ContractPipelineArtifactName[];
  /** Raw worker payloads that failed validation (archived; phase re-emitted). */
  invalid: { name: ContractPipelineArtifactName; issues: ValidationIssue[] }[];
}

/**
 * Wrap raw worker-written artifact payloads into validated envelopes. Workers
 * write the bare payload the role schema describes; the envelope (content hash
 * + dependency hashes) is the orchestrator's deterministic bookkeeping, added
 * here. CP_ARTIFACT_NAMES is dependency-ordered, so dependencies are enveloped
 * before their dependents and dependency hashes are always available.
 */
export async function ingestContractArtifacts(
  artifactsDir: string,
): Promise<ContractIngestionResult> {
  const ingested: ContractPipelineArtifactName[] = [];
  const invalid: ContractIngestionResult["invalid"] = [];

  for (const name of CP_ARTIFACT_NAMES) {
    const raw = await readOptionalJsonFile<unknown>(
      contractArtifactFilePath(artifactsDir, name),
    );
    if (raw === undefined || raw === null || isEnvelope(raw)) continue;

    const issues = CONTRACT_PIPELINE_VALIDATORS[name](raw, name).filter(
      (issue) => issue.severity === "error",
    );
    if (issues.length > 0) {
      invalid.push({ name, issues });
      continue;
    }
    await writeContractArtifact(artifactsDir, name, raw);
    ingested.push(name);
  }

  return { ingested, invalid };
}

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
      return OBLIGATION_LEDGER_PHASE;
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

// ── Judge gate ────────────────────────────────────────────────────────────────

type JudgeGate =
  | { kind: "proceed" }
  | { kind: "proceed_residual"; note: string }
  | { kind: "repair"; directive: JudgeRepairDirective; judgeHash: string };

/**
 * Decide whether implementation planning may proceed: an approved judge
 * verdict proceeds; a failing verdict triggers one targeted repair per judge
 * report, capped at MAX_CONTRACT_REPAIR_ITERATIONS — after the cap, the run
 * proceeds with the unrepaired counterexamples recorded as residual risks.
 */
async function evaluateJudgeGate(artifactsDir: string): Promise<JudgeGate> {
  const judgeEnvelope = await readContractArtifact(artifactsDir, "judge_report");
  if (!judgeEnvelope) return { kind: "proceed" };
  const judge = envelopePayload(judgeEnvelope) as JudgeReport | undefined;
  if (!judge || judge.verdict === "approved") return { kind: "proceed" };

  const repairState = await readRepairState(artifactsDir);
  const judgeHash = judgeEnvelope.content_hash;
  const alreadyHandled = repairState.repairs.some(
    (repair) => repair.judge_hash === judgeHash,
  );
  if (!alreadyHandled && repairState.repairs.length >= MAX_CONTRACT_REPAIR_ITERATIONS) {
    return {
      kind: "proceed_residual",
      note: `The judge verdict remains "needs_repair" after ${repairState.repairs.length} repair iteration(s) (the cap). Proceed anyway: treat every judge-accepted counterexample that remains unaddressed as a residual risk, and cover each one with an implementation or verification node.`,
    };
  }

  const directive: JudgeRepairDirective = judge.repair_directive ?? {
    target: "design_spec",
    instruction:
      "Address every judge-accepted counterexample in the judge report's classifications.",
  };
  return { kind: "repair", directive, judgeHash };
}

// ── Traceability gate ─────────────────────────────────────────────────────────

export interface DagTraceabilityResult {
  ok: boolean;
  violations: string[];
}

/**
 * The traceability invariant: no implementation_dag node may exist without
 * tracing to an obligation from the ledger (satisfies_obligations or
 * verification_obligation_ids) or to a judge-accepted counterexample
 * (addresses_counterexamples). Untraceable nodes are unattributable work — the
 * exact thing the contract pipeline exists to prevent.
 */
export async function validateImplementationDagTraceability(
  artifactsDir: string,
): Promise<DagTraceabilityResult> {
  const dag = envelopePayload(
    await readContractArtifact(artifactsDir, "implementation_dag"),
  ) as ImplementationDAG | undefined;
  if (!dag) {
    return { ok: false, violations: ["implementation_dag is missing."] };
  }

  const ledger = envelopePayload(
    await readContractArtifact(artifactsDir, OBLIGATION_LEDGER_ARTIFACT),
  ) as ObligationLedger | undefined;
  const judge = envelopePayload(
    await readContractArtifact(artifactsDir, "judge_report"),
  ) as JudgeReport | undefined;

  const obligationIds = new Set(
    (ledger?.obligations ?? []).map((obligation) => obligation.id),
  );
  const acceptedCounterexampleIds = new Set(
    (judge?.classifications ?? [])
      .filter((entry) => entry.classification === "accepted")
      .map((entry) => entry.counterexample_id),
  );

  const violations: string[] = [];
  const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
  if (nodes.length === 0) {
    violations.push("implementation_dag has no nodes; nothing would be implemented.");
  }
  for (const node of nodes) {
    const tracedObligations = [
      ...(node.satisfies_obligations ?? []),
      ...(node.verification_obligation_ids ?? []),
    ].filter((id) => obligationIds.has(id));
    const tracedCounterexamples = (node.addresses_counterexamples ?? []).filter(
      (id) => acceptedCounterexampleIds.has(id),
    );
    if (tracedObligations.length === 0 && tracedCounterexamples.length === 0) {
      violations.push(
        `Node "${node.id}" traces to no obligation from the obligation ledger and no judge-accepted counterexample.`,
      );
    }
  }

  return { ok: violations.length === 0, violations };
}

// ── Step builder ──────────────────────────────────────────────────────────────

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

  // Resolve artifact paths for the prompt renderers.
  const artifactPaths: Partial<Record<ContractPipelineArtifactName, string>> = {};
  for (const name of CP_ARTIFACT_NAMES) {
    artifactPaths[name] = join(cpDir, `${name}.json`);
  }

  const buildStep = (params: {
    prompt: string;
    outputPath: string;
    stopCondition: string;
  }): Promise<RemediationStep> => {
    const nextCommand = loaderCommand("next-step");
    const prompt = `${params.prompt}

After writing the output file, run:

\`${nextCommand}\`
`;
    const stepArtifactPaths: Record<string, string> = {
      output: params.outputPath,
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
      stopCondition: params.stopCondition,
      artifactPaths: stepArtifactPaths,
    });
  };

  const buildPhaseStep = (
    phase: string,
    extraSection?: string,
  ): Promise<RemediationStep> => {
    const rendered =
      phase === OBLIGATION_LEDGER_PHASE
        ? renderObligationLedgerPrompt({
            goalSpecPath: artifactPaths.goal_spec!,
            designSpecPath: artifactPaths.design_spec!,
            outputPath: artifactPaths.obligation_ledger!,
            repoRoot: root,
          })
        : renderContractPipelinePrompt({
            role: phase,
            artifactPaths,
            sourcePaths,
            repoRoot: root,
          });
    return buildStep({
      prompt: extraSection ? `${rendered.prompt}\n${extraSection}` : rendered.prompt,
      outputPath: rendered.outputPath,
      stopCondition: `Stop after writing the contract-pipeline output for phase "${phase}" and running next-step.`,
    });
  };

  // 1. Ingest raw worker outputs into validated envelopes. An output that
  //    fails validation is archived and its producing phase re-emitted with
  //    the validation errors — LLM output is untrusted until validated.
  const ingestion = await ingestContractArtifacts(artifactsDir);
  if (ingestion.invalid.length > 0) {
    const first = ingestion.invalid[0];
    await archiveContractArtifact(artifactsDir, first.name, "invalid");
    const phase = ARTIFACT_TO_PHASE[first.name] ?? "goal_normalization";
    return buildPhaseStep(
      phase,
      `## Validation Errors From the Previous Attempt

The previous \`${first.name}\` output failed validation and was archived. Fix every issue below in the rewritten output:

${formatValidationIssues(first.issues)}
`,
    );
  }

  // 2. Archive stale artifacts so the staleness DAG re-derives everything
  //    downstream of a repaired (re-ingested) upstream artifact.
  const staleness = await detectStaleArtifacts(artifactsDir);
  for (const name of staleness.stale) {
    await archiveContractArtifact(artifactsDir, name, "stale");
  }

  const nextPhase = nextMissingContractPhase(artifactsDir);

  // 3. Judge gate: implementation planning is reachable only through an
  //    approved verdict, a bounded targeted repair, or the repair cap.
  if (nextPhase === "implementation_planning") {
    const gate = await evaluateJudgeGate(artifactsDir);
    if (gate.kind === "repair") {
      const repairState = await readRepairState(artifactsDir);
      if (!repairState.repairs.some((r) => r.judge_hash === gate.judgeHash)) {
        repairState.repairs.push({
          judge_hash: gate.judgeHash,
          target: gate.directive.target,
          at: new Date().toISOString(),
        });
        await writeRepairState(artifactsDir, repairState);
      }
      const rendered = renderContractRepairPrompt({
        target: gate.directive.target,
        instruction: gate.directive.instruction,
        artifactPaths,
        repoRoot: root,
      });
      return buildStep({
        prompt: rendered.prompt,
        outputPath: rendered.outputPath,
        stopCondition: `Stop after rewriting "${gate.directive.target}" per the judge repair directive and running next-step.`,
      });
    }
    if (gate.kind === "proceed_residual") {
      return buildPhaseStep(
        "implementation_planning",
        `## Repair Cap Reached — Residual Risks

${gate.note}
`,
      );
    }
    // gate.kind === "proceed": fall through to the normal phase step below.
  }

  // 4. All phases exist: enforce traceability, then convert the
  //    implementation_dag to an extracted plan.
  if (!nextPhase) {
    const traceability = await validateImplementationDagTraceability(artifactsDir);
    if (!traceability.ok) {
      const repairState = await readRepairState(artifactsDir);
      if (repairState.dag_regenerations.length >= MAX_DAG_REGENERATION_ATTEMPTS) {
        return writeCurrentStep({
          stepKind: CONTRACT_STEP_KIND,
          status: "blocked",
          runId,
          repoRoot: root,
          artifactsDir,
          prompt: `# Implementation DAG Failed Traceability ${repairState.dag_regenerations.length + 1} Times

The implementation_dag repeatedly contains nodes that trace to no obligation and no judge-accepted counterexample:

${traceability.violations.map((v) => `- ${v}`).join("\n")}

Report this to the user and stop. The contract pipeline cannot promote an untraceable plan; the run needs a corrected goal/design or manual intervention.
`,
          allowedCommands: [],
          stopCondition: "Stop after reporting the traceability failure to the user.",
        });
      }
      repairState.dag_regenerations.push({
        violations: traceability.violations,
        at: new Date().toISOString(),
      });
      await writeRepairState(artifactsDir, repairState);
      await archiveContractArtifact(artifactsDir, "implementation_dag", "invalid");
      return buildPhaseStep(
        "implementation_planning",
        `## Traceability Errors From the Previous Attempt

The previous implementation_dag was rejected and archived. Every node must trace to at least one obligation from the obligation ledger or one judge-accepted counterexample:

${traceability.violations.map((v) => `- ${v}`).join("\n")}
`,
      );
    }
    await promoteImplementationDagToExtractedPlan(artifactsDir);
    return null;
  }

  return buildPhaseStep(nextPhase);
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

  const dag = envelopePayload(dagEnvelope) as {
    goal_id?: string;
    nodes?: Array<{
      id: string;
      title: string;
      description: string;
      satisfies_obligations?: string[];
      addresses_counterexamples?: string[];
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
    const addressedCounterexamples = [
      ...new Set(node.addresses_counterexamples ?? []),
    ];
    const obligationEvidence = [
      ...contractObligations.map((obligationId) => `Satisfies contract obligation: ${obligationId}`),
      ...verificationObligations.map((obligationId) => `Verifies contract obligation: ${obligationId}`),
      ...addressedCounterexamples.map((counterexampleId) => `Addresses accepted counterexample: ${counterexampleId}`),
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
