/**
 * Contract-pipeline gate for ALL remediation starts (both paths).
 *
 * When intake is ready, next-step routes through the resumable
 * contract_goal → context → design → critique → obligations → assessment →
 * critic → judge → implementation DAG pipeline before producing an extracted
 * plan that feeds the document/implement/close flow.
 *
 * Path A (structured audit-findings.json): a path_a_seed.json is written to
 * the contract directory before the first phase step, so goal_normalization
 * and context_collection prompts can reference the auditor findings directly.
 * Path B (document/conversation): enters the pipeline directly from intake.
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
  pathASeedFilePath,
  readContractArtifact,
  writeContractArtifact,
  type ContractPipelineArtifactEnvelope,
} from "../contractPipeline/artifactStore.js";
import {
  detectCyclicSeamObligations,
  validateCycleBreak,
  type SeamObligationNode,
} from "../contractPipeline/cyclicSeamResolution.js";
import {
  deriveObligationLedger,
  buildTestValidatorPlanScaffold,
  buildImplementationDagScaffold,
  acceptedCounterexampleIds,
} from "../contractPipeline/derive.js";
import {
  renderContractPipelinePrompt,
  renderContractRepairPrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
} from "./contractPipelinePrompts.js";
import {
  CONTRACT_PIPELINE_VALIDATORS,
  validateDesignSpecGates,
  validateGoalIdConsistency,
  validateImplementationDAGIntegrity,
  validatePairedObligations,
  validateEvidenceThreaded,
  validateDigestCoverage,
  validateReconciliationDerivation,
  deriveNodeModelTierFromNode,
} from "../validation/contractPipeline.js";
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
  decomposition: "module_decomposition",
  module_contract_drafting: "module_contracts",
  seam_reconciliation: "seam_reconciliation_report",
  contract_finalization: "finalized_module_contracts",
  critique: "conceptual_design_critique",
  obligation_ledger: "obligation_ledger",
  cyclic_seam_resolution: "cyclic_seam_resolution",
  test_validator_plan: "test_validator_plan",
  assessment: "contract_assessment_report",
  critic: "counterexample",
  judge: "judge_report",
  implementation_planning: "implementation_dag",
  closing: "verification_report",
};

/** Producing phase per artifact, for re-emitting a step after failed validation. */
const ARTIFACT_TO_PHASE: Partial<Record<ContractPipelineArtifactName, string>> = {
  ...Object.fromEntries(
    Object.entries(PHASE_TO_ARTIFACT).map(([phase, artifact]) => [artifact, phase]),
  ),
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

/**
 * Maximum LLM cycle-break resolution attempts before routing to user-decision
 * (and, if that also fails, to `blocked`).
 */
export const MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS = 2;

// ── Repair-state ledger ───────────────────────────────────────────────────────

interface ContractRepairState {
  schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1";
  /** One entry per judge-ordered repair step emission (keyed by judge hash). */
  repairs: { judge_hash: string; target: string; at: string }[];
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

// ── Cyclic-seam repair-state ledger ──────────────────────────────────────────

export interface CyclicSeamRepairState {
  schema_version: "remediate-code-contract-pipeline/cyclic-seam-repair-state/v1alpha1";
  /** Each attempt to resolve the detected cycles (keyed by obligation_ledger hash). */
  attempts: { ledger_hash: string; at: string; recheck_passed: boolean }[];
  /** Whether a user-decision step has been emitted. */
  user_decision_emitted: boolean;
}

function cyclicSeamRepairStatePath(artifactsDir: string): string {
  return join(contractPipelineDir(artifactsDir), "cyclic-seam-repair-state.json");
}

export async function readCyclicSeamRepairState(
  artifactsDir: string,
): Promise<CyclicSeamRepairState> {
  const state = await readOptionalJsonFile<CyclicSeamRepairState>(
    cyclicSeamRepairStatePath(artifactsDir),
  );
  return (
    state ?? {
      schema_version: "remediate-code-contract-pipeline/cyclic-seam-repair-state/v1alpha1",
      attempts: [],
      user_decision_emitted: false,
    }
  );
}

export async function writeCyclicSeamRepairState(
  artifactsDir: string,
  state: CyclicSeamRepairState,
): Promise<void> {
  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  await writeJsonFile(cyclicSeamRepairStatePath(artifactsDir), state);
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
 * Render a pre-filled skeleton section (S3 scaffold) for the partially-derivable
 * phases. The tool derives the structure/ids/cross-refs from the already-present
 * obligation ledger and leaves only the judgment slots blank, so the worker fills
 * sentences/commands rather than emitting a whole artifact from scratch. Returns
 * undefined when there is nothing to scaffold (no testable obligations / no nodes).
 */
async function buildScaffoldSection(
  phase: string,
  artifactsDir: string,
): Promise<string | undefined> {
  const ledger = envelopePayload(
    await readContractArtifact(artifactsDir, "obligation_ledger"),
  ) as ObligationLedger | undefined;

  if (phase === "test_validator_plan") {
    const scaffold = buildTestValidatorPlanScaffold(ledger);
    if (scaffold.test_specs.length === 0) return undefined;
    const path = contractArtifactFilePath(artifactsDir, "test_validator_plan");
    return `## Pre-filled Skeleton — fill only the blank slots

The obligation ledger was derived deterministically. Below is the test-plan skeleton: one spec per testable obligation, with \`obligation_id\`, \`name\`, and \`kind\` already filled. Fill ONLY each \`assertions\` array — every spec needs at least one positive (satisfied-path) assertion AND one negative (failure-path) assertion. Do not add, remove, or rename specs. If an obligation is genuinely untestable, replace its spec body with an \`inapplicable_claim\` citing its \`obligation_id\` and a falsifiable reason.

\`\`\`json
${JSON.stringify(scaffold, null, 2)}
\`\`\`

Self-check before next-step: \`${loaderCommand(`validate-artifact --name test_validator_plan --file ${path}`)}\``;
  }

  if (phase === "implementation_planning") {
    const judge = envelopePayload(
      await readContractArtifact(artifactsDir, "judge_report"),
    );
    const scaffold = buildImplementationDagScaffold(
      ledger,
      acceptedCounterexampleIds(judge),
    );
    if (scaffold.nodes.length === 0) return undefined;
    const path = contractArtifactFilePath(artifactsDir, "implementation_dag");
    return `## Pre-filled Skeleton — fill only the blank slots

Below is the implementation-DAG skeleton: one node per obligation (covering every obligation and accepted counterexample). Fill ONLY each node's \`title\`, \`description\`, and \`targeted_commands\`. You MAY merge nodes that belong together and add real \`depends_on\`/\`edges\` ordering, as long as every obligation stays covered (in \`satisfies_obligations\` or \`verification_obligation_ids\`) and every accepted counterexample stays in some node's \`addresses_counterexamples\`.

\`\`\`json
${JSON.stringify(scaffold, null, 2)}
\`\`\`

Self-check before next-step: \`${loaderCommand(`validate-artifact --name implementation_dag --file ${path}`)}\``;
  }

  return undefined;
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
 * The pipeline is entered for ALL intake source types (structured_audit,
 * document, conversation) when an extracted-plan.json has not yet been
 * produced. Path A (structured_audit) seeds the pipeline via a path_a_seed.json
 * before the first phase step, so goal_normalization and context_collection
 * prompts can reference the auditor findings.
 */
export function shouldEnterContractPipeline(
  artifactsDir: string,
  _intakeSourceType: string | undefined,
): ContractPipelineCheckResult {
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

// ── Path-A seed ───────────────────────────────────────────────────────────────

export interface PathASeed {
  schema_version: "remediate-code-contract-pipeline/path-a-seed/v1alpha1";
  /** Absolute path to the audit-findings.json source file. */
  audit_findings_path: string;
  /** Number of findings in the report. */
  finding_count: number;
  /** Short per-finding summaries (id + title + lens). */
  findings_summary: Array<{ id: string; title: string; lens: string }>;
  /** Repo-relative paths cited as affected_files across all findings. */
  affected_files: string[];
  created_at: string;
}

/**
 * Write a Path-A seed file from a parsed audit-findings report.
 * The seed is written once (idempotent: skipped when it already exists).
 * goal_normalization and context_collection prompts detect the seed and
 * include its contents so every pipeline node traces to an auditor finding.
 */
export async function writePathASeedFromFindings(
  artifactsDir: string,
  auditFindingsPath: string,
  auditFindings: unknown,
): Promise<void> {
  const seedPath = pathASeedFilePath(artifactsDir);
  if (existsSync(seedPath)) return; // idempotent

  const findings = isRecord(auditFindings) && Array.isArray(auditFindings.findings)
    ? (auditFindings.findings as Array<Record<string, unknown>>)
    : [];

  const affectedFilesSet = new Set<string>();
  const findingsSummary: PathASeed["findings_summary"] = [];
  for (const f of findings) {
    if (typeof f.id === "string" && typeof f.title === "string") {
      findingsSummary.push({
        id: f.id,
        title: f.title,
        lens: typeof f.lens === "string" ? f.lens : "correctness",
      });
    }
    if (Array.isArray(f.affected_files)) {
      for (const af of f.affected_files as Array<Record<string, unknown>>) {
        if (typeof af.path === "string") {
          affectedFilesSet.add(af.path);
        }
      }
    }
  }

  const seed: PathASeed = {
    schema_version: "remediate-code-contract-pipeline/path-a-seed/v1alpha1",
    audit_findings_path: auditFindingsPath,
    finding_count: findings.length,
    findings_summary: findingsSummary,
    affected_files: [...affectedFilesSet],
    created_at: new Date().toISOString(),
  };

  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  await writeJsonFile(seedPath, seed);
}

// ── Repair target inference ───────────────────────────────────────────────────

/**
 * When a judge report omits `repair_directive`, infer the repair target from
 * the failing classifications. Post-redesign the default is
 * `finalized_module_contracts` (not `design_spec`).
 */
// Post-redesign: finalized_module_contracts replaces the deprecated design_spec target.
// ExtendedRepairTarget supersedes the shared JudgeRepairTarget (which still lists design_spec).
type ExtendedRepairTarget = "finalized_module_contracts" | "obligation_ledger" | "contract_assessment_report";

/**
 * Infer the most appropriate repair target from judge classifications when no
 * explicit repair_directive is provided. Examines only accepted classifications
 * and keyword-matches their rationale text.
 *
 * Priority (first match wins):
 *   obligation/ledger/invariant/constraint keywords → obligation_ledger
 *   assessment/finding/gap keywords                 → contract_assessment_report
 *   fallback                                        → finalized_module_contracts
 */
export function inferRepairTarget(
  classifications: JudgeReport["classifications"],
): ExtendedRepairTarget {
  const accepted = (classifications ?? []).filter(
    (c) => c.classification === "accepted",
  );
  const text = accepted.map((c) => c.rationale).join(" ").toLowerCase();
  if (/obligation|ledger|invariant violated|constraint/.test(text)) {
    return "obligation_ledger";
  }
  if (/assessment|contract finding|gap identified/.test(text)) {
    return "contract_assessment_report";
  }
  return "finalized_module_contracts";
}

function inferRepairDirective(judge: JudgeReport): { target: ExtendedRepairTarget; instruction: string } {
  return {
    target: inferRepairTarget(judge.classifications),
    instruction:
      "Address every judge-accepted counterexample in the judge report's classifications.",
  };
}

// ── Judge gate ────────────────────────────────────────────────────────────────

type JudgeGate =
  | { kind: "proceed" }
  | { kind: "proceed_residual"; note: string }
  | { kind: "repair"; directive: { target: ExtendedRepairTarget; instruction: string }; judgeHash: string };

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

  // Map judge.repair_directive.target if present; if absent, infer from classifications.
  const rawDirective = judge.repair_directive;
  const directive: { target: ExtendedRepairTarget; instruction: string } = rawDirective
    ? {
        target: (rawDirective.target === "design_spec"
          ? "finalized_module_contracts"
          : rawDirective.target) as ExtendedRepairTarget,
        instruction: rawDirective.instruction,
      }
    : inferRepairDirective(judge);
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
    await readContractArtifact(artifactsDir, "obligation_ledger"),
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

// ── Contract-obligations promotion gate ───────────────────────────────────────

export interface ContractObligationsGateResult {
  ok: boolean;
  violations: string[];
}

/**
 * Run the fail-closed contract-obligation gates against the persisted contract
 * artifacts. Aggregates:
 *   - validatePairedObligations  (obligation_ledger × test_validator_plan)
 *   - validateEvidenceThreaded   (assessment × judge × implementation_dag)
 *   - validateDigestCoverage     (goal_spec.source_type × finding-enumeration × ledger)
 *   - validateReconciliationDerivation (seam report × finalized contracts)
 *
 * Only error-severity issues fail the gate. Each gate is individually tolerant
 * of an absent input artifact (the upstream phase order guarantees presence by
 * the time this runs, except the source-scoped digest-coverage check which is
 * vacuous for non-enumerable sources).
 */
export async function evaluateContractObligationsPromotionGate(
  artifactsDir: string,
): Promise<ContractObligationsGateResult> {
  const obligationLedger = envelopePayload(
    await readContractArtifact(artifactsDir, "obligation_ledger"),
  );
  const testValidatorPlan = envelopePayload(
    await readContractArtifact(artifactsDir, "test_validator_plan"),
  );
  const assessment = envelopePayload(
    await readContractArtifact(artifactsDir, "contract_assessment_report"),
  );
  const judge = envelopePayload(await readContractArtifact(artifactsDir, "judge_report"));
  const dag = envelopePayload(await readContractArtifact(artifactsDir, "implementation_dag"));
  const seamReport = envelopePayload(
    await readContractArtifact(artifactsDir, "seam_reconciliation_report"),
  );
  const finalizedContracts = envelopePayload(
    await readContractArtifact(artifactsDir, "finalized_module_contracts"),
  );
  const goalSpec = envelopePayload(await readContractArtifact(artifactsDir, "goal_spec"));
  const sourceType =
    isRecord(goalSpec) && typeof goalSpec.source_type === "string"
      ? goalSpec.source_type
      : undefined;
  const findingEnumeration = await readOptionalJsonFile<unknown>(
    intakePaths(artifactsDir).findingEnumeration,
  );

  const issues = [
    ...validatePairedObligations(obligationLedger, testValidatorPlan),
    ...validateEvidenceThreaded(assessment, judge, dag),
    ...validateDigestCoverage(sourceType, findingEnumeration, obligationLedger),
    ...validateReconciliationDerivation(seamReport, finalizedContracts),
  ].filter((issue) => issue.severity === "error");

  return {
    ok: issues.length === 0,
    violations: issues.map((issue) => `[${issue.path}] ${issue.message}`),
  };
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

  // Detect the path-A seed file: present only for structured_audit runs.
  const seedPath = pathASeedFilePath(artifactsDir);
  const pathASeedPath = existsSync(seedPath) ? seedPath : undefined;

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
    const rendered = renderContractPipelinePrompt({
      role: phase,
      artifactPaths,
      sourcePaths,
      repoRoot: root,
      pathASeedPath,
    });
    return buildStep({
      prompt: extraSection ? `${rendered.prompt}\n${extraSection}` : rendered.prompt,
      outputPath: rendered.outputPath,
      stopCondition: `Stop after writing the contract-pipeline output for phase "${phase}" and running next-step.`,
    });
  };

  const buildParallelModuleWaveStep = async (
    phase: "module_contract_drafting" | "contract_finalization",
  ): Promise<RemediationStep> => {
    // For the parallel module phases, build a single step that notes the parallel
    // wave nature. The actual wave dispatch is handled by the host reading the prompt.
    // We emit a single agent step: the worker reads the module list and produces
    // the aggregated artifact for all modules (since true parallel dispatch uses
    // the waveScheduler from implement phase, not the contract pipeline).
    // The prompt instructs the single agent to process all modules in sequence
    // and emit the aggregated output — a pure contract-pipeline workaround for
    // environments that do not support parallel sub-agents.
    return buildPhaseStep(phase);
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

  // 2.5. Goal-ID consistency gate (ARC-86b18f1b): every persisted artifact that
  //      carries a goal_id must agree on the same value. A mismatch means two
  //      runs were interleaved; re-emit the earliest mismatched phase so the
  //      worker can correct it.
  {
    const goalIdArtifacts: Record<string, unknown> = {};
    for (const name of CP_ARTIFACT_NAMES) {
      const env = await readContractArtifact(artifactsDir, name);
      if (env) goalIdArtifacts[name] = envelopePayload(env);
    }
    const goalIdIssues = validateGoalIdConsistency(goalIdArtifacts);
    const goalIdErrors = goalIdIssues.filter((i) => i.severity === "error");
    if (goalIdErrors.length > 0) {
      // Re-emit the producing phase of the first mismatched artifact.
      // issue.path is "<artifact_name>.goal_id"; extract the artifact name.
      const firstPath = goalIdErrors[0]?.path ?? "";
      const mismatchedArtifact = firstPath.replace(/\.goal_id$/, "") as ContractPipelineArtifactName;
      const phase = ARTIFACT_TO_PHASE[mismatchedArtifact] ?? "goal_normalization";
      await archiveContractArtifact(artifactsDir, mismatchedArtifact, "invalid");
      return buildPhaseStep(
        phase,
        `## Goal-ID Consistency Error

Every contract-pipeline artifact must share the same goal_id. The following mismatch was detected:

${goalIdErrors.map((i) => `- [${i.path}] ${i.message}`).join("\n")}

Rewrite the output so its goal_id matches the goal_id established in goal_spec.json.
`,
      );
    }
  }

  // 2.7. Deterministic artifact derivation (S1, contract-authoring determinism).
  //      The obligation ledger is a pure function of the finalized module
  //      contracts (every invariant/failure mode/module → an obligation), so it
  //      is generated by the tool rather than authored by an LLM phase: the
  //      structure can never be malformed, no judgment is spent on a mechanical
  //      restructuring, and a weak model is never asked to emit it from scratch.
  //      Mirrors the cyclic_seam no-cycles fast path — write the artifact, then
  //      re-derive the next phase.
  if (nextPhase === "obligation_ledger") {
    const finalizedPayload = envelopePayload(
      await readContractArtifact(artifactsDir, "finalized_module_contracts"),
    );
    const ledger = deriveObligationLedger(finalizedPayload);
    await writeContractArtifact(artifactsDir, "obligation_ledger", ledger);
    return buildNextContractPipelineStep(options);
  }

  // 3. Judge gate: implementation planning is reachable only through an
  //    approved verdict, a bounded targeted repair, or the repair cap.
  if (nextPhase === "implementation_planning") {
    const gate = await evaluateJudgeGate(artifactsDir);
    if (gate.kind === "repair") {
      const repairTarget = gate.directive.target;
      const repairState = await readRepairState(artifactsDir);
      if (!repairState.repairs.some((r) => r.judge_hash === gate.judgeHash)) {
        repairState.repairs.push({
          judge_hash: gate.judgeHash,
          target: repairTarget,
          at: new Date().toISOString(),
        });
        await writeRepairState(artifactsDir, repairState);
      }
      const rendered = renderContractRepairPrompt({
        target: repairTarget,
        instruction: gate.directive.instruction,
        artifactPaths,
        repoRoot: root,
      });
      return buildStep({
        prompt: rendered.prompt,
        outputPath: rendered.outputPath,
        stopCondition: `Stop after rewriting "${repairTarget}" per the judge repair directive and running next-step.`,
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

  // 4. All phases exist: enforce traceability + referential integrity, then
  //    convert the implementation_dag to an extracted plan.
  if (!nextPhase) {
    // 4a. DAG referential integrity + bidirectional coverage (ARC-86b18f1b-2).
    //     Run before the traceability check so specific referential violations
    //     are reported first (traceability is a superset check).
    const dagPayload = envelopePayload(
      await readContractArtifact(artifactsDir, "implementation_dag"),
    );
    const ledgerPayload = envelopePayload(
      await readContractArtifact(artifactsDir, "obligation_ledger"),
    );
    const cePayload = envelopePayload(
      await readContractArtifact(artifactsDir, "counterexample"),
    );
    const judgePayload = envelopePayload(
      await readContractArtifact(artifactsDir, "judge_report"),
    );
    const integrityIssues = validateImplementationDAGIntegrity(
      dagPayload,
      ledgerPayload,
      cePayload,
      judgePayload,
    );
    const integrityErrors = integrityIssues.filter((i) => i.severity === "error");
    if (integrityErrors.length > 0) {
      const repairState = await readRepairState(artifactsDir);
      if (repairState.dag_regenerations.length >= MAX_DAG_REGENERATION_ATTEMPTS) {
        return writeCurrentStep({
          stepKind: CONTRACT_STEP_KIND,
          status: "blocked",
          runId,
          repoRoot: root,
          artifactsDir,
          prompt: `# Implementation DAG Failed Referential Integrity ${repairState.dag_regenerations.length + 1} Times

The implementation_dag repeatedly contains referential integrity or coverage violations:

${integrityErrors.map((i) => `- [${i.path}] ${i.message}`).join("\n")}

Report this to the user and stop. The contract pipeline cannot promote a plan with integrity violations; the run needs a corrected implementation_dag or obligation_ledger.
`,
          allowedCommands: [],
          stopCondition: "Stop after reporting the integrity failure to the user.",
        });
      }
      repairState.dag_regenerations.push({
        violations: integrityErrors.map((i) => i.message),
        at: new Date().toISOString(),
      });
      await writeRepairState(artifactsDir, repairState);
      await archiveContractArtifact(artifactsDir, "implementation_dag", "invalid");
      return buildPhaseStep(
        "implementation_planning",
        `## Referential Integrity Errors From the Previous Attempt

The previous implementation_dag was rejected and archived due to referential integrity violations. Fix every issue below:

${integrityErrors.map((i) => `- [${i.path}] ${i.message}`).join("\n")}
`,
      );
    }

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

    // 4c. Contract-obligations promotion gates (CP-BLOCK-N-contract-obligations):
    //     fail-closed cross-artifact checks that must pass before a plan is
    //     promoted — paired obligations, evidence threading, source-scoped
    //     digest coverage, and INV-CO-12 reconciliation derivation. Reuses the
    //     dag_regenerations cap: bounded re-emit of implementation_planning, then
    //     blocked. These are the invariants that keep the workflow correct
    //     regardless of host strength, so they are enforced here, never left to
    //     host discretion.
    const obligationGate = await evaluateContractObligationsPromotionGate(artifactsDir);
    if (!obligationGate.ok) {
      const repairState = await readRepairState(artifactsDir);
      if (repairState.dag_regenerations.length >= MAX_DAG_REGENERATION_ATTEMPTS) {
        return writeCurrentStep({
          stepKind: CONTRACT_STEP_KIND,
          status: "blocked",
          runId,
          repoRoot: root,
          artifactsDir,
          prompt: `# Contract-Obligation Gates Failed ${repairState.dag_regenerations.length + 1} Times

The contract-obligation promotion gates repeatedly failed and the plan cannot be promoted:

${obligationGate.violations.map((v) => `- ${v}`).join("\n")}

Report this to the user and stop. The contract pipeline cannot promote a plan that drops obligation coverage, evidence, or a reconciled seam; the run needs a corrected obligation_ledger, test_validator_plan, finalized_module_contracts, or implementation_dag.
`,
          allowedCommands: [],
          stopCondition: "Stop after reporting the contract-obligation gate failure to the user.",
        });
      }
      repairState.dag_regenerations.push({
        violations: obligationGate.violations,
        at: new Date().toISOString(),
      });
      await writeRepairState(artifactsDir, repairState);
      await archiveContractArtifact(artifactsDir, "implementation_dag", "invalid");
      return buildPhaseStep(
        "implementation_planning",
        `## Contract-Obligation Gate Errors From the Previous Attempt

The previous implementation_dag (and/or upstream contract artifacts) failed the fail-closed contract-obligation gates. Fix every issue below before the plan can be promoted:

${obligationGate.violations.map((v) => `- ${v}`).join("\n")}
`,
      );
    }

    await promoteImplementationDagToExtractedPlan(artifactsDir);
    return null;
  }

  // 5a. Cyclic-seam resolution gate: runs after obligation_ledger is present and
  //     before assessment. Detects circular interface-definition obligations in
  //     the DAG of module contracts, then routes to an LLM resolution step when
  //     cycles are found. The resolution is re-checked by the same detector
  //     before being accepted. Cap: MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS; on
  //     exhaustion, route to a user-decision step (then blocked if unresolved).
  if (nextPhase === "cyclic_seam_resolution") {
    const obligationLedgerPayload = envelopePayload(
      await readContractArtifact(artifactsDir, "obligation_ledger"),
    ) as ObligationLedger | undefined;

    // Build seam-obligation graph from obligation ledger: each obligation whose
    // depends_on references other obligation IDs forms a seam-obligation node.
    const obligationIds = new Set(
      (obligationLedgerPayload?.obligations ?? []).map((o) => o.id),
    );
    const seamNodes: SeamObligationNode[] = (
      obligationLedgerPayload?.obligations ?? []
    ).map((obl) => ({
      id: obl.id,
      needs: (obl.depends_on ?? []).filter((dep) => obligationIds.has(dep)),
    }));

    const detectedCycles = detectCyclicSeamObligations(seamNodes);
    const ledgerEnvelope = await readContractArtifact(artifactsDir, "obligation_ledger");
    const ledgerHash = ledgerEnvelope?.content_hash ?? "unknown";

    if (detectedCycles.length === 0) {
      // No cycles — write the no_cycles artifact and let the pipeline proceed.
      await writeContractArtifact(artifactsDir, "cyclic_seam_resolution", {
        contract_version:
          "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
        goal_id: obligationLedgerPayload?.goal_id ?? "",
        cycles: [],
        status: "no_cycles",
        created_at: new Date().toISOString(),
      });
      // Re-derive next phase now that the artifact is written.
      return buildNextContractPipelineStep(options);
    }

    // Cycles detected — check repair state.
    const repairState = await readCyclicSeamRepairState(artifactsDir);
    const attemptsForLedger = repairState.attempts.filter(
      (a) => a.ledger_hash === ledgerHash,
    );

    // Check whether the existing cyclic_seam_resolution artifact (if any) has
    // a re-check that passed — in that case the cycle is resolved; write the
    // resolved artifact and proceed.
    const existingResolution = envelopePayload(
      await readContractArtifact(artifactsDir, "cyclic_seam_resolution"),
    ) as Record<string, unknown> | undefined;
    if (
      existingResolution &&
      (existingResolution.status === "resolved" ||
        existingResolution.status === "no_cycles")
    ) {
      // The cyclic_seam_resolution artifact is already present and marked
      // resolved/no_cycles — this branch should not normally be reached (the
      // artifact exists so nextMissingContractPhase skips it), but guard anyway.
      return buildNextContractPipelineStep(options);
    }

    if (
      attemptsForLedger.length >= MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS &&
      !repairState.user_decision_emitted
    ) {
      // Cap exhausted — emit user-decision step.
      repairState.user_decision_emitted = true;
      await writeCyclicSeamRepairState(artifactsDir, repairState);

      const cycleDescriptions = detectedCycles
        .map((c, i) => `Cycle ${i + 1}: [${c.members.join(", ")}]`)
        .join("\n");

      return writeCurrentStep({
        stepKind: CONTRACT_STEP_KIND,
        status: "blocked",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `# Cyclic Seam Resolution — User Decision Required

The automatic cycle-break resolution reached its cap (${MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS} attempt(s)) without producing a valid cycle-free obligation graph. The following obligation cycles remain unresolved:

${cycleDescriptions}

**Choose one of the two sanctioned break strategies per cycle:**

1. **Mediator module** — Introduce a third obligation/module that both sides depend on. The mediator owns the shared primitive; neither original module defines an interface for the other.
2. **Single authority** — Designate one obligation/module as the definitive owner of the co-defined interface. The other becomes a consumer only. This is recorded as a named, scoped exception.

To proceed, manually rewrite \`${join(cpDir, "obligation_ledger.json")}\` so that no circular \`depends_on\` references exist, then delete \`${join(cpDir, "cyclic_seam_resolution.json")}\` and \`${cyclicSeamRepairStatePath(artifactsDir)}\` and re-run next-step.

If you choose to stop instead, this run will remain blocked.
`,
        allowedCommands: [],
        stopCondition:
          "Stop after presenting the user-decision prompt. Do not attempt further resolution.",
      });
    }

    if (
      attemptsForLedger.length >= MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS &&
      repairState.user_decision_emitted
    ) {
      // User decision was emitted but cycles are still present — blocked.
      const cycleDescriptions = detectedCycles
        .map((c, i) => `Cycle ${i + 1}: [${c.members.join(", ")}]`)
        .join("\n");

      return writeCurrentStep({
        stepKind: CONTRACT_STEP_KIND,
        status: "blocked",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `# Cyclic Seam Resolution — Blocked

Cycles in the obligation graph remain unresolved after the automatic cap and a user-decision step. The run cannot proceed without manual intervention.

${cycleDescriptions}

Manually rewrite the obligation_ledger to remove circular depends_on references, delete the cyclic_seam_resolution artifact and cyclic-seam-repair-state.json, and re-run next-step.
`,
        allowedCommands: [],
        stopCondition: "Stop — the run is blocked on cyclic seam resolution.",
      });
    }

    // Emit the LLM cyclic-seam-resolution step.
    const cycleDescriptions = detectedCycles
      .map((c, i) => `Cycle ${i + 1}: [${c.members.join(", ")}]`)
      .join("\n");

    const outputPath = join(cpDir, "cyclic_seam_resolution.json");
    const nextCommand = loaderCommand("next-step");

    repairState.attempts.push({
      ledger_hash: ledgerHash,
      at: new Date().toISOString(),
      recheck_passed: false,
    });
    await writeCyclicSeamRepairState(artifactsDir, repairState);

    return buildStep({
      prompt: `# Cyclic Seam Resolution

Circular interface-definition obligations were detected in the obligation ledger. You must resolve every cycle using one of the two sanctioned strategies below, then write the resolution record.

## Detected Cycles

${cycleDescriptions}

## Sanctioned Break Strategies

For each cycle, choose one:

1. **Mediator module** — Introduce a third obligation/module that both sides depend on. The mediator owns the shared primitive; neither original module defines an interface for the other.
2. **Single authority** — Designate one side as the definitive owner of the interface. The other becomes a consumer only. Record this as an explicit, scoped exception.

## Required Inputs

- \`${join(cpDir, "obligation_ledger.json")}\` (obligation_ledger)

## Your Task

Read the obligation_ledger. For each detected cycle, decide which break strategy to apply, verify mentally that the break does not re-introduce a cycle, then write the resolution record to exactly:

\`${outputPath}\`

\`\`\`json
{
  "contract_version": "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
  "goal_id": "<from obligation_ledger>",
  "cycles": [
    {
      "members": ["<obligation-id>", "..."],
      "break_strategy": "mediator | single_authority",
      "resolution_description": "<what was changed and why>",
      "exception_registration": "<if single_authority: the named scoped exception; otherwise null>"
    }
  ],
  "status": "resolved",
  "created_at": "<ISO-8601>"
}
\`\`\`

If after analysis you find the cycles are already broken (e.g. upon re-reading the ledger the depends_on edges do not actually form a cycle), set status to "no_cycles" and cycles to [].

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.

After writing the output file, run:

\`${nextCommand}\`
`,
      outputPath,
      stopCondition:
        'Stop after writing the cyclic_seam_resolution output file and running next-step.',
    });
  }

  // 5b. Cyclic-seam re-check: after the LLM writes the cyclic_seam_resolution
  //     artifact (status=resolved or no_cycles), verify the proposed break does
  //     not re-introduce a cycle. If it does, archive and re-emit the resolution
  //     step. This check runs as part of the ingestion/staleness pass — the
  //     artifact is validated structurally by the validator; here we run the
  //     graph re-check on the cycles array to confirm the break is sound.
  //     (Note: this pass runs only when cyclic_seam_resolution already exists
  //     and nextPhase is NOT cyclic_seam_resolution — i.e. the artifact was just
  //     ingested. We do a soft re-check here; if the break re-introduces a cycle,
  //     archive and loop back.)
  {
    const resolutionEnvelope = await readContractArtifact(
      artifactsDir,
      "cyclic_seam_resolution",
    );
    if (resolutionEnvelope) {
      const resolution = envelopePayload(resolutionEnvelope) as
        | Record<string, unknown>
        | undefined;
      if (
        resolution &&
        resolution.status === "resolved" &&
        Array.isArray(resolution.cycles) &&
        resolution.cycles.length > 0
      ) {
        // Re-check: build the patched graph and verify no cycles remain.
        const obligationLedgerPayload = envelopePayload(
          await readContractArtifact(artifactsDir, "obligation_ledger"),
        ) as ObligationLedger | undefined;
        const obligationIds = new Set(
          (obligationLedgerPayload?.obligations ?? []).map((o) => o.id),
        );
        const seamNodes: SeamObligationNode[] = (
          obligationLedgerPayload?.obligations ?? []
        ).map((obl) => ({
          id: obl.id,
          needs: (obl.depends_on ?? []).filter((dep) => obligationIds.has(dep)),
        }));

        // For each cycle in the resolution, apply the stated break and re-check.
        let recheckFailed = false;
        for (const cycleRecord of resolution.cycles as Array<
          Record<string, unknown>
        >) {
          if (!Array.isArray(cycleRecord.members)) continue;
          const members = cycleRecord.members as string[];
          const mediatorId =
            cycleRecord.break_strategy === "mediator"
              ? `_mediator_${members.join("_")}`
              : null;
          const validationResult = validateCycleBreak(
            { members },
            seamNodes,
            mediatorId
              ? { id: mediatorId, needs: [] }
              : // single_authority: the designated owner keeps all edges;
                // non-owner loses edges to cycle members — model as mediator=no-op.
                { id: `_authority_${members.join("_")}`, needs: [] },
          );
          if (!validationResult.accepted) {
            recheckFailed = true;
            break;
          }
        }

        if (recheckFailed) {
          const ledgerEnvelope = await readContractArtifact(
            artifactsDir,
            "obligation_ledger",
          );
          const ledgerHash = ledgerEnvelope?.content_hash ?? "unknown";
          const repairState = await readCyclicSeamRepairState(artifactsDir);
          // Mark the last attempt as recheck_failed.
          const last = repairState.attempts.at(-1);
          if (last && last.ledger_hash === ledgerHash) {
            last.recheck_passed = false;
          }
          await writeCyclicSeamRepairState(artifactsDir, repairState);
          await archiveContractArtifact(
            artifactsDir,
            "cyclic_seam_resolution",
            "invalid",
          );
          // Re-enter to emit the next attempt or cap.
          return buildNextContractPipelineStep(options);
        }
      }
    }
  }

  // 5. Design-spec structural gates: run deterministic checks on the
  //    finalized_module_contracts (the "design" artifact) and obligation_ledger
  //    before emitting the adversarial critic phase. Error-severity gate failures
  //    re-emit the contract_finalization (design) phase so the worker can fix the
  //    structural issues before adversarial review begins. Warning-only results
  //    (e.g. circular obligation dependencies → N-R21) are appended as an
  //    advisory section to the critic prompt so the critic can take them into account.
  if (nextPhase === "critic") {
    const finalizedModuleContractsPayload = envelopePayload(
      await readContractArtifact(artifactsDir, "finalized_module_contracts"),
    );
    const obligationLedgerPayload = envelopePayload(
      await readContractArtifact(artifactsDir, "obligation_ledger"),
    );
    const gateIssues = validateDesignSpecGates(
      finalizedModuleContractsPayload,
      obligationLedgerPayload,
    );
    const gateErrors = gateIssues.filter((issue) => issue.severity === "error");
    const gateWarnings = gateIssues.filter((issue) => issue.severity === "warning");

    if (gateErrors.length > 0) {
      // Re-emit the contract_finalization (design) phase with gate errors appended.
      const errorLines = gateErrors
        .map((issue) => `- [${issue.path}] ${issue.message}`)
        .join("\n");
      return buildPhaseStep(
        "contract_finalization",
        `## Design Structural Gate Errors

The contract_finalization output failed deterministic structural gates. Fix every issue below before adversarial review can begin:

${errorLines}
`,
      );
    }

    if (gateWarnings.length > 0) {
      const warningLines = gateWarnings
        .map((issue) => `- [${issue.path}] ${issue.message}`)
        .join("\n");
      return buildPhaseStep(
        "critic",
        `## Advisory: Design Structural Warnings

The following structural issues were detected and should inform your adversarial review. They do not block the pipeline but may indicate areas of design fragility:

${warningLines}
`,
      );
    }
  }

  // Parallel-capable phases: module_contract_drafting and contract_finalization
  // both benefit from parallel per-module dispatch.
  if (nextPhase === "module_contract_drafting" || nextPhase === "contract_finalization") {
    return buildParallelModuleWaveStep(nextPhase);
  }

  // Skeleton-scaffolded phases (S3): the tool pre-fills structure/ids from the
  // derived obligation ledger so the worker fills only the judgment slots.
  if (nextPhase === "test_validator_plan" || nextPhase === "implementation_planning") {
    const scaffold = await buildScaffoldSection(nextPhase, artifactsDir);
    return buildPhaseStep(nextPhase, scaffold);
  }

  return buildPhaseStep(nextPhase);
}

// ── DAG → extracted plan conversion ──────────────────────────────────────────

// ── Obligation-kind → lens/severity mappings ──────────────────────────────────

type ObligationKind = "invariant" | "behavioral" | "structural" | "test";

/** Priority order: higher index = higher priority (invariant is highest). */
const OBLIGATION_KIND_PRIORITY: ObligationKind[] = [
  "test",
  "structural",
  "behavioral",
  "invariant",
];

function deriveObligationLensAndSeverity(kinds: ObligationKind[]): {
  lens: string;
  severity: string;
} {
  if (kinds.length === 0) {
    return { lens: "correctness", severity: "medium" };
  }
  // Pick the highest-priority kind.
  let topKind: ObligationKind = kinds[0];
  for (const kind of kinds) {
    if (
      OBLIGATION_KIND_PRIORITY.indexOf(kind) >
      OBLIGATION_KIND_PRIORITY.indexOf(topKind)
    ) {
      topKind = kind;
    }
  }
  const lensMap: Record<ObligationKind, string> = {
    invariant: "security",
    behavioral: "correctness",
    structural: "architecture",
    test: "tests",
  };
  const severityMap: Record<ObligationKind, string> = {
    invariant: "high",
    behavioral: "medium",
    structural: "low",
    test: "low",
  };
  return { lens: lensMap[topKind], severity: severityMap[topKind] };
}

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
      /** Declared output paths (write scope); preferred over files_likely_touched for affected_files. */
      output_files?: string[];
      files_likely_touched?: string[];
      preconditions?: string[];
      expected_changes?: string;
      depends_on?: string[];
    }>;
  };

  // Load obligation_ledger for lens/severity derivation (graceful: may be absent).
  const ledgerPayload = envelopePayload(
    await readContractArtifact(artifactsDir, "obligation_ledger"),
  ) as ObligationLedger | undefined;
  const obligationMap = new Map<string, ObligationKind>();
  if (ledgerPayload?.obligations) {
    for (const obl of ledgerPayload.obligations) {
      obligationMap.set(obl.id, obl.kind as ObligationKind);
    }
  }

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

    // Derive lens and severity from obligation kinds; fall back when ledger absent.
    const satisfiedKinds: ObligationKind[] = contractObligations
      .map((id) => obligationMap.get(id))
      .filter((k): k is ObligationKind => k !== undefined);
    const { lens, severity } = deriveObligationLensAndSeverity(satisfiedKinds);

    return {
      id,
      title: node.title ?? node.description ?? `Contract-pipeline task ${index + 1}`,
      category: "General",
      severity,
      confidence: "high",
      lens,
      summary: node.description ?? node.title ?? "",
      // output_files (declared write scope) takes priority over files_likely_touched.
      // Map each path to the { path } shape that Finding.affected_files expects.
      affected_files: (node.output_files ?? node.files_likely_touched ?? []).map(
        (p) => ({ path: p }),
      ),
      evidence:
        obligationEvidence.length > 0
          ? obligationEvidence
          : [node.description ?? node.title ?? `Contract-pipeline task ${id}`],
      concrete_change: node.description ?? "",
      contract_goal_id: dag?.goal_id,
      contract_obligation_ids: contractObligations,
      verification_obligation_ids: verificationObligations,
      addresses_counterexamples: addressedCounterexamples,
      // Relative model rank for this node (small | standard | deep) derived from
      // complexity — never a model name (no-hardcoded-models invariant).
      model_tier: deriveNodeModelTierFromNode(node),
      targeted_commands: node.targeted_commands ?? [],
      preconditions: node.preconditions ?? [],
      expected_changes: node.expected_changes ?? "",
    };
  });

  // finding_id → { obligation_ids, node_ids } trace. Each promoted finding maps
  // 1:1 to a DAG node, so its node_ids are itself plus every node it depends on
  // (the upstream nodes whose output it builds on). obligation_ids unions the
  // satisfied and verification obligations. This is the auditable backward trace
  // from a remediation finding to the contract obligations it discharges.
  const nodeIdSet = new Set(nodes.map((n, i) => n.id ?? `CP-${String(i + 1).padStart(3, "0")}`));
  const traceability: Record<
    string,
    { obligation_ids: string[]; node_ids: string[] }
  > = {};
  for (const [index, node] of nodes.entries()) {
    const id = node.id ?? `CP-${String(index + 1).padStart(3, "0")}`;
    const obligationIds = [
      ...new Set([
        ...(node.satisfies_obligations ?? []),
        ...(node.verification_obligation_ids ?? []),
      ]),
    ];
    const dependsOn = (node.depends_on ?? []).filter((dep) => nodeIdSet.has(dep));
    const nodeIds = [...new Set([id, ...dependsOn])];
    traceability[id] = { obligation_ids: obligationIds, node_ids: nodeIds };
  }

  const blocks = nodes.map((node) => {
    const deps = ((node as { depends_on?: string[] }).depends_on ?? []).map(
      (depId) => `CP-BLOCK-${depId}`,
    );
    return {
      block_id: `CP-BLOCK-${node.id}`,
      items: [node.id],
      // INV-remediate-pipeline-02: a block with prerequisites is never
      // wave-dispatched as independent — parallel_safe derives from depends_on.
      parallel_safe: deps.length === 0,
      dependencies: deps,
    };
  });

  const extractedPlan = {
    plan_id: dag?.goal_id ?? `CP-PLAN-${Date.now()}`,
    goal_id: dag?.goal_id,
    findings,
    blocks,
    // finding_id → { obligation_ids, node_ids } backward trace.
    traceability,
    project_type: "unknown",
    candidate_closing_actions: ["none"],
    source: "contract_pipeline",
  };

  await writeJsonFile(paths.extractedPlan, extractedPlan);
}
