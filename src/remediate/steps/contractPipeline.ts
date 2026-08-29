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
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  writeJsonFile,
  readOptionalJsonFile,
  formatValidationIssues,
  hashContent,
  isRecord,
  withFsRetry,
  type ValidationIssue,
  type JudgeReport,
  type ImplementationDAG,
  type ObligationLedger,
  type WorkBlock,
  type WorkBlockSeam,
  projectApprovedFindings,
  captureStepBoundaryFriction,
  climbOutOfAuditTools,
  partitionCommandsByDeclaredShape,
  normalizeRepoPath,
  repoRelativePath,
  toPosixPath,
} from "audit-tools/shared";
import {
  createStepEmissionScaffold,
  type StepGateHandler,
} from "../../shared/steps/stepEmissionScaffold.js";
import {
  OBLIGATION_KIND_PRIORITY,
  type ObligationKind,
} from "../contractPipeline/obligationKinds.js";
import {
  CP_ARTIFACT_NAMES,
  contractArtifactExists,
  contractArtifactFilePath,
  contractInputFilePath,
  contractPipelineDir,
  detectStaleArtifacts,
  envelopePayload,
  envelopeSemanticHash,
  isEnvelope,
  pathASeedFilePath,
  payloadSemanticHash,
  readContractArtifact,
  stampToolCreatedAt,
  writeContractArtifact,
  writeDerivedContractArtifact,
} from "../contractPipeline/artifactStore.js";
import {
  readIntakeRiskSignal,
  writeIntakeRiskSignal,
  escalateRiskSignal,
  decompositionRiskEvidence,
  adversarialDepthForTier,
  type AdversarialDepth,
  roundTripGranularityForTier,
} from "../riskSignal.js";
import {
  phaseOrdinalForObligations,
  moduleSlug,
  renderPhaseCutSection,
  detectContractTokenCycles,
  type ContractTokenCycle,
} from "../contractPipeline/phaseCut.js";
import { ensurePhaseCutArtifact, readPhaseCutArtifact } from "../contractPipeline/phaseCutArtifact.js";
import {
  detectCyclicSeamObligations,
  validateAuthoredCycleBreak,
  type AuthoredCycleBreak,
  type SeamObligationNode,
} from "../contractPipeline/cyclicSeamResolution.js";
import {
  deriveObligationLedger,
  deriveFinalizedModuleContracts,
  buildTestValidatorPlanScaffold,
  buildImplementationDagScaffold,
  acceptedCounterexampleIds,
  advisoryCritiqueItems,
} from "../contractPipeline/derive.js";
import { ensureNodeId, toBlockId } from "../contractPipeline/idRegistry.js";
import {
  captureReviewSnapshot,
  computeReReviewDelta,
  isReviewArtifact,
  readReviewSnapshot,
  renderReReviewSection,
  reviewSnapshotExists,
} from "../contractPipeline/reviewSnapshot.js";
import {
  captureTestPlanCarry,
  readTestPlanCarry,
} from "../contractPipeline/testPlanCarry.js";
import {
  readRepairState,
  writeRepairState,
  counterexamplesByIdOf,
  counterexampleKeyOf,
  counterexampleWaiversPath,
  foldCounterexampleWaivers,
  waivedAcceptedIds,
  waivedJudgeAcceptedIds,
} from "../contractPipeline/repairState.js";
import {
  renderContractPipelinePrompt,
  renderContractRepairPrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
  PHASE_TO_ARTIFACT,
} from "./contractPipelinePrompts.js";
// The seven cross-artifact validators this module used to call one by one are
// gone from this list on purpose: every one of them is now reached through
// `evaluateContractPipelineCrossGateOutcomes`, so a call site cannot read a
// gate's issue array without also seeing whether the gate RAN
// (the branch-on-evaluated rule). What remains here are the checks that are not
// part of that eight-gate set.
import {
  CONTRACT_PIPELINE_VALIDATORS,
  CP_MODULE_CONTRACTS_VERSION,
  validateGoalIdConsistency,
  validateWorkBlockSeamPreparation,
  validateContractCitationGrounding,
} from "../validation/contractPipeline.js";
// Imported from the owning gate module directly (as derive.ts does): this
// loop-core path consumes the single outcome-based entry point and its
// evaluated/skipped vocabulary together.
import {
  evaluateContractPipelineCrossGateOutcomes,
  enumerateRepoTreePaths,
  isInsideGitWorkTree,
  isTestablePhaseObligation,
  type ContractPipelineCrossGateInputs,
  type GateOutcome,
} from "../validation/contractPipelineGates.js";
import type { Finding } from "audit-tools/shared";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
import { writeCurrentStep } from "./stepWriter.js";
import { loaderCommand } from "./prompts.js";
import type { RemediationStep } from "./types.js";
import type { RemediationStepKind } from "./types.js";
import { intakePaths } from "../intake.js";

// ── Phase → artifact name mapping ─────────────────────────────────────────────
// PHASE_TO_ARTIFACT is single-sourced in contractPipelinePrompts.ts (it also
// derives CONTRACT_PIPELINE_PHASE_ORDER from the same object). Imported here so
// the phase set lives in exactly one place.

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

/**
 * Granularity collapse GROUPS (T1 slice 4b). Each group is a run of CONSECUTIVE
 * phases that folds into ONE round-trip at the `collapsed` granularity — i.e.
 * only at the `low` tier (see `roundTripGranularityForTier`). Collapse is
 * best-effort: any member artifact the worker omits or writes malformed is
 * re-emitted as its own fine-grained step by `nextMissingContractPhase`, so no
 * work is ever lost.
 *
 * These are the ONLY two safe groups, and the gaps between them are not
 * oversights — each is a property worth more than the round-trip it would save.
 * The full per-phase map is `docs/reviews/low-tier-phase-cost-2026-08-25.md`;
 * the boundaries that matter here:
 *
 *   - The framing group STOPS at `decomposition`. Keeping the decomposition→
 *     drafting boundary lets the slice-4a escalate-on-evidence intercept read
 *     the fresh decomposition and raise the tier — un-collapsing everything
 *     after it — before any contract is drafted or the module wave fans out.
 *   - `critique`, `critic` and `judge` are independent-adversary phases and can
 *     never join a group with what they review. Collapsing critic+judge is the
 *     sharpest case: the judge verdict is the SOLE admission to implementation
 *     planning, so one worker emitting both artifacts could write zero
 *     counterexamples plus `approved` and let the loop certify its own exit.
 *   - `implementation_planning` is the phase `judgeRepairGate` protects, and its
 *     scaffold is built from the judge's accepted counterexamples, which do not
 *     exist at judge-render time.
 *
 * A collapsed section carries exactly what its fine-grained step would have
 * carried — see `collapsedSectionExtra`.
 */
const COLLAPSE_GROUPS: readonly (readonly string[])[] = [
  // Framing: scope the change top-down. One coherent authoring act, no
  // adversarial judgment, no deterministic derivation interleaved.
  ["goal_normalization", "context_collection", "decomposition"],
  // Authoring tail: the test/validator plan and the author's OWN coverage
  // self-assessment. `assessment` is deliberately not an independent-critic
  // phase, and `contract_assessment_report` already depends on
  // `test_validator_plan` — the same later-reads-earlier shape the framing
  // group relies on. The critic reviews both afterwards, unchanged.
  ["test_validator_plan", "assessment"],
];

// ── Bounded-loop caps ─────────────────────────────────────────────────────────

/**
 * Runaway backstop for the judge↔repair loop — the LOUD exception path, NOT the
 * normal terminator. The loop normally terminates by *convergence*: it keeps
 * repairing only while each round surfaces a genuinely NEW accepted counterexample
 * (real progress), reaches a fixpoint when the judge approves, and escalates to the
 * user the moment a round re-accepts an already-addressed counterexample without
 * progress (a stall/oscillation). This ceiling exists only so a pathological run
 * that keeps minting brand-new accepted counterexamples forever cannot loop without
 * bound; hitting it is itself an escalation (loud), never a silent proceed. It is
 * deliberately generous — a genuinely deep but converging design (each round a new
 * real defect) must not be cut mid-convergence (the failure mode of the former N=2).
 */
export const MAX_CONTRACT_REPAIR_ITERATIONS = 8;

/** Maximum implementation_dag regenerations after traceability rejections. */
export const MAX_DAG_REGENERATION_ATTEMPTS = 2;

/**
 * Maximum LLM cycle-break resolution attempts before routing to user-decision
 * (and, if that also fails, to `blocked`).
 */
export const MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS = 2;

// ── Repair-state ledger ───────────────────────────────────────────────────────
// Moved to ../contractPipeline/repairState.ts (open-bugs.md:108) so the
// validation sweep and the CLI self-check import the one ledger home the judge
// gate writes; the counterexample-waiver lane lives beside it there.

// ── Cyclic-seam repair-state ledger ──────────────────────────────────────────

export interface CyclicSeamRepairState {
  schema_version: "remediate-code-contract-pipeline/cyclic-seam-repair-state/v1alpha1";
  /**
   * Each attempt to resolve the detected cycles (keyed by obligation_ledger
   * hash). `recheck_reason` records WHY the re-check rejected an attempt, so the
   * next resolution prompt can state it instead of re-asking for the same claim
   * and burning the attempt cap on an unexplained retry.
   */
  attempts: {
    ledger_hash: string;
    at: string;
    recheck_passed: boolean;
    recheck_reason?: string;
  }[];
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
    const prior = await readTestPlanCarry(artifactsDir);
    const scaffold = buildTestValidatorPlanScaffold(ledger, prior);
    if (scaffold.test_specs.length === 0) return undefined;
    const carriedCount = scaffold.test_specs.filter(
      (s) => s.assertions.length > 0,
    ).length;
    const path = contractInputFilePath(artifactsDir, "test_validator_plan");
    const carryNote =
      carriedCount > 0
        ? `\n\n**Carried from the prior round (C3):** ${carriedCount} spec(s) already have assertions — their obligation premise is unchanged, so keep them as-is unless you intend to revise. Only the specs with an EMPTY \`assertions\` array need authoring.`
        : "";
    return `## Pre-filled Skeleton — fill only the blank slots

The obligation ledger was derived deterministically. Below is the test-plan skeleton: one spec per testable obligation, with \`obligation_id\`, \`name\`, \`kind\`, and \`scope_anchors\` already filled. Fill ONLY each \`assertions\` array — every spec needs at least one positive (satisfied-path) assertion AND one negative (failure-path) assertion. The negative assertion MUST name one of the spec's \`scope_anchors\` (the touched symbol/file) and must not be an unscoped repo-wide scan, or it fails the negative-scoping gate. Do not add, remove, or rename specs. If an obligation is genuinely untestable, replace its spec body with an \`inapplicable_claim\` citing its \`obligation_id\` and a falsifiable reason.${carryNote}

\`\`\`json
${JSON.stringify(scaffold, null, 2)}
\`\`\`

Self-check before next-step: \`${loaderCommand(`validate-artifact --name test_validator_plan --file ${path}`)}\``;
  }

  if (phase === "implementation_planning") {
    const judge = envelopePayload(
      await readContractArtifact(artifactsDir, "judge_report"),
    );
    const finalized = envelopePayload(
      await readContractArtifact(artifactsDir, "finalized_module_contracts"),
    );
    const scaffold = buildImplementationDagScaffold(
      ledger,
      acceptedCounterexampleIds(judge),
      finalized,
    );
    if (scaffold.nodes.length === 0) return undefined;
    const advisory = advisoryCritiqueItems(
      envelopePayload(
        await readContractArtifact(artifactsDir, "conceptual_design_critique"),
      ),
    );
    const advisoryBlock =
      advisory.length > 0
        ? `\n\nAdvisory conceptual-critique items (no obligation/counterexample of their own — give each a home in some node's \`addressed_critique_items\` and let it shape that node's implementation; do NOT smuggle them into test assertions):\n${advisory
            .map((a) => `- \`${a.id}\`: ${a.description}`)
            .join("\n")}`
        : "";
    const path = contractInputFilePath(artifactsDir, "implementation_dag");
    return `## Pre-filled Skeleton — fill only the blank slots

Below is the implementation-DAG skeleton: ONE node per module (its obligations already grouped), covering every obligation and accepted counterexample. Each node's \`depends_on\` is already DERIVED from the finalized contracts' data-flow (a node depends on the modules whose \`artifact:<name>\` outputs it consumes) — keep it unless you know an ordering is wrong. Fill ONLY each node's \`title\`, \`description\`, and \`targeted_commands\`. You MAY further merge or split nodes and refine \`depends_on\`/\`edges\` ordering, as long as every obligation stays covered (in \`satisfies_obligations\` or \`verification_obligation_ids\`) and every accepted counterexample stays in some node's \`addresses_counterexamples\`.${advisoryBlock}

\`\`\`json
${JSON.stringify(scaffold, null, 2)}
\`\`\`

Self-check before next-step: \`${loaderCommand(`validate-artifact --name implementation_dag --file ${path}`)}\``;
  }

  return undefined;
}

/** Outcome of an archive attempt. */
export interface ArchiveOutcome {
  /**
   * Timestamped history path the original was moved to, or undefined when the
   * source did not exist (nothing to archive).
   */
  archivedPath?: string;
  /**
   * True when the original path is now free for a fresh Write (the move
   * succeeded, or there was nothing to archive). False when the move failed and
   * the original was preserved in place — the caller must NOT assume the path is
   * re-authorable.
   */
  originalFree: boolean;
}

/**
 * Archive an artifact into `<contract>/history/` instead of deleting it, so a
 * repair loop never silently destroys an LLM output. Two disjoint files exist
 * per artifact (D3): the host's plain INPUT (`<name>.input.json` — the LLM
 * emission) and the tool's canonical envelope (`<name>.json` — regenerable
 * bookkeeping). On a stale/invalid re-emit BOTH are moved to history: the input
 * to preserve the LLM output AND free its path for a fresh host Write, the
 * canonical so the completion gate (`contractArtifactExists`) re-fires and the
 * producing phase re-emits. The returned `archivedPath` references the input
 * archive when present (what the host re-authors), else the canonical archive.
 * A tool-derived artifact with no input file (e.g. a merged-shard artifact)
 * archives only its canonical envelope. If any move throws, the rest are left
 * in place (`originalFree: false`) rather than silently dropped. `renameFn` is a
 * DI seam so a failed history move is testable.
 */
export async function archiveContractArtifact(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  label: "stale" | "invalid",
  renameFn: (from: string, to: string) => Promise<void> = rename,
): Promise<ArchiveOutcome> {
  const inputSource = contractInputFilePath(artifactsDir, name);
  const canonicalSource = contractArtifactFilePath(artifactsDir, name);
  const hasInput = existsSync(inputSource);
  const hasCanonical = existsSync(canonicalSource);
  if (!hasInput && !hasCanonical) return { originalFree: true };

  const historyDir = join(contractPipelineDir(artifactsDir), "history");
  await mkdir(historyDir, { recursive: true });
  const stamp = Date.now();
  let archivedPath: string | undefined;

  // Preserve the host's plain output (the LLM emission) first, freeing the input
  // path so the rewrite signpost's fresh Write lands cleanly.
  if (hasInput) {
    const dest = join(historyDir, `${name}.${label}-${stamp}.input.json`);
    archivedPath = dest;
    try {
      await withFsRetry(() => renameFn(inputSource, dest));
    } catch {
      return { archivedPath, originalFree: false };
    }
  }

  // Clear the tool-derived canonical envelope so the completion gate re-fires.
  if (hasCanonical) {
    const dest = join(historyDir, `${name}.${label}-${stamp}.json`);
    try {
      await withFsRetry(() => renameFn(canonicalSource, dest));
    } catch {
      return { archivedPath: archivedPath ?? dest, originalFree: false };
    }
    archivedPath = archivedPath ?? dest;
  }

  return { archivedPath, originalFree: true };
}

/**
 * The explicit re-author signpost appended to every inline rejection re-emit:
 * the prior output was archived, so the worker must Write a fresh complete
 * artifact at the ORIGINAL path — never Edit the previous (now-archived) file.
 */
export function rejectionRewriteInstruction(
  archived: { archivedPath?: string; originalFree?: boolean } | string | undefined,
): string {
  // Back-compat: a bare path argument behaves as a successful (originalFree) archive.
  const outcome =
    typeof archived === "string" || archived === undefined
      ? { archivedPath: archived, originalFree: true }
      : archived;
  const where = outcome.archivedPath
    ? `\`${outcome.archivedPath}\``
    : "the contract history directory";
  if (outcome.originalFree === false) {
    // Honor archiveContractArtifact's originalFree signal: the history move failed,
    // so the rejected file is STILL at its original path. Tell the host to
    // overwrite it in place — a fresh Write that replaces the stale content is the
    // only way the re-emit lands (the path is not free).
    return `\n\n> The previous output could not be archived and REMAINS at its original path; overwrite it with a fresh complete artifact (a full Write that replaces the file) — do NOT Edit incrementally.`;
  }
  return `\n\n> Prior output archived to ${where}; Write a fresh complete artifact at its original path — do NOT Edit the previous file.`;
}

export interface ContractIngestionResult {
  /** Raw worker payloads that validated and were wrapped into envelopes. */
  ingested: ContractPipelineArtifactName[];
  /** Raw worker payloads that failed validation (archived; phase re-emitted). */
  invalid: { name: ContractPipelineArtifactName; issues: ValidationIssue[] }[];
}

/**
 * Derive validated canonical envelopes from the host's plain INPUT files (D3).
 * The host writes the bare payload the role schema describes to
 * `<name>.input.json`; the tool reads it here, validates it, and writes the
 * content-hash envelope to the canonical `<name>.json` — the host's input file
 * is never mutated in place. CP_ARTIFACT_NAMES is dependency-ordered, so
 * dependencies are enveloped before their dependents and dependency hashes are
 * always available.
 */
export async function ingestContractArtifacts(
  artifactsDir: string,
): Promise<ContractIngestionResult> {
  const ingested: ContractPipelineArtifactName[] = [];
  const invalid: ContractIngestionResult["invalid"] = [];

  for (const name of CP_ARTIFACT_NAMES) {
    const raw = await readOptionalJsonFile<unknown>(
      contractInputFilePath(artifactsDir, name),
    );
    if (raw === undefined || raw === null) continue;
    // The host writes a plain payload; defensively unwrap if an envelope slipped
    // into the input path so ingest and the validate-artifact self-check agree.
    const bare = isEnvelope(raw) ? raw.payload : raw;

    // The host has no clock: stamp the tool-owned `created_at` before validation
    // so the host never has to invent a timestamp (B4). No-op when already present.
    const payload = stampToolCreatedAt(bare, new Date().toISOString());

    // Idempotency: the input file persists across next-step calls, so skip
    // re-ingesting an input whose canonical envelope already reflects it. The
    // semantic projection strips the tool-stamped `created_at`, so a no-op
    // re-ingest is stable (it does NOT re-fire snapshots or rewrite the
    // envelope); only a genuine host edit re-derives.
    const existing = await readContractArtifact(artifactsDir, name);
    if (existing && envelopeSemanticHash(existing) === payloadSemanticHash(name, payload)) {
      continue;
    }

    const issues = CONTRACT_PIPELINE_VALIDATORS[name](payload, name).filter(
      (issue) => issue.severity === "error",
    );
    if (issues.length > 0) {
      invalid.push({ name, issues });
      continue;
    }
    await writeContractArtifact(artifactsDir, name, payload);
    ingested.push(name);
    // Repair-revert fix: an ingested aggregated `module_contracts` payload (a
    // degenerate single-agent draft, or a direct edit) is written back through to
    // the per-module shards so shards ≡ aggregate stays an invariant — otherwise a
    // later upstream cascade (e.g. a module_decomposition edit) re-merges the STALE
    // shards and silently reverts the change. No-op for every non-sharded artifact
    // (`finalized_module_contracts` is deterministically derived, never sharded).
    await propagateAggregateToShards(artifactsDir, name, payload);
    // Snapshot a freshly-produced review verdict + the upstreams it reviewed, so
    // a later staleness re-emit can be diff-based (B2). No-op for non-review
    // artifacts. Captured at ingest, when the upstreams are in the exact state
    // the worker reviewed.
    if (isReviewArtifact(name)) {
      await captureReviewSnapshot(artifactsDir, name, payload, new Date().toISOString());
    }
    // C3: snapshot the authored test-plan so a later re-emit can diff-carry the
    // assertions of unchanged obligations instead of forcing a full re-author.
    if (name === "test_validator_plan") {
      await captureTestPlanCarry(artifactsDir, payload, new Date().toISOString());
    }
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
  /**
   * The same DI seam {@link archiveContractArtifact} already exposes, lifted to
   * the entry point so a FAILED history move is reachable from an end-to-end
   * test. Undefined uses `node:fs/promises` rename, so production behavior is
   * unchanged. It exists because the archive-failure branch (COR-114e4941) is a
   * correctness gate whose whole point is what the pipeline does when the move
   * does not succeed — a branch no fixture can reach by arranging files.
   */
  renameFn?: (from: string, to: string) => Promise<void>;
}

// ── Path-A seed ───────────────────────────────────────────────────────────────

export interface PathASeed {
  schema_version: "remediate-code-contract-pipeline/path-a-seed/v1alpha2";
  /** Absolute path to the audit-findings.json source file. */
  audit_findings_path: string;
  /** Number of findings in the report. */
  finding_count: number;
  /** Short per-finding summaries (id + title + lens). */
  findings_summary: Array<{ id: string; title: string; lens: string }>;
  /** Repo-relative paths cited as affected_files across all findings. */
  affected_files: string[];
  /** Auditor-produced bounded work topology. */
  work_blocks: WorkBlock[];
  /** Explicit cross-block overlaps; required seams must be prepared before refactors. */
  work_block_seams: WorkBlockSeam[];
  /**
   * Seed source-digest binding. One sha256 per source path the seed was built
   * FROM, recorded at seed-build time: the audit-findings file itself plus every
   * `affected_files` path that existed on disk. `buildNextContractPipelineStep`
   * re-hashes each on entry and refuses when one no longer matches, instead of
   * spending a whole design pipeline on content that no longer holds the
   * findings the seed enumerates.
   *
   * OPTIONAL for READING, always written for WRITING: a seed persisted before
   * this field existed carries none, and an absent list binds nothing rather
   * than blocking a run mid-flight. Paths are stored exactly as the seed knows
   * them — the findings path absolute, `affected_files` repo-relative — and the
   * verifier resolves a relative entry against the repo root it is handed.
   */
  source_digests?: Array<{ path: string; sha256: string }>;
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
  // Contract-claiming input must pass the strict shared validator before even
  // the idempotence shortcut. No seed/state/plan artifact may be derived from a
  // partially parsed or permissively defaulted report.
  const approved = projectApprovedFindings(auditFindings);
  const seedPath = pathASeedFilePath(artifactsDir);
  if (existsSync(seedPath)) return; // idempotent

  const findings = [...approved.findings].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );

  const affectedFilesSet = new Set<string>();
  const findingsSummary: PathASeed["findings_summary"] = findings.map((finding) => ({
    id: finding.id,
    title: finding.title,
    lens: finding.lens,
  }));
  for (const finding of findings) {
    for (const affectedFile of finding.affected_files) {
      affectedFilesSet.add(affectedFile.path);
    }
  }

  const workBlocks: WorkBlock[] = approved.workBlocks
    .map((block): WorkBlock => ({
      ...block,
      finding_ids: [...block.finding_ids].sort(),
      unit_ids: [...block.unit_ids].sort(),
      owned_files: [...block.owned_files].sort(),
      depends_on: [...block.depends_on].sort(),
    }))
    .sort((a, b) => compareCodeUnits(a.id, b.id));
  // Code-unit order, not ICU collation, on EVERY persisted seed array: the
  // seed order must not depend on the host's ICU collation, and seam ids are
  // hex now — a locale that orders digits against letters differently would
  // reshuffle the file.
  const workBlockSeams: WorkBlockSeam[] = approved.workBlockSeams
    .map((seam): WorkBlockSeam => ({
      ...seam,
      block_ids: [...seam.block_ids].sort(compareCodeUnits),
    }))
    .sort((a, b) => compareCodeUnits(a.id, b.id));

  const affectedFiles = [...affectedFilesSet].sort();

  const seed: PathASeed = {
    schema_version: "remediate-code-contract-pipeline/path-a-seed/v1alpha2",
    audit_findings_path: auditFindingsPath,
    finding_count: findings.length,
    findings_summary: findingsSummary,
    affected_files: affectedFiles,
    work_blocks: workBlocks,
    work_block_seams: workBlockSeams,
    source_digests: await hashSeedSourcePaths(
      seedRepoRoot(artifactsDir),
      auditFindingsPath,
      affectedFiles,
    ),
    created_at: new Date().toISOString(),
  };

  await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
  await writeJsonFile(seedPath, seed);
}

/**
 * The repository root that owns `artifactsDir`, for resolving the seed's
 * repo-relative `affected_files`. Derived through the shared
 * `climbOutOfAuditTools` rather than a hand-rolled `../..`, so the one
 * `.audit-tools` layout rule stays single-sourced (and a caller that hands us a
 * dir outside the tree simply gets that dir back, which resolves relative paths
 * against it — the same thing every other artifact path in this module does).
 */
function seedRepoRoot(artifactsDir: string): string {
  return climbOutOfAuditTools(artifactsDir);
}

/** Absolute form of a seed-recorded path (absolute entries pass through). */
function resolveSeedSourcePath(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}

/**
 * sha256 every seed source path that EXISTS at seed-build time. A path that is
 * absent is not recorded at all — the seed binds what it actually read, and a
 * finding citing a file that does not exist yet (a new-file remediation) must
 * not mint a digest that can never match.
 */
async function hashSeedSourcePaths(
  root: string,
  auditFindingsPath: string,
  affectedFiles: readonly string[],
): Promise<Array<{ path: string; sha256: string }>> {
  const digests: Array<{ path: string; sha256: string }> = [];
  // Content-derived order (path-sorted, deduped): an incidentally-ordered array
  // would churn the seed's content hash on every re-derivation.
  const candidates = [...new Set([auditFindingsPath, ...affectedFiles])].sort(
    (left, right) => compareCodeUnits(left, right),
  );
  for (const path of candidates) {
    const absolute = resolveSeedSourcePath(root, path);
    let content: Buffer;
    try {
      content = await readFile(absolute);
    } catch {
      continue; // Not readable at seed time — nothing to bind.
    }
    digests.push({ path, sha256: hashContent(content) });
  }
  return digests;
}

/** One seed-recorded source path whose content no longer matches its digest. */
export interface SeedSourceDigestMismatch {
  path: string;
  expected: string;
  /** The path's current sha256, or `null` when it is no longer readable. */
  actual: string | null;
}

/**
 * Seed source-digest binding — re-hash every path the path_a seed recorded and
 * report the ones that moved. Pure over (root, seed): the caller decides what a
 * mismatch means, so this is directly red-green testable without a pipeline.
 *
 * A seed with no `source_digests` (written before the field existed) binds
 * nothing and yields no mismatches.
 */
export async function detectSeedSourceDigestMismatches(
  root: string,
  seed: PathASeed | undefined,
): Promise<SeedSourceDigestMismatch[]> {
  const mismatches: SeedSourceDigestMismatch[] = [];
  for (const entry of seed?.source_digests ?? []) {
    if (typeof entry?.path !== "string" || typeof entry?.sha256 !== "string") continue;
    const absolute = resolveSeedSourcePath(root, entry.path);
    let actual: string | null = null;
    try {
      actual = hashContent(await readFile(absolute));
    } catch {
      actual = null;
    }
    if (actual !== entry.sha256) {
      mismatches.push({ path: entry.path, expected: entry.sha256, actual });
    }
  }
  return mismatches;
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
  // Widened to match the guard below rather than the other way round: judge
  // reports are read back from artifact JSON, so `classifications` genuinely
  // arrives absent on a malformed/partial report. The declared-required type
  // said that could not happen while the body defended against it — and a
  // signature that disagrees with its own null-guard makes one of them dead.
  classifications: JudgeReport["classifications"] | undefined,
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
  | {
      kind: "escalate";
      reason: "stall" | "runaway" | "invalid_waivers";
      /** Accepted counterexample ids still standing — waived ones excluded. */
      outstanding: string[];
      note: string;
      /** Present only for reason "invalid_waivers": why the file was refused. */
      waiverIssues?: string[];
    }
  | {
      kind: "repair";
      directive: { target: ExtendedRepairTarget; instruction: string };
      judgeHash: string;
      acceptedCeIds: string[];
      addressedCeFingerprints: string[];
    };

/** Judge-accepted counterexample ids from a judge report's classifications. */
function acceptedCeIdsOf(judge: JudgeReport | undefined): string[] {
  return (judge?.classifications ?? [])
    .filter((c) => c.classification === "accepted")
    .map((c) => c.counterexample_id);
}

/**
 * Decide whether implementation planning may proceed. Convergence-terminated,
 * NOT capped at an arbitrary count:
 *   - approved verdict ⇒ proceed (the fixpoint);
 *   - a needs_repair verdict that surfaces a NEW accepted counterexample (one not
 *     already addressed by a prior repair) ⇒ repair (genuine progress);
 *   - a needs_repair verdict whose accepted counterexamples were ALL already
 *     addressed ⇒ escalate (stall/oscillation — the repair loop is not converging,
 *     surface the outstanding counterexamples to the user instead of silently
 *     shipping residual risk or looping);
 *   - the runaway backstop (MAX_CONTRACT_REPAIR_ITERATIONS) ⇒ escalate (loud).
 * The former fixed N=2 cap that proceeded-with-residual-risk at an arbitrary count
 * is gone: a deep-but-converging run is no longer cut mid-convergence, and a
 * genuinely non-converging run is surfaced rather than buried.
 */
async function evaluateJudgeGate(artifactsDir: string): Promise<JudgeGate> {
  const judgeEnvelope = await readContractArtifact(artifactsDir, "judge_report");
  if (!judgeEnvelope) return { kind: "proceed" };
  const judge = envelopePayload(judgeEnvelope) as JudgeReport | undefined;
  if (!judge || judge.verdict === "approved") return { kind: "proceed" };

  // Content-fingerprint keying (not raw id): two independent adversarial
  // rounds may each label their genuinely-distinct top counterexample with
  // the SAME reviewer id string (e.g. "CE-001", the prompt schema's own
  // example value). Keying convergence on the raw id would then read "same CE
  // re-accepted after a repair" and falsely escalate while a real new defect
  // is being correctly repaired. Resolve each accepted id against the live
  // counterexample artifact and key on content instead; an id with no
  // matching counterexample falls back to raw-id keying — today's behavior —
  // so nothing regresses when content can't be resolved. The keying is
  // single-sourced with the waiver ledger (counterexampleKeyOf).
  const cePayload = envelopePayload(
    await readContractArtifact(artifactsDir, "counterexample"),
  );
  const ceById = counterexamplesByIdOf(cePayload);
  const keyOf = (rawId: string): string => counterexampleKeyOf(ceById, rawId);

  const acceptedIds = acceptedCeIdsOf(judge);

  // Owner waivers (open-bugs.md:108, the recorded resolution verb): fold the
  // host-written waiver file BEFORE any convergence math, so a waiver recorded
  // against a blocked escalation unblocks this same invocation — including one
  // recorded after a repair for this judge hash was already dispatched. An
  // invalid file escalates loudly and applies NOTHING (never half-applied).
  const fold = await foldCounterexampleWaivers(artifactsDir, {
    counterexamplesById: ceById,
    judgeAcceptedIds: new Set(acceptedIds),
  });
  if (fold.issues.length > 0) {
    return {
      kind: "escalate",
      reason: "invalid_waivers",
      outstanding: acceptedIds,
      waiverIssues: fold.issues,
      note:
        "The counterexample waiver file was refused and nothing was applied. " +
        "Fix or delete it, then re-run next-step.",
    };
  }

  const repairState = await readRepairState(artifactsDir);
  const waived = waivedAcceptedIds(repairState, ceById, acceptedIds);
  const unwaivedAccepted = acceptedIds.filter((id) => !waived.has(id));
  // Every accepted counterexample carries a recorded owner waiver → the
  // needs_repair verdict is resolved by decision: proceed.
  if (acceptedIds.length > 0 && unwaivedAccepted.length === 0) {
    return { kind: "proceed" };
  }

  const judgeHash = judgeEnvelope.content_hash;
  const alreadyHandled = repairState.repairs.some(
    (repair) => repair.judge_hash === judgeHash,
  );

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

  const addressed = new Set(
    repairState.repairs.flatMap(
      (r) =>
        r.addressed_ce_fingerprints ??
        (r.accepted_ce_ids ?? []).map((id) => `id:${id}`),
    ),
  );
  const newAccepted = unwaivedAccepted.filter((id) => !addressed.has(keyOf(id)));
  const newAcceptedFingerprints = newAccepted.map(keyOf);

  // Idempotent re-entry: this exact judge report already drove a repair (its hash
  // is recorded). Re-emit the same repair directive; do not re-evaluate convergence
  // (the repair has not yet produced a fresh judge report).
  if (alreadyHandled) {
    return {
      kind: "repair",
      directive,
      judgeHash,
      acceptedCeIds: newAccepted,
      addressedCeFingerprints: newAcceptedFingerprints,
    };
  }

  // Runaway backstop (loud) — the exception path, not the normal terminator.
  if (repairState.repairs.length >= MAX_CONTRACT_REPAIR_ITERATIONS) {
    return {
      kind: "escalate",
      reason: "runaway",
      outstanding: unwaivedAccepted,
      note: `The judge↔repair loop reached its runaway backstop (${repairState.repairs.length} repair rounds) without converging. Each round was still surfacing accepted counterexamples. This is pathological non-convergence — review the outstanding counterexamples and the contract design with the user before proceeding.`,
    };
  }

  // Progress: a new accepted counterexample (or the first round) ⇒ repair.
  if (repairState.repairs.length === 0 || newAccepted.length > 0) {
    return {
      kind: "repair",
      directive,
      judgeHash,
      acceptedCeIds: newAccepted,
      addressedCeFingerprints: newAcceptedFingerprints,
    };
  }

  // Stall: a needs_repair verdict whose every accepted counterexample was already
  // addressed by a prior repair ⇒ the loop is not converging ⇒ escalate.
  return {
    kind: "escalate",
    reason: "stall",
    outstanding: unwaivedAccepted,
    note: `The judge re-accepted counterexample(s) that a prior repair already addressed (${unwaivedAccepted.join(", ") || "none newly accepted"}), with no new accepted counterexample this round. The repair loop is not converging on these items. Resolve them with the user — adjust the contract design, or record an owner waiver accepting them as known limitations — before the plan can be promoted.`,
  };
}

// ── Conceptual-design-critique gate ───────────────────────────────────────────

type CritiqueGate =
  | { kind: "proceed" }
  | { kind: "escalate"; reason: "stall" | "runaway"; blocking: string[]; note: string }
  | { kind: "repair"; critiqueHash: string; blockingIds: string[] };

/** Blocking-severity critique item ids from a conceptual_design_critique payload. */
function blockingCritiqueIds(critique: unknown): string[] {
  const items =
    isRecord(critique) && Array.isArray(critique.items) ? critique.items : [];
  return items
    .filter((item): item is Record<string, unknown> => isRecord(item))
    .filter((item) => item.severity === "blocking")
    .map((item) => (typeof item.id === "string" ? item.id : ""))
    .filter((id) => id.length > 0);
}

/**
 * Decide whether the pipeline may advance past the conceptual-design critique.
 *
 * The routing signal is MECHANICAL and derived only from the critique items: a
 * critique carrying ANY `severity: "blocking"` item means the design is not
 * approved and must be repaired — regardless of the author-stated `verdict`
 * string. This closes the contradictory-combo gap: a critique that marks items
 * `blocking` while declaring `approved` / `approved_with_concerns` (which the
 * pipeline previously waved through, since only a judge verdict ever gated
 * anything) no longer silently proceeds. Enforce-in-tooling: the verdict label
 * is advisory display; the blocking-item set is the contract.
 *
 * Convergence-terminated, mirroring {@link evaluateJudgeGate}: the first blocking
 * critique ⇒ repair the design (`finalized_module_contracts`); repairing it
 * re-stales and re-emits the critique (it depends on the finalized contracts), so
 * a clean re-critique ⇒ proceed (the fixpoint). A fresh critique whose blocking
 * ids were ALL already addressed by a prior repair, with none new ⇒ escalate
 * (stall — the design loop is not converging) rather than repair forever; the
 * runaway backstop also escalates (loud).
 */
export async function evaluateCritiqueGate(artifactsDir: string): Promise<CritiqueGate> {
  const env = await readContractArtifact(artifactsDir, "conceptual_design_critique");
  if (!env) return { kind: "proceed" };
  const critique = envelopePayload(env);
  const blockingIds = blockingCritiqueIds(critique);
  if (blockingIds.length === 0) return { kind: "proceed" };

  const repairState = await readRepairState(artifactsDir);
  const critiqueRepairs = repairState.critique_repairs ?? [];
  const critiqueHash = env.content_hash;
  const alreadyHandled = critiqueRepairs.some((r) => r.critique_hash === critiqueHash);

  // Idempotent re-entry: this exact critique already drove a repair (its design
  // repair has not yet produced a fresh critique). Re-emit the same repair.
  if (alreadyHandled) {
    return { kind: "repair", critiqueHash, blockingIds };
  }

  const addressed = new Set(critiqueRepairs.flatMap((r) => r.blocking_ids ?? []));
  const newBlocking = blockingIds.filter((id) => !addressed.has(id));

  // Runaway backstop (loud) — pathological non-convergence.
  if (critiqueRepairs.length >= MAX_CONTRACT_REPAIR_ITERATIONS) {
    return {
      kind: "escalate",
      reason: "runaway",
      blocking: blockingIds,
      note: `The conceptual-design critique↔repair loop reached its runaway backstop (${critiqueRepairs.length} repair rounds) while still raising blocking concerns. Review the critique and contract design with the user before proceeding.`,
    };
  }

  // Progress: a new blocking concern (or the first round) ⇒ repair the design.
  if (critiqueRepairs.length === 0 || newBlocking.length > 0) {
    return { kind: "repair", critiqueHash, blockingIds };
  }

  // Stall: every blocking concern was already addressed by a prior repair, none
  // new ⇒ the design loop is not converging ⇒ escalate to the user.
  return {
    kind: "escalate",
    reason: "stall",
    blocking: blockingIds,
    note: `The conceptual-design critique re-raised blocking concern(s) that a prior design repair already addressed (${blockingIds.join(", ")}), with none newly raised. The design is not converging on these concerns. Resolve them with the user — revise the contract design or downgrade the concerns to advisory — before the pipeline can proceed.`,
  };
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
  // A node that resolves to no write scope is undispatchable: no worktree seed, no
  // write boundary, no paths to inline for a single-shot worker. It used to reach
  // the dispatch boundary anyway and fail there with "there is nothing a worker
  // could be scoped to" — cascade-blocking its dependents, three steps from the
  // cause. Refusing HERE puts it in front of the regeneration loop this validator
  // already feeds, and names the slug that failed to join.
  const { resolve: resolveWriteScope, availableSlugs } =
    await buildNodeWriteScopeResolver(artifactsDir);
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
    if (resolveWriteScope(node).length === 0) {
      const carried = [
        ...(node.satisfies_obligations ?? []),
        ...(node.verification_obligation_ids ?? []),
      ];
      violations.push(
        `Node "${node.id}" resolves to an EMPTY write scope, so nothing could be dispatched for it. ` +
          `It declares no output_files/files_likely_touched, and none of its obligation ids ` +
          `(${carried.join(", ") || "none"}) begins with "OBL-<module>-" for any module in ` +
          `module_decomposition (${availableSlugs.join(", ") || "no modules declared"}). ` +
          `Declare the node's output_files, or name its obligations after a decomposed module.`,
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
 * artifacts: paired obligations, evidence threading, source-scoped digest
 * coverage, and INV-CO-12 reconciliation derivation.
 *
 * Branch on `evaluated` before trusting emptiness. This no longer flattens four `ValidationIssue[]`
 * into one array, where a gate that never RAN and a gate that ran CLEAN both
 * contributed nothing and were indistinguishable. It consumes the shared
 * gate-outcome record and branches on `evaluated` first: at this boundary every
 * phase artifact exists, so a skipped gate is a violation, not a pass. See
 * {@link consumeGateOutcomes} for the per-boundary `required` policy and the one
 * declared exception (`digest_coverage`).
 */
export async function evaluateContractObligationsPromotionGate(
  artifactsDir: string,
  root: string = climbOutOfAuditTools(artifactsDir),
  inputs?: ContractPipelineCrossGateInputs,
): Promise<ContractObligationsGateResult> {
  const outcomes = await evaluateContractPipelineCrossGateOutcomes(
    inputs ?? (await readCrossGateInputs(artifactsDir, root)),
  );
  return consumeGateOutcomes(outcomes, PROMOTION_GATES, PROMOTION_REQUIRED_GATES);
}

/**
 * Pre-adversarial structural floor (S5). The subset of the contract-obligation
 * gates whose inputs all exist by the time the critic phase is reached
 * (paired-obligation coverage, source-scoped digest coverage, and seam
 * reconciliation derivation — none of which need the judge verdict or the
 * implementation_dag). Running them BEFORE the expensive critic/judge loop means
 * the adversarial phases only ever see structurally-sound obligations, tests, and
 * contracts, and a structural gap is re-emitted to the precise responsible phase
 * instead of being discovered at promotion (after the adversarial budget is spent)
 * and re-emitted to the wrong phase. The full {@link evaluateContractObligationsPromotionGate}
 * — including the evidence-threading check that needs the judge + DAG — still runs
 * at promotion as the fail-closed backstop; this gate never replaces it.
 *
 * Returns the first failing gate's responsible phase + rendered error lines, or
 * null when the structural floor is clean. Branches on each outcome's
 * `evaluated` before its empty issue list is allowed to mean clean
 * (the branch-on-evaluated rule); `contract_finalization`, `seam_reconciliation`
 * and `test_validator_plan` all precede `critic` in the phase order, so a
 * skipped gate here is a malformed payload rather than an absent one.
 */
export async function evaluatePreCriticStructuralGate(
  artifactsDir: string,
  root: string = climbOutOfAuditTools(artifactsDir),
  inputs?: ContractPipelineCrossGateInputs,
): Promise<{ phase: "contract_finalization" | "test_validator_plan"; errorLines: string[] } | null> {
  const outcomes = await evaluateContractPipelineCrossGateOutcomes(
    inputs ?? (await readCrossGateInputs(artifactsDir, root)),
  );

  // Upstream-owned checks first: a derivation/coverage gap is fixed in the
  // finalized contracts (the obligation ledger is derived from them).
  const design = consumeGateOutcomes(
    outcomes,
    ["reconciliation_derivation", "digest_coverage"],
    PRE_CRITIC_REQUIRED_GATES,
  );
  if (!design.ok) {
    return {
      phase: "contract_finalization",
      errorLines: design.violations.map((violation) => `- ${violation}`),
    };
  }

  // A testable obligation without a paired spec is fixed in the test plan
  // (skeleton-scaffolded from the derived ledger).
  const tests = consumeGateOutcomes(
    outcomes,
    ["paired_obligations"],
    PRE_CRITIC_REQUIRED_GATES,
  );
  if (!tests.ok) {
    return {
      phase: "test_validator_plan",
      errorLines: tests.violations.map((violation) => `- ${violation}`),
    };
  }

  return null;
}

// ── M-B3: source-grounded citation gate (repo-tree knownPaths) ────────────────
//
// A contract finding that cites a file path or a code symbol must point at
// something REAL in the working tree. The gate runs at two boundaries:
//
//  1. PRE-CRITIC: ground the module_decomposition's `file_scope` citations
//     (each module declares the files it owns; file_scope lives in the
//     decomposition — the finalized contracts carry interface fields, not
//     paths). A module that cites only a path that does not exist AND no real
//     symbol is hallucinating its scope before the adversarial budget is ever
//     spent — re-emit the `decomposition` phase (the phase that OWNS file_scope,
//     so re-authoring it can actually fix the bad path; re-emitting a downstream
//     phase like contract_finalization could never change file_scope → loops).
//  2. PROMOTION BACKSTOP: ground every promoted extracted-plan finding's
//     citations before the plan is handed to the document/implement flow.
//
// Fail-closed ONLY when the working tree itself is unreadable (git ls-files
// returns nothing) — a normal run with legitimately new-file scopes is not
// bricked, because a finding grounds if ANY cited path OR symbol is real.

/**
 * Map module_decomposition modules to Finding-shaped citations the shared
 * grounding gate consumes: each module's `file_scope` → affected_files (the
 * declared paths it owns), its name + responsibilities → summary (for the
 * symbol-shaped grounding fallback). The decomposition is where file_scope
 * lives — the finalized contracts carry interface fields (inputs/outputs/
 * invariants), not paths — so a module that declares only a non-existent
 * file_scope path is the pre-critic hallucination this catches.
 *
 * A module that declares NO file_scope at all contributes no citation (there is
 * nothing to ground) — it is not a hallucination, just an undeclared scope.
 */
function decompositionModulesToCitations(decompositionPayload: unknown): Finding[] {
  const modules =
    isRecord(decompositionPayload) && Array.isArray(decompositionPayload.modules)
      ? (decompositionPayload.modules as unknown[])
      : [];
  const citations: Finding[] = [];
  for (const [i, mod] of modules.entries()) {
    if (!isRecord(mod)) continue;
    const fileScope = Array.isArray(mod.file_scope)
      ? (mod.file_scope as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    if (fileScope.length === 0) continue;
    const name = typeof mod.name === "string" ? mod.name : `module-${i}`;
    const responsibilities =
      typeof mod.responsibilities === "string" ? mod.responsibilities : "";
    citations.push({
      id: name,
      title: name,
      category: "module_contract",
      severity: "medium",
      confidence: "high",
      lens: "architecture",
      summary: `${name} ${responsibilities}`,
      affected_files: fileScope.map((path) => ({ path })),
    } as Finding);
  }
  return citations;
}

/**
 * Pre-critic citation grounding over the module decomposition's file scope.
 * Returns rendered error lines (re-emit contract_finalization) or null when clean
 * — including a clean fail-closed pass (the gate's own repo-tree issue is surfaced
 * as an error line so an unreadable tree is loud, never silent).
 */
async function evaluatePreCriticCitationGrounding(
  artifactsDir: string,
  repoRoot: string,
): Promise<{ errorLines: string[] } | null> {
  const decomposition = envelopePayload(
    await readContractArtifact(artifactsDir, "module_decomposition"),
  );
  const citations = decompositionModulesToCitations(decomposition);
  if (citations.length === 0) return null;
  const result = await validateContractCitationGrounding(citations, repoRoot);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return null;
  return { errorLines: errors.map((issue) => `- [${issue.path}] ${issue.message}`) };
}

/**
 * Promotion-backstop citation grounding over the promoted extracted-plan
 * findings. Returns rendered violation lines, or null when every finding grounds.
 */
export async function evaluatePromotedPlanCitationGrounding(
  artifactsDir: string,
  repoRoot: string,
): Promise<{ violations: string[] } | null> {
  const plan = await readOptionalJsonFile<{ findings?: unknown }>(
    intakePaths(artifactsDir).extractedPlan,
  );
  const findings =
    isRecord(plan) && Array.isArray(plan.findings)
      ? (plan.findings as Finding[])
      : [];
  if (findings.length === 0) return null;
  const result = await validateContractCitationGrounding(findings, repoRoot);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return null;
  return { violations: errors.map((issue) => `[${issue.path}] ${issue.message}`) };
}

// ── DC-3: parallel per-module contract drafting ───────────────────────────────
//
// `module_contract_drafting` (→ module_contracts) aggregates a `module_contracts[]`
// array keyed by module name. DC-3 exposes one bounded host workload per module,
// replacing the former single sequential workload — each agent reads its own
// module's file scope, so no single agent owns both sides of a seam. Each agent
// writes a per-module SHARD; the orchestrator merges all shards into the
// aggregated artifact — byte-identical in shape to the single-agent output — and
// guarantees the merge is COMPLETE (every decomposed module present) before
// downstream derivation runs. A missing shard re-emits the wave (never a partial
// aggregate). `contract_finalization` is NOT a parallel wave: it is derived
// deterministically from the drafts + seam report (see the deterministic
// contract_finalization fast path), no fresh source read.

/** The phase(s) that fan out per module, and the artifact each produces. */
const PARALLEL_MODULE_PHASES = {
  module_contract_drafting: "module_contracts",
} as const;

type ParallelModulePhase = keyof typeof PARALLEL_MODULE_PHASES;

export function isParallelModulePhase(phase: string): phase is ParallelModulePhase {
  return phase === "module_contract_drafting";
}

interface DecomposedModule {
  name: string;
  responsibilities: string;
  file_scope: string[];
}

/** Read the decomposed modules (name + responsibilities + file_scope) in order. */
async function readDecomposedModules(
  artifactsDir: string,
): Promise<DecomposedModule[]> {
  const decomposition = envelopePayload(
    await readContractArtifact(artifactsDir, "module_decomposition"),
  );
  const modules = isRecord(decomposition) && Array.isArray(decomposition.modules)
    ? decomposition.modules
    : [];
  const result: DecomposedModule[] = [];
  for (const mod of modules) {
    if (!isRecord(mod) || typeof mod.name !== "string" || mod.name.length === 0) {
      continue;
    }
    result.push({
      name: mod.name,
      responsibilities:
        typeof mod.responsibilities === "string" ? mod.responsibilities : "",
      file_scope: Array.isArray(mod.file_scope)
        ? mod.file_scope.filter((p): p is string => typeof p === "string")
        : [],
    });
  }
  return result;
}

/** The subset of an implementation_dag node the write-scope resolution reads. */
interface DagScopeNode {
  output_files?: string[];
  files_likely_touched?: string[];
  satisfies_obligations?: string[];
  verification_obligation_ids?: string[];
}

/**
 * Characters that disqualify a finalized-contract entry from being read as a
 * repo-relative write target: any whitespace (prose), `:` (the `artifact:<name>`
 * ordering token and the Windows drive form), and the glob/redirect set no
 * legal declared path carries.
 */
const NON_WRITE_TARGET_CHARS = /[\s:*?"<>|]/u;

/**
 * A finalized module contract's `outputs` / `side_effects` are FREE PROSE that
 * may name a file ("src/foo.ts") or may describe an effect ("writes the run
 * ledger under .audit-tools") or carry an ordering token
 * ("artifact:validated-roster" — see ARTIFACT_TOKEN_PATTERN in phaseCut.ts).
 * Only the first kind is a write target, so this is a deliberately CONSERVATIVE
 * parse: an entry qualifies only when it reads unambiguously as a repo-relative
 * path, and everything else is silently dropped — prose stays prose. A false
 * positive here would widen a worker's write scope on the strength of a
 * sentence, which is strictly worse than the manual widening this replaces.
 *
 * Returns the forward-slashed path, or null when the entry is not one.
 */
function contractDeclaredWriteTarget(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const trimmed = entry.trim();
  if (trimmed.length === 0) return null;
  if (NON_WRITE_TARGET_CHARS.test(trimmed)) return null;
  // Absolute (POSIX or Windows-UNC) forms are not repo-relative.
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return null;
  const normalized = trimmed.replace(/\\/gu, "/");
  if (normalized.split("/").includes("..")) return null;
  // A bare word ("session") is an interface name, not a path. Require either a
  // path separator or a file extension.
  if (!normalized.includes("/") && !/\.[a-z0-9]{1,6}$/iu.test(normalized)) return null;
  return normalized;
}

/**
 * The path-parseable write targets each finalized module contract declares,
 * keyed by `moduleSlug(name)` — the SAME identity the obligation ids encode, so
 * this map joins to the decomposition's modules without a second name space.
 *
 * Degrades to an empty map when the artifact is absent or malformed: this
 * resolver runs on the VALIDATOR's refusal path, so a bad contracts file must
 * cost the widening, never wedge every subsequent next-step with a throw.
 */
async function readModuleContractWriteTargets(
  artifactsDir: string,
): Promise<Map<string, string[]>> {
  let finalized: unknown;
  try {
    finalized = envelopePayload(
      await readContractArtifact(artifactsDir, "finalized_module_contracts"),
    );
  } catch {
    return new Map();
  }
  const entries =
    isRecord(finalized) && Array.isArray(finalized.module_contracts)
      ? finalized.module_contracts
      : [];
  const bySlug = new Map<string, string[]>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.name !== "string") continue;
    const slug = moduleSlug(entry.name);
    if (slug.length === 0) continue;
    const targets = bySlug.get(slug) ?? [];
    const declared = [
      ...(Array.isArray(entry.outputs) ? entry.outputs : []),
      ...(Array.isArray(entry.side_effects) ? entry.side_effects : []),
    ];
    for (const raw of declared) {
      const target = contractDeclaredWriteTarget(raw);
      if (target !== null && !targets.includes(target)) targets.push(target);
    }
    bySlug.set(slug, targets);
  }
  return bySlug;
}

/**
 * Single source for "which files may this DAG node write". The scope is the
 * UNION of two declarations, never one overriding the other:
 *
 *  - the node's own declared files (`output_files`, else `files_likely_touched`);
 *  - the path-parseable write targets (`outputs` + `side_effects`) declared by
 *    the finalized contract of the module(s) the node's obligations belong to,
 *    resolved by longest-`OBL-<slug>-` prefix so a short slug never mis-claims a
 *    longer module's targets.
 *
 * A node that declared NO files of its own additionally inherits the
 * `file_scope` of those same modules — that inheritance is the scope-less
 * FALLBACK only, and is deliberately not unioned into a node that did declare.
 *
 * ⚠ The declared-files-win EARLY RETURN this used to perform is deliberately
 * superseded (owner decision, nightly ledger 2026-08-20). The module contract is
 * where a module's write targets are declared, and they never reached the node
 * scope — so an implementer was handed an obligation whose declared target file
 * was missing from `allowed_files`, and a human widened it by hand (four
 * recoveries in one wave). Union, not precedence.
 *
 * ⚠ Shared by the PROMOTER (which derives the scope) and the VALIDATOR (which
 * refuses when it resolves to nothing) on purpose. Two copies of this resolution
 * would drift, and the drift is invisible: the validator would pass a node the
 * promoter then writes scope-less.
 *
 * The join it performs is between two INDEPENDENTLY AUTHORED name spaces — the
 * obligation id's slug and the decomposition's module names — which is exactly
 * where it fails. Observed 2026-08-09: nodes carrying `OBL-attribution-capture-…`
 * and `OBL-verdict-capture-…` matched no module, because the decomposition had
 * named them `dispatch-attribution-capture` and `verdict-capture-audit` /
 * `verdict-capture-remediate`. Their siblings matched and dispatched; these two
 * resolved to nothing and died later at the dispatch boundary with "there is
 * nothing a worker could be scoped to", three steps from the cause.
 */
async function buildNodeWriteScopeResolver(artifactsDir: string): Promise<{
  resolve: (node: DagScopeNode) => string[];
  availableSlugs: string[];
}> {
  const decomposedModules = await readDecomposedModules(artifactsDir);
  const contractTargetsBySlug = await readModuleContractWriteTargets(artifactsDir);
  const moduleScopesBySlug = decomposedModules
    .map((m) => ({
      slug: moduleSlug(m.name),
      files: m.file_scope,
      targets: contractTargetsBySlug.get(moduleSlug(m.name)) ?? [],
    }))
    .sort((a, b) => b.slug.length - a.slug.length);
  const resolve = (node: DagScopeNode): string[] => {
    const declared = [...new Set(node.output_files ?? node.files_likely_touched ?? [])];
    const obligationIds = [
      ...(node.satisfies_obligations ?? []),
      ...(node.verification_obligation_ids ?? []),
    ];
    const inherited = new Set<string>();
    const ownedTargets = new Set<string>();
    for (const id of obligationIds) {
      const owner = moduleScopesBySlug.find((m) => id.startsWith(`OBL-${m.slug}-`));
      if (!owner) continue;
      // file_scope inheritance is the scope-less fallback ONLY; the contract's
      // declared targets are unioned in either way.
      if (declared.length === 0) for (const f of owner.files) inherited.add(f);
      for (const t of owner.targets) ownedTargets.add(t);
    }
    // Content-derived order: the node's own declarations first, in the order
    // they were declared, then the added targets path-sorted — so the resolved
    // scope (which reaches the plan's content hash through affected_files)
    // never churns on module ordering.
    const base = declared.length > 0 ? declared : [...inherited];
    const added = [...ownedTargets]
      .filter((t) => !base.includes(t))
      .sort((left, right) => compareCodeUnits(left, right));
    return [...base, ...added];
  };
  return { resolve, availableSlugs: moduleScopesBySlug.map((m) => m.slug) };
}

/** The goal_id carried by module_decomposition (authoritative for the merge). */
async function readDecompositionGoalId(artifactsDir: string): Promise<string> {
  const decomposition = envelopePayload(
    await readContractArtifact(artifactsDir, "module_decomposition"),
  );
  return isRecord(decomposition) && typeof decomposition.goal_id === "string"
    ? decomposition.goal_id
    : "";
}

/** Filesystem-safe shard id for a module name (the merge re-keys by name, not id). */
function moduleShardId(moduleName: string): string {
  const slug = moduleName.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  // Keep names disjoint even after slugging by appending a short content hash.
  return `${slug || "module"}-${hashContent(moduleName, { length: 8 })}`;
}

/** Directory holding one per-module shard for a given parallel phase. */
function moduleWaveDir(artifactsDir: string, phase: ParallelModulePhase): string {
  return join(contractPipelineDir(artifactsDir), "module-waves", phase);
}

function moduleShardPath(
  artifactsDir: string,
  phase: ParallelModulePhase,
  moduleName: string,
): string {
  return join(moduleWaveDir(artifactsDir, phase), `${moduleShardId(moduleName)}.json`);
}

interface ModuleShardScan {
  /** Shards present and parseable, keyed by the module name they cover. */
  present: Map<string, Record<string, unknown>>;
  /** Decomposed module names with no present (or unparseable) shard. */
  missing: string[];
}

/**
 * Scan the per-module shards for a phase against the decomposed module set. A
 * shard counts as present only when it parses to an object whose module-contract
 * `name` matches the decomposed module it is filed under — a stray/mismatched
 * shard never satisfies completeness.
 */
async function scanModuleShards(
  artifactsDir: string,
  phase: ParallelModulePhase,
  modules: DecomposedModule[],
): Promise<ModuleShardScan> {
  const present = new Map<string, Record<string, unknown>>();
  const missing: string[] = [];
  for (const mod of modules) {
    const shard = await readOptionalJsonFile<unknown>(
      moduleShardPath(artifactsDir, phase, mod.name),
    );
    const contract = extractShardContract(shard, mod.name);
    if (contract) {
      present.set(mod.name, contract);
    } else {
      missing.push(mod.name);
    }
  }
  return { present, missing };
}

/**
 * Normalize a worker-written shard into the single module-contract record for
 * `moduleName`. Accepts either the bare contract object (`{ name, ... }`) or the
 * aggregated wrapper shape (`{ module_contracts: [{ name, ... }] }`) so a worker
 * that mirrored the aggregate schema for one module still merges. Returns null
 * when no record for `moduleName` is found.
 */
function extractShardContract(
  shard: unknown,
  moduleName: string,
): Record<string, unknown> | null {
  if (!isRecord(shard)) return null;
  if (Array.isArray(shard.module_contracts)) {
    const match = shard.module_contracts.find(
      (entry) => isRecord(entry) && entry.name === moduleName,
    );
    return isRecord(match) ? match : null;
  }
  if (shard.name === moduleName) return shard;
  return null;
}

/**
 * Merge complete per-module shards into the aggregated `module_contracts`
 * artifact, byte-identical in shape to the former single-agent output: the same envelope
 * (`contract_version`, `goal_id`, `module_contracts[]`, `created_at`) with one
 * entry per module in DECOMPOSITION order (deterministic, not directory order).
 * Caller guarantees completeness first.
 */
function mergeModuleShards(
  modules: DecomposedModule[],
  present: Map<string, Record<string, unknown>>,
  goalId: string,
): {
  contract_version: string;
  goal_id: string;
  module_contracts: Record<string, unknown>[];
  created_at: string;
} {
  const contractVersion = CP_MODULE_CONTRACTS_VERSION;
  const moduleContracts = modules.map((mod) => present.get(mod.name)!);
  return {
    contract_version: contractVersion,
    goal_id: goalId,
    module_contracts: moduleContracts,
    created_at: new Date().toISOString(),
  };
}

/**
 * Write-through invariant (repair-revert fix): the per-module shards under
 * `module-waves/module_contract_drafting/` are the single source of truth for the
 * aggregated `module_contracts` artifact — the aggregate is a pure re-merge of
 * them. When that aggregate is instead ingested directly (a degenerate
 * single-agent draft, or a direct edit), decompose it back into its shards
 * (matched by module `name`, in decomposition order) so a later cascade that
 * re-merges the shards reproduces the change instead of reverting to the stale
 * shards. No-op for any artifact that is not a sharded module-phase artifact
 * (`finalized_module_contracts` is deterministically derived, never sharded), or a
 * payload lacking a `module_contracts[]` array.
 */
async function propagateAggregateToShards(
  artifactsDir: string,
  name: ContractPipelineArtifactName,
  payload: unknown,
): Promise<void> {
  const phase = (
    Object.entries(PARALLEL_MODULE_PHASES).find(
      ([, artifact]) => artifact === name,
    )?.[0]
  ) as ParallelModulePhase | undefined;
  if (!phase) return;
  if (!isRecord(payload) || !Array.isArray(payload.module_contracts)) return;
  const contracts = payload.module_contracts;
  const modules = await readDecomposedModules(artifactsDir);
  for (const mod of modules) {
    const entry = contracts.find(
      (c): c is Record<string, unknown> => isRecord(c) && c.name === mod.name,
    );
    if (entry) {
      await writeJsonFile(moduleShardPath(artifactsDir, phase, mod.name), entry);
    }
  }
}

// ── Step builder ──────────────────────────────────────────────────────────────

/**
 * Resolve the adversarial-depth dial for a run (extracted from
 * buildNextContractPipelineStep for testability; behavior-preserving).
 *
 * The depth derives from the intake risk signal (the slice-2 shared signal).
 * Escalate-on-evidence (optimistic-start): the run begins at the cheap intake
 * tier; once decomposition reveals the work's actual shape, the tier is raised
 * for THIS and every subsequent next-step. The raise is idempotent + convergent
 * (escalateRiskSignal no-ops once the tier already covers the evidence), and the
 * signal is rewritten only on a real raise. Absent signal ⇒ undefined ⇒ the
 * renderer applies its fail-safe full depth (floor is `light`, never off).
 */
async function resolveAdversarialDepth(
  artifactsDir: string,
): Promise<{
  riskSignal: Awaited<ReturnType<typeof readIntakeRiskSignal>>;
  adversarialDepth: AdversarialDepth | undefined;
}> {
  let riskSignal = await readIntakeRiskSignal(artifactsDir);
  if (riskSignal) {
    const modules = await readDecomposedModules(artifactsDir);
    if (modules.length > 0) {
      const evidence = decompositionRiskEvidence({
        moduleCount: modules.length,
        fileScopes: modules.flatMap((m) => m.file_scope),
      });
      if (evidence) {
        const raised = escalateRiskSignal(riskSignal, evidence);
        if (raised !== riskSignal) {
          await writeIntakeRiskSignal(artifactsDir, raised);
          riskSignal = raised;
        }
      }
    }
  }
  return {
    riskSignal,
    adversarialDepth: riskSignal ? adversarialDepthForTier(riskSignal.tier) : undefined,
  };
}

// ── The gate walk: named units on the ONE shared step-emission scaffold ───────
//
// `buildNextContractPipelineStep` used to be a ~1,360-line body holding fourteen
// gates under a decimal-insertion numbering scheme (2, 2a, 2.5, 2.55, 2.6, 2.7,
// 2.8, 2.9, 2.10, 3, 4, 4a, 4c, 4d, 5a, 5b, 5) in which section "5" executed
// AFTER the sections labelled "5a"/"5b", and the label "5a" named two unrelated
// blocks. Execution order was unrecoverable from the labels, and every gate was
// a closure over the entry point's locals, so none could be exercised on its own.
//
// It is now ONE ORDERED TABLE of named gates. Three drift classes die by
// construction rather than by comment discipline:
//   • order — the walk order IS the table's own key order (`handledKeys`), so a
//     comment cannot disagree with execution, and a gate named in the walk but
//     absent from the table is a loud refusal, not a silent skip;
//   • uniqueness — duplicate object keys are a compile error, so two gates can
//     never share a label the way "5a" once did;
//   • emission — every gate returns a PLAN and never writes; the shared
//     `createStepEmissionScaffold` (the scaffold-adopter invariant, consumed from
//     `audit-tools/shared`, never forked into a second scaffold of this
//     module's own) owns the single call site that turns a plan into a written
//     step.
//
// A gate still performs the DOMAIN work its decision needs (ingesting payloads,
// archiving a rejected artifact, deriving a deterministic artifact). What it
// never does is write or log the step — that is the scaffold's one job.

/**
 * Everything a gate is handed. Assembled once per invocation, then passed to
 * every gate in the walk, so each gate is a module-level function that can be
 * called and tested on its own.
 *
 * Two fields are deliberately MUTABLE, each written by exactly one gate:
 *   • `artifactsSettled` — set by the staleness gate once this invocation's own
 *     ingestion + archive pass has run. {@link readCrossGatePayloads} REFUSES
 *     before it is set, which is how the branch-on-evaluated invariant's freshness
 *     half is enforced mechanically instead of by a caller remembering to
 *     re-read: a payload cached from before the pass is unrepresentable.
 *   • `nextPhase` — the phase frontier, resolved AFTER the archive pass because
 *     archiving a stale artifact re-opens its producing phase.
 */
export interface ContractGateContext {
  readonly options: ContractPipelineStepOptions;
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly sourcePaths?: string[];
  readonly paths: ReturnType<typeof intakePaths>;
  readonly artifactPaths: Partial<Record<ContractPipelineArtifactName, string>>;
  /** Present only for structured_audit (path-A) runs. */
  readonly pathASeedPath?: string;
  readonly riskSignal: Awaited<ReturnType<typeof readIntakeRiskSignal>>;
  readonly adversarialDepth: AdversarialDepth | undefined;
  artifactsSettled: boolean;
  nextPhase: string | null;
}

/**
 * WHAT to emit — never how to write it. Five writers exist (phase step, bare
 * prompt step, blocked step, per-module wave, collapsed framing round-trip),
 * plus the two non-writing outcomes the pipeline also has to express: re-derive
 * after writing a deterministic artifact, and complete.
 */
type ContractStepPlan =
  | { via: "phase"; phase: string; extraSection?: string }
  | { via: "step"; prompt: string; outputPath: string; stopCondition: string }
  | { via: "blocked"; prompt: string; stopCondition: string }
  | { via: "module_wave"; phase: ParallelModulePhase }
  | { via: "collapsed_round_trip"; phases: string[] }
  | { via: "rederive" }
  | { via: "pipeline_complete" };

/** A contract-pipeline gate: the plan to emit, or `null` to hand on to the next. */
type ContractGate = StepGateHandler<ContractGateContext, ContractStepPlan>;

// ── Writers ───────────────────────────────────────────────────────────────────

/** The artifact-path map every emitted step carries (existing artifacts only). */
function contractStepArtifactPaths(
  ctx: ContractGateContext,
  outputPath?: string,
): Record<string, string> {
  const stepArtifactPaths: Record<string, string> = {};
  if (outputPath) stepArtifactPaths.output = outputPath;
  for (const [key, value] of Object.entries(ctx.artifactPaths)) {
    if (value && existsSync(value)) stepArtifactPaths[key] = value;
  }
  if (ctx.sourcePaths) {
    stepArtifactPaths.source_manifest = ctx.paths.sourceManifest;
    stepArtifactPaths.remediation_brief = ctx.paths.brief;
  }
  return stepArtifactPaths;
}

function writeContractPromptStep(
  ctx: ContractGateContext,
  params: { prompt: string; outputPath: string; stopCondition: string },
): Promise<RemediationStep> {
  const nextCommand = loaderCommand("next-step");
  const prompt = `${params.prompt}

After writing the output file, run:

\`${nextCommand}\`
`;
  return writeCurrentStep({
    stepKind: CONTRACT_STEP_KIND,
    status: "ready",
    runId: ctx.runId,
    repoRoot: ctx.root,
    artifactsDir: ctx.artifactsDir,
    prompt,
    allowedCommands: [nextCommand],
    stopCondition: params.stopCondition,
    artifactPaths: contractStepArtifactPaths(ctx, params.outputPath),
  });
}

function writeContractPhaseStep(
  ctx: ContractGateContext,
  phase: string,
  extraSection?: string,
): Promise<RemediationStep> {
  const rendered = renderContractPipelinePrompt({
    role: phase,
    artifactPaths: ctx.artifactPaths,
    sourcePaths: ctx.sourcePaths,
    repoRoot: ctx.root,
    pathASeedPath: ctx.pathASeedPath,
    adversarialDepth: ctx.adversarialDepth,
  });
  return writeContractPromptStep(ctx, {
    prompt: extraSection ? `${rendered.prompt}\n${extraSection}` : rendered.prompt,
    outputPath: rendered.outputPath,
    stopCondition: `Stop after writing the contract-pipeline output for phase "${phase}" and running next-step.`,
  });
}

function writeContractBlockedStep(
  ctx: ContractGateContext,
  params: { prompt: string; stopCondition: string },
): Promise<RemediationStep> {
  return writeCurrentStep({
    stepKind: CONTRACT_STEP_KIND,
    status: "blocked",
    runId: ctx.runId,
    repoRoot: ctx.root,
    artifactsDir: ctx.artifactsDir,
    prompt: params.prompt,
    allowedCommands: [],
    stopCondition: params.stopCondition,
  });
}

/**
 * T1 slice 4b: ONE round-trip whose prompt concatenates the rendered specs of
 * several consecutive authoring phases. The worker writes every named artifact
 * top-down (each later phase's inputs are the files it wrote in the earlier
 * sections of the same round-trip), then runs next-step once. The group header
 * overrides the per-section "stop after writing" lines so they are not read as
 * three separate stop points.
 */
/**
 * The extra section a collapsed member carries, mirroring the gate that would
 * have claimed that phase on its own — so collapsing changes the number of
 * round-trips and nothing else about what the worker is told.
 *
 * This is load-bearing, not tidiness. `collapsedRoundTripGate` is registered
 * BEFORE `scaffoldedPhaseGate`, so without this a group containing
 * `test_validator_plan` would silently drop the S3 skeleton the worker is
 * supposed to fill in, and the collapse would quietly make that phase HARDER
 * rather than cheaper.
 */
async function collapsedSectionExtra(
  phase: string,
  artifactsDir: string,
): Promise<string | undefined> {
  if (phase === "test_validator_plan" || phase === "implementation_planning") {
    return await buildScaffoldSection(phase, artifactsDir);
  }
  return await buildReReviewSection(phase, artifactsDir);
}

async function writeCollapsedRoundTripStep(
  ctx: ContractGateContext,
  phases: string[],
): Promise<RemediationStep> {
  const sections = await Promise.all(
    phases.map(async (phase) => ({
      phase,
      rendered: renderContractPipelinePrompt({
        role: phase,
        artifactPaths: ctx.artifactPaths,
        sourcePaths: ctx.sourcePaths,
        repoRoot: ctx.root,
        pathASeedPath: ctx.pathASeedPath,
        adversarialDepth: ctx.adversarialDepth,
      }),
      extra: await collapsedSectionExtra(phase, ctx.artifactsDir),
    })),
  );
  const outputPaths = sections.map((s) => s.rendered.outputPath);
  const header = `# Collapsed Authoring Round-Trip — ${phases.length} Phases

This is a low-complexity change, so these ${phases.length} coherent authoring phases are combined into a SINGLE round-trip. Complete EVERY section below — author them top-down, writing each artifact to its named path (each later section's inputs are the files you write in the earlier sections of this same round-trip). Then run next-step ONCE.

Treat any per-section "Stop after writing the output file / do not advance" instruction as scoped to that section only — it does NOT mean stop the round-trip. Finish all sections first.

If you cannot complete a section (an artifact would be malformed), write the ones you can and run next-step: the pipeline re-emits any missing or invalid artifact as its own fine-grained step, so no work is lost.

Artifacts to produce (in order):
${outputPaths.map((p, i) => `${i + 1}. \`${p}\` (${phases[i]})`).join("\n")}`;
  const body = sections
    .map(
      (s) =>
        `\n---\n\n${s.extra ? `${s.rendered.prompt}\n${s.extra}` : s.rendered.prompt}`,
    )
    .join("\n");
  return writeContractPromptStep(ctx, {
    prompt: `${header}\n${body}`,
    outputPath: outputPaths[outputPaths.length - 1],
    stopCondition: `Stop after writing all ${phases.length} collapsed artifacts (${phases.join(", ")}) and running next-step once.`,
  });
}

/**
 * DC-3: fan a parallel phase out to one bounded item per module. The host owns
 * grouping, concurrency, and execution choices; this tool supplies only the
 * complete coherent workload. Each item writes a per-module shard, and the next
 * next-step merges every shard into the aggregated artifact before any
 * downstream derivation. A degenerate decomposition (zero or one module) falls
 * back to the single aggregated step.
 */
async function writeParallelModuleWaveStep(
  ctx: ContractGateContext,
  phase: ParallelModulePhase,
): Promise<RemediationStep> {
  const modules = await readDecomposedModules(ctx.artifactsDir);
  if (modules.length <= 1) {
    return writeContractPhaseStep(ctx, phase);
  }

  const inputArtifact = "module_decomposition";
  const inputPaths = (
    ["goal_spec", "context_bundle", "module_decomposition"] as const
  ).map((key) => `- \`${ctx.artifactPaths[key]}\` (${key})`);

  const moduleLines = modules
    .map((mod, i) => {
      const shardPath = moduleShardPath(ctx.artifactsDir, phase, mod.name);
      const scope =
        mod.file_scope.length > 0
          ? mod.file_scope.map((p) => `\`${p}\``).join(", ")
          : "_(no declared file scope)_";
      return `${i + 1}. **${mod.name}** — file scope: ${scope}\n   - Write this module's contract to exactly: \`${shardPath}\``;
    })
    .join("\n");

  const perModuleSchema = `{
  "name": "<module-name — must equal the assigned module>",
  "inputs": ["<what this module receives>"],
  "outputs": ["<what this module produces>"],
  "invariants": ["<invariant that must hold — include a verification_obligation note>"],
  "side_effects": ["<observable side-effects with owner>"],
  "validation_boundary": "<what this module validates vs. what callers must guarantee>",
  "failure_modes": ["<ways this module can fail and how callers should handle them>"],
  "neighbor_needs": [{ "neighbor": "<module-name>", "needs": "<what this module needs>" }]
}`;

  const taskVerb = "draft its module contract";
  const cwdNote = `\n> Set the shell/tool working directory to \`${ctx.root}\` before running any commands.\n`;
  const nextCommand = loaderCommand("next-step");
  const prompt = `# Per-Module Contract Drafting (${modules.length} modules)

This phase publishes one bounded item per module. Complete all ${modules.length} items below; the host owns how they are grouped or executed. Each item reads only its module's file scope, then writes ONLY that module's contract shard — no item owns both sides of a seam, and no item writes the aggregated artifact.
${cwdNote}
## Shared Inputs (every sub-agent may read these)

${inputPaths.join("\n")}

## Per-Module Assignments — one sub-agent each

For each module, dispatch one sub-agent to read its file scope from \`${inputArtifact}\` and ${taskVerb}, writing the result to the module's shard path:

${moduleLines}

Each shard must be a single JSON object of this shape (the orchestrator merges all shards into the aggregated \`${PHASE_TO_ARTIFACT[phase]}\` artifact — do NOT write that file yourself):

\`\`\`json
${perModuleSchema}
\`\`\`

## After All Sub-Agents Finish

Once every module's shard above has been written (all ${modules.length}), run:

\`${nextCommand}\`

The orchestrator verifies every module shard is present, merges them into \`${PHASE_TO_ARTIFACT[phase]}\`, and advances. If any shard is missing, this same wave is re-emitted for the missing modules — never a partial aggregate.

**Stop after the per-module shards are written and you run next-step.** Do not edit source files. Do not write the aggregated artifact. Do not advance further.
`;

  return writeCurrentStep({
    stepKind: CONTRACT_STEP_KIND,
    status: "ready",
    runId: ctx.runId,
    repoRoot: ctx.root,
    artifactsDir: ctx.artifactsDir,
    prompt,
    allowedCommands: [nextCommand],
    stopCondition: `Stop after writing every per-module shard for phase "${phase}" and running next-step.`,
    artifactPaths: contractStepArtifactPaths(ctx),
  });
}

/**
 * The ONE writer dispatch behind the scaffold's single emission call site. Each
 * underlying writer is reached from exactly here.
 */
async function writeContractStepPlan(
  ctx: ContractGateContext,
  plan: ContractStepPlan,
): Promise<RemediationStep | null> {
  switch (plan.via) {
    case "phase":
      return await writeContractPhaseStep(ctx, plan.phase, plan.extraSection);
    case "step":
      return await writeContractPromptStep(ctx, plan);
    case "blocked":
      return await writeContractBlockedStep(ctx, plan);
    case "module_wave":
      return await writeParallelModuleWaveStep(ctx, plan.phase);
    case "collapsed_round_trip":
      return await writeCollapsedRoundTripStep(ctx, plan.phases);
    case "rederive":
      // A deterministic artifact was just written; the frontier moved, so the
      // whole walk re-runs against the new state rather than guessing the phase.
      return await buildNextContractPipelineStep(ctx.options);
    case "pipeline_complete":
      return null;
  }
}

// ── Branch on `evaluated`: consuming the shared gate-outcome record ─────

/**
 * Read every contract-pipeline payload from disk, plus the intake
 * finding-enumeration, in the shape the shared cross-gate evaluator consumes.
 * Always a fresh read — there is no payload cache to go stale.
 */
async function readCrossGateInputs(
  artifactsDir: string,
  root: string,
): Promise<ContractPipelineCrossGateInputs> {
  const payloads = new Map<ContractPipelineArtifactName, unknown>();
  for (const name of CP_ARTIFACT_NAMES) {
    const envelope = await readContractArtifact(artifactsDir, name);
    if (envelope) payloads.set(name, envelopePayload(envelope));
  }
  const findingEnumeration = await readOptionalJsonFile<unknown>(
    intakePaths(artifactsDir).findingEnumeration,
  );
  // Waived counterexamples (open-bugs.md:108): the coverage gates must not
  // demand DAG nodes for a counterexample the owner recorded as an accepted
  // limitation — that would recreate the judge-gate wedge one gate later.
  const repairState = await readRepairState(artifactsDir);
  return {
    payloads,
    findingEnumeration,
    root,
    waivedCounterexampleIds: waivedJudgeAcceptedIds(
      repairState,
      payloads.get("judge_report"),
      payloads.get("counterexample"),
    ),
  };
}

/**
 * Read every contract-pipeline payload FRESH for the shared cross-gates.
 *
 * REFUSES before this invocation's ingestion + staleness-archive pass has run.
 * EVERY in-pipeline cross-gate read goes through here — including the two
 * exported helpers, which take the payloads this reader produced rather than
 * reading again — so there is no in-pipeline path to a payload that skipped the
 * check.
 * That is the freshness half of The branch-on-evaluated freshness rule, made mechanical: a
 * gate cannot be handed a payload snapshot taken before its own step archived
 * the stale copy, because the only way to obtain payloads declines to produce
 * them until `artifactsSettled` is set.
 */
async function readCrossGatePayloads(
  ctx: ContractGateContext,
): Promise<ContractPipelineCrossGateInputs> {
  if (!ctx.artifactsSettled) {
    throw new Error(
      "contract pipeline: cross-gate payloads were requested before this invocation's " +
        "ingestion + staleness-archive pass ran. A gate must read artifact payloads AFTER " +
        "the archive pass, never from a snapshot taken before it.",
    );
  }
  return await readCrossGateInputs(ctx.artifactsDir, ctx.root);
}

/** The verdict a call site derives from a subset of the shared gate outcomes. */
export interface CrossGateVerdict {
  ok: boolean;
  violations: string[];
}

/**
 * Consume a subset of the shared cross-gate outcomes, branching on `evaluated`
 * BEFORE an empty `issues` array is allowed to mean "clean".
 *
 * `required` is DECLARED PER CALL SITE, as data, because "did not run" means
 * different things at different boundaries. At a boundary whose upstream phase
 * order guarantees the gate's input exists, a skip is a refusal — its empty
 * issue list is proof of nothing. Earlier in the pipeline the same skip means
 * "not applicable yet", and the gate is simply not required there.
 *
 * THE UNCOVERED HALF, stated rather than implied: `digest_coverage` is the one
 * gate of the eight whose skip is a DOMAIN non-applicability (a source that is
 * not finding-enumerable) rather than a missing payload, so no boundary lists
 * it as required and a genuinely absent finding-enumeration file for an
 * enumerable source still skips silently. Closing that needs the gate module to
 * expose its enumerability predicate — an edit outside this work item's write
 * scope.
 */
export function consumeGateOutcomes(
  outcomes: readonly GateOutcome[],
  selected: readonly GateOutcome["gate"][],
  required: ReadonlySet<GateOutcome["gate"]>,
): CrossGateVerdict {
  const violations: string[] = [];
  for (const gate of selected) {
    const outcome = outcomes.find((candidate) => candidate.gate === gate);
    if (!outcome) {
      violations.push(
        `[${gate}] produced no outcome record; the gate set changed without this call site.`,
      );
      continue;
    }
    if (!outcome.evaluated) {
      if (required.has(gate)) {
        violations.push(
          `[${gate}] did not run (${outcome.reason ?? "no reason recorded"}). Its empty ` +
            `issue list is not proof of a clean gate at this boundary.`,
        );
      }
      continue;
    }
    for (const issue of outcome.issues) {
      if (issue.severity === "error") violations.push(`[${issue.path}] ${issue.message}`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Locate one gate's outcome in the canonical-order outcome list. */
function gateOutcomeOf(
  outcomes: readonly GateOutcome[],
  gate: GateOutcome["gate"],
): GateOutcome | undefined {
  return outcomes.find((candidate) => candidate.gate === gate);
}

/**
 * The gates the PROMOTION boundary requires to have actually run. Every phase
 * artifact exists by the time `nextPhase` is null, so a skip here can only mean
 * a payload went missing or malformed — never "too early".
 */
const PROMOTION_REQUIRED_GATES: ReadonlySet<GateOutcome["gate"]> = new Set([
  "paired_obligations",
  "evidence_threaded",
  "reconciliation_derivation",
]);

/** The subset of gates the promotion boundary consumes. */
const PROMOTION_GATES: readonly GateOutcome["gate"][] = [
  "paired_obligations",
  "evidence_threaded",
  "digest_coverage",
  "reconciliation_derivation",
];

/**
 * The gates the PRE-CRITIC structural floor requires. `contract_finalization`,
 * `seam_reconciliation` and `test_validator_plan` all precede `critic` in the
 * phase order, so their artifacts exist by the time this boundary is reached.
 */
const PRE_CRITIC_REQUIRED_GATES: ReadonlySet<GateOutcome["gate"]> = new Set([
  "paired_obligations",
  "reconciliation_derivation",
]);

// ── Gates, in execution order ─────────────────────────────────────────────────

/**
 * Seed source-digest binding. Re-hash every source path the path_a seed
 * recorded, against the digest it recorded at seed-build time, and refuse with
 * a classified blocked step on a mismatch — rather than spending the whole
 * design pipeline on content that no longer holds the findings the seed
 * enumerates. Runs first, before anything is ingested or derived.
 */
const seedSourceDigestGate: ContractGate = async (ctx) => {
  if (!ctx.pathASeedPath) return null;
  const seed = await readOptionalJsonFile<PathASeed>(ctx.pathASeedPath);
  const mismatches = await detectSeedSourceDigestMismatches(ctx.root, seed);
  if (mismatches.length === 0) return null;
  const lines = mismatches
    .map(
      (mismatch) =>
        `- \`${mismatch.path}\` — recorded \`${mismatch.expected.slice(0, 12)}…\`, ` +
        `now ${mismatch.actual ? `\`${mismatch.actual.slice(0, 12)}…\`` : "**unreadable**"}`,
    )
    .join("\n");
  return {
    via: "blocked",
    prompt: `# Source Content Changed Since the Audit Seed Was Built

The path-A seed records a sha256 for every source it was built from. The following no longer match, so the findings this pipeline is designing against may no longer describe the code:

${lines}

The findings this pipeline is designing against were derived from the recorded content, so re-deriving them is the only thing that makes the design sound again. Decide with the user:

1. **Re-run the audit extraction** against the current tree, so the findings describe the code as it now stands; or
2. **Restore the drifted sources** to the content the audit read, if the change was unintended.

Only as an explicit LAST resort — an accepted, recorded decision to design against findings that no longer match the code — delete \`${ctx.pathASeedPath}\` and re-run next-step. That rebuilds the seed from the CURRENT sources while keeping the OLD findings, which clears this alarm without re-deriving anything.`,
    stopCondition:
      "Stop — the contract pipeline is blocked on a source whose content no longer matches the audit seed.",
  };
};

/**
 * Ingest raw worker outputs into validated envelopes. An output that fails
 * validation is archived and its producing phase re-emitted with the validation
 * errors — LLM output is untrusted until validated.
 */
const invalidIngestionGate: ContractGate = async (ctx) => {
  const ingestion = await ingestContractArtifacts(ctx.artifactsDir);
  if (ingestion.invalid.length === 0) return null;
  const first = ingestion.invalid[0];
  const archived = await archiveContractArtifact(
    ctx.artifactsDir,
    first.name,
    "invalid",
    ctx.options.renameFn,
  );
  return {
    via: "phase",
    phase: ARTIFACT_TO_PHASE[first.name] ?? "goal_normalization",
    extraSection: `## Validation Errors From the Previous Attempt

The previous \`${first.name}\` output failed validation and was archived. Fix every issue below in the rewritten output:

${formatValidationIssues(first.issues)}
${rejectionRewriteInstruction(archived)}`,
  };
};

/**
 * Archive stale artifacts so the staleness DAG re-derives everything downstream
 * of a repaired (re-ingested) upstream artifact — and ABORT when an archive
 * fails.
 *
 * COR-114e4941: the returned ArchiveOutcome used to be discarded here, alone
 * among the four archive call sites. `originalFree: false` means the move
 * failed and the stale file is STILL at its canonical path, where
 * `contractArtifactExists` (a bare `existsSync`) reports it as present — so the
 * producing phase was never re-emitted and every downstream derivation (the
 * obligation ledger, the phase cut, the DAG) was built on content the staleness
 * DAG had already declared invalid. Refusing here is the only ordering that
 * keeps that impossible: the frontier is not resolved until every stale
 * artifact is genuinely out of the way.
 */
const staleArchiveGate: ContractGate = async (ctx) => {
  const staleness = await detectStaleArtifacts(ctx.artifactsDir);
  for (const name of staleness.stale) {
    const archived = await archiveContractArtifact(
      ctx.artifactsDir,
      name,
      "stale",
      ctx.options.renameFn,
    );
    if (archived.originalFree) continue;
    const phase = ARTIFACT_TO_PHASE[name];
    if (phase) {
      return {
        via: "phase",
        phase,
        extraSection: `## A Stale \`${name}\` Could Not Be Archived

\`${name}\` is stale (an upstream it depends on changed) but the tool could not move it into the contract history directory, so the stale content is still at its canonical path. The pipeline will not derive anything downstream of it.

Rewrite \`${name}\` from its current upstreams.
${rejectionRewriteInstruction(archived)}`,
      };
    }
    return {
      via: "blocked",
      prompt: `# A Stale Derived Artifact Could Not Be Archived

\`${name}\` is stale but could not be moved into the contract history directory, and it is tool-derived — no authoring phase owns it, so it cannot simply be re-emitted.

Remove or unlock \`${contractArtifactFilePath(ctx.artifactsDir, name)}\` (and its \`.input.json\` sibling if present), then re-run next-step so the pipeline re-derives it from the current upstreams. Proceeding on the stale copy would build the obligation ledger, phase cut and implementation DAG on content the staleness DAG has already declared invalid.`,
      stopCondition:
        "Stop — the contract pipeline is blocked on a stale artifact that could not be archived.",
    };
  }

  // OBL-m-friction-inv-5 (post_repair_rederive): when a judge needs_repair →
  // regenerate-target landed, the re-ingested target makes its downstream
  // artifacts stale and they are archived above — the REAL remediate
  // post-repair re-derive site. Route this backend-observed step-boundary fact
  // through the single CE-005 chokepoint. Discriminator = repair target
  // artifact id + repair iteration count, so re-recording the same re-derive is
  // a collision-free no-op (CE-006).
  if (staleness.stale.length > 0) {
    const repairState = await readRepairState(ctx.artifactsDir);
    const lastRepair = repairState.repairs[repairState.repairs.length - 1];
    if (lastRepair) {
      const iteration = repairState.repairs.length;
      await captureStepBoundaryFriction(
        ctx.artifactsDir,
        ctx.runId,
        {
          eventType: "post_repair_rederive",
          discriminator: `${lastRepair.target}:${iteration}`,
          note:
            `Post-repair re-derive: repair iteration ${iteration} of "${lastRepair.target}" ` +
            `made ${staleness.stale.length} downstream artifact(s) stale; they were archived so ` +
            `the staleness DAG re-derives the back half.`,
          category: "trap",
        },
        "remediate-code",
      );
    }
  }

  // Ingestion + archiving are done: payloads read from here on are this
  // invocation's own view. Nothing downstream may read them before this point.
  ctx.artifactsSettled = true;
  return null;
};

/**
 * Resolve the phase frontier — the one gate that never emits. It sits HERE, and
 * not at the top, because archiving a stale artifact re-opens its producing
 * phase: computing the frontier before the archive pass would read a phase as
 * satisfied by a file the pipeline has just declared invalid.
 */
const phaseFrontierGate: ContractGate = (ctx) => {
  ctx.nextPhase = nextMissingContractPhase(ctx.artifactsDir);
  return null;
};

/**
 * Goal-ID consistency (ARC-86b18f1b): every persisted artifact that carries a
 * goal_id must agree on the same value. A mismatch means two runs were
 * interleaved; re-emit the earliest mismatched phase so the worker can correct
 * it. Deliberately phase-independent.
 */
const goalIdConsistencyGate: ContractGate = async (ctx) => {
  const goalIdArtifacts: Record<string, unknown> = {};
  for (const name of CP_ARTIFACT_NAMES) {
    const envelope = await readContractArtifact(ctx.artifactsDir, name);
    if (envelope) goalIdArtifacts[name] = envelopePayload(envelope);
  }
  const goalIdErrors = validateGoalIdConsistency(goalIdArtifacts).filter(
    (issue) => issue.severity === "error",
  );
  if (goalIdErrors.length === 0) return null;
  // issue.path is "<artifact_name>.goal_id"; extract the artifact name.
  const firstPath = goalIdErrors[0]?.path ?? "";
  const mismatchedArtifact = firstPath.replace(
    /\.goal_id$/,
    "",
  ) as ContractPipelineArtifactName;
  const archived = await archiveContractArtifact(
    ctx.artifactsDir,
    mismatchedArtifact,
    "invalid",
    ctx.options.renameFn,
  );
  return {
    via: "phase",
    phase: ARTIFACT_TO_PHASE[mismatchedArtifact] ?? "goal_normalization",
    extraSection: `## Goal-ID Consistency Error

Every contract-pipeline artifact must share the same goal_id. The following mismatch was detected:

${goalIdErrors.map((issue) => `- [${issue.path}] ${issue.message}`).join("\n")}

Rewrite the output so its goal_id matches the goal_id established in goal_spec.json.
${rejectionRewriteInstruction(archived)}`,
  };
};

/**
 * Finalized-module-SET gate (INV-CO-13). `deriveFinalizedModuleContracts` maps
 * the drafts 1:1, so the deterministic path can never violate this — but it is
 * not the only writer: a judge or critique repair re-emits contract_finalization
 * as an LLM step, ingested under a SHAPE-ONLY validator that structurally cannot
 * see the drafts. A rewrite that merges modules under an invented name and drops
 * another would otherwise be accepted, and the phase cut, the derived obligation
 * ids and the DAG write-scope join would all then be built on a module set that
 * has already lost a module.
 *
 * DELIBERATELY PHASE-INDEPENDENT, like the goal-ID gate: rewriting
 * finalized_module_contracts stales its declared dependent
 * conceptual_design_critique, which the staleness gate archives BEFORE the
 * frontier is resolved — so the phase right after a corrupting rewrite is
 * `critique`, not `critic`. Gating at the critic boundary would not fire until
 * critique, obligation_ledger, cyclic_seam_resolution, test_validator_plan and
 * assessment had all been re-spent on the collapsed set.
 *
 * The gate is NOT in `PRE_CRITIC_REQUIRED_GATES` / `PROMOTION_REQUIRED_GATES`
 * because at this phase-independent position a not-evaluated outcome genuinely
 * means "the drafted or finalized contracts do not exist yet" — the branch on
 * `evaluated` is taken, and its declared meaning here is "not yet applicable".
 */
const finalizedModuleSetGate: ContractGate = async (ctx) => {
  const outcomes = await evaluateContractPipelineCrossGateOutcomes(
    await readCrossGatePayloads(ctx),
  );
  const outcome = gateOutcomeOf(outcomes, "finalized_module_set_preserved");
  if (!outcome?.evaluated) return null;
  const moduleSetErrors = outcome.issues.filter((issue) => issue.severity === "error");
  if (moduleSetErrors.length === 0) return null;
  const archived = await archiveContractArtifact(
    ctx.artifactsDir,
    "finalized_module_contracts",
    "invalid",
    ctx.options.renameFn,
  );
  return {
    via: "phase",
    phase: "contract_finalization",
    extraSection: `## Finalized Module Set Does Not Match the Drafted Contracts

Finalization carries every drafted module contract through — it may incorporate seam-reconciliation decisions into a module's interface, but it may never drop, merge, rename, or invent a module. The following mismatches were detected:

${moduleSetErrors.map((issue) => `- [${issue.path}] ${issue.message}`).join("\n")}
${rejectionRewriteInstruction(archived)}`,
  };
};

/**
 * Path-A overlap topology gate. A required audit seam is not advisory:
 * decomposition must name exactly one seam-preparation module and keep distinct
 * implementation modules for the participating work blocks. Checked before
 * module contracts fan out, so the seam is shaped once and downstream authors
 * can work in parallel against it.
 */
const workBlockSeamGate: ContractGate = async (ctx) => {
  if (!contractArtifactExists(ctx.artifactsDir, "module_decomposition")) return null;
  const seed = await readOptionalJsonFile<unknown>(pathASeedFilePath(ctx.artifactsDir));
  if (!seed) return null;
  const decomposition = envelopePayload(
    await readContractArtifact(ctx.artifactsDir, "module_decomposition"),
  );
  const seamIssues = validateWorkBlockSeamPreparation(seed, decomposition).filter(
    (issue) => issue.severity === "error",
  );
  if (seamIssues.length === 0) return null;
  const archived = await archiveContractArtifact(
    ctx.artifactsDir,
    "module_decomposition",
    "invalid",
    ctx.options.renameFn,
  );
  return {
    via: "phase",
    phase: "decomposition",
    extraSection: `## Audit Work-Block Seam Errors

The module decomposition dropped or blurred required audit work-block seams. Fix every issue below. Keep implementation work blocks distinct, add exactly one seam-preparation module per required seam (one module may prepare several seams), and list the corresponding source_work_block_ids / prepares_seam_ids:

${seamIssues.map((issue) => `- [${issue.path}] ${issue.message}`).join("\n")}
${rejectionRewriteInstruction(archived)}`,
  };
};

/**
 * Conceptual-design-critique gate (A1). Once the critique exists, a blocking
 * concern routes a design repair BEFORE any downstream artifact is derived. The
 * signal is mechanical (any blocking item), so the author's verdict label can't
 * wave a blocking concern through. Convergence-terminated: repairing the
 * finalized contracts re-stales + re-emits the critique, a clean re-critique
 * proceeds, a stalled loop escalates to the user.
 */
const conceptualCritiqueGate: ContractGate = async (ctx) => {
  if (!contractArtifactExists(ctx.artifactsDir, "conceptual_design_critique")) return null;
  const gate = await evaluateCritiqueGate(ctx.artifactsDir);
  if (gate.kind === "repair") {
    const repairState = await readRepairState(ctx.artifactsDir);
    const critiqueRepairs = repairState.critique_repairs ?? [];
    if (!critiqueRepairs.some((repair) => repair.critique_hash === gate.critiqueHash)) {
      critiqueRepairs.push({
        critique_hash: gate.critiqueHash,
        at: new Date().toISOString(),
        blocking_ids: gate.blockingIds,
      });
      repairState.critique_repairs = critiqueRepairs;
      await writeRepairState(ctx.artifactsDir, repairState);
    }
    const rendered = renderContractRepairPrompt({
      target: "finalized_module_contracts",
      instruction:
        "Revise the design to resolve every BLOCKING concern in the conceptual design critique " +
        `(${gate.blockingIds.join(", ")}). Read conceptual_design_critique.json for each concern's ` +
        "description, then rewrite the finalized module contracts so the blocking concerns no longer apply.",
      artifactPaths: ctx.artifactPaths,
      repoRoot: ctx.root,
    });
    return {
      via: "step",
      prompt: rendered.prompt,
      outputPath: rendered.outputPath,
      stopCondition:
        "Stop after rewriting finalized_module_contracts to resolve the blocking critique concerns and running next-step.",
    };
  }
  if (gate.kind === "escalate") {
    await captureStepBoundaryFriction(
      ctx.artifactsDir,
      ctx.runId,
      {
        eventType: "repair_round",
        discriminator: `critique_nonconvergence:${gate.reason}`,
        note: `Conceptual-design critique↔repair loop escalated (${gate.reason}): ${gate.note}`,
        category: "trap",
      },
      "remediate-code",
    );
    return {
      via: "blocked",
      prompt: `# Conceptual-Design Critique Did Not Converge

${gate.note}

## Outstanding blocking concerns

${gate.blocking.map((id) => `- ${id}`).join("\n")}

Read conceptual_design_critique.json, decide with the user how to resolve each blocking concern (revise the contract design and re-run, or downgrade it to advisory), then re-run next-step.`,
      stopCondition:
        "Stop — the contract pipeline is blocked on a non-converging conceptual-design critique pending a user decision.",
    };
  }
  return null;
};

/**
 * Deterministic obligation-ledger derivation (S1). The ledger is a pure function
 * of the finalized module contracts (every invariant/failure mode/module → an
 * obligation), so the tool generates it rather than an LLM phase: the structure
 * can never be malformed, no judgment is spent on a mechanical restructuring,
 * and a weak model is never asked to emit it from scratch.
 */
const obligationLedgerDerivationGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase !== "obligation_ledger") return null;
  const finalizedPayload = envelopePayload(
    await readContractArtifact(ctx.artifactsDir, "finalized_module_contracts"),
  );
  await writeDerivedContractArtifact(
    ctx.artifactsDir,
    "obligation_ledger",
    deriveObligationLedger(finalizedPayload),
  );
  return { via: "rederive" };
};

/**
 * Degenerate seam_reconciliation collapse. A single-module decomposition has NO
 * inter-module seams, so seam_reconciliation is a structural no-op: write an
 * empty seam report deterministically (no host round-trip). The empty report
 * makes validateReconciliationDerivation pass vacuously. A multi-module
 * decomposition falls through to the LLM seam_reconciliation step (which
 * mismatches exist is a judgment call).
 */
const degenerateSeamReconciliationGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase !== "seam_reconciliation") return null;
  const modules = await readDecomposedModules(ctx.artifactsDir);
  if (modules.length > 1) return null;
  const drafted = envelopePayload(
    await readContractArtifact(ctx.artifactsDir, "module_contracts"),
  );
  const goalId =
    isRecord(drafted) && typeof drafted.goal_id === "string" ? drafted.goal_id : "";
  await writeDerivedContractArtifact(ctx.artifactsDir, "seam_reconciliation_report", {
    contract_version:
      "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
    goal_id: goalId,
    mismatches: [],
    created_at: new Date().toISOString(),
  });
  return { via: "rederive" };
};

/** Render the cycle section for the LLM finalization step: every declared-graph
 *  cycle, its members, and the exact artifact tokens forming each edge. */
function renderTokenCycleSection(cycles: ContractTokenCycle[]): string {
  const parts = cycles.map((cycle, i) => {
    const edges = cycle.edges
      .map(
        (e) =>
          `- \`${e.consumer}\` depends on \`${e.producer}\` via \`artifact:${e.artifact}\` ` +
          `(${e.consumer} consumes it; ${e.producer} produces it)`,
      )
      .join("\n");
    return `### Cycle ${i + 1}: [${cycle.members.join(", ")}]\n\n${edges}`;
  });
  return `## Cyclic Artifact-Token Dependencies — Resolve These In Your Output

The drafted contracts declare a CYCLIC artifact-token flow. Implementation ordering derives from
producer/consumer \`artifact:<name>\` tokens ALONE, so the declared flow must be acyclic — a cycle
cannot be phased, and the finalized contracts are REJECTED at validation while one remains.

${parts.join("\n\n")}

Rewrite the finalized \`inputs\`/\`outputs\` so one direction owns each flow: move an artifact token
to the module that genuinely produces it, split a shared primitive into an earlier module's output,
or drop a token that does not describe a real data handoff. Keep the module SET unchanged — do not
add, drop, rename, or merge modules.`;
}

/**
 * Deterministic contract_finalization (all module counts). Finalization is a
 * mechanical merge, not fresh authoring: carry each drafted module contract's
 * interface fields verbatim (dropping neighbor_needs — ordering derives from
 * the artifact-token graph alone, open-bugs.md:106) and attach
 * the agreed_interface of every seam that touches the module as a
 * seam_adjustment. The judgment already happened at seam_reconciliation.
 * Attaching each agreed interface verbatim guarantees the INV-CO-12
 * reconciliation-derivation gate passes. A downstream gate that still finds the
 * merge inadequate re-emits contract_finalization as an LLM step — the only path
 * that still needs judgment. A CYCLIC declared token graph takes that LLM path
 * up front: the mechanical merge would carry the cycle verbatim into an
 * artifact validation refuses, so the gate emits the finalization step with the
 * cycle named instead of deriving.
 */
const contractFinalizationDerivationGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase !== "contract_finalization") return null;
  const drafted = envelopePayload(
    await readContractArtifact(ctx.artifactsDir, "module_contracts"),
  );
  const cycles = detectContractTokenCycles(drafted);
  if (cycles.length > 0) {
    return {
      via: "phase",
      phase: "contract_finalization",
      extraSection: renderTokenCycleSection(cycles),
    };
  }
  const seamReport = envelopePayload(
    await readContractArtifact(ctx.artifactsDir, "seam_reconciliation_report"),
  );
  await writeDerivedContractArtifact(
    ctx.artifactsDir,
    "finalized_module_contracts",
    deriveFinalizedModuleContracts(drafted, seamReport),
  );
  return { via: "rederive" };
};

/**
 * Judge gate: implementation planning is reachable only through an approved
 * verdict (the fixpoint) or a convergent targeted repair. A stalled /
 * non-converging repair loop escalates to the user (blocked) instead of silently
 * proceeding with residual risk.
 */
const judgeRepairGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase !== "implementation_planning") return null;
  const gate = await evaluateJudgeGate(ctx.artifactsDir);
  if (gate.kind === "repair") {
    const repairTarget = gate.directive.target;
    const repairState = await readRepairState(ctx.artifactsDir);
    if (!repairState.repairs.some((repair) => repair.judge_hash === gate.judgeHash)) {
      repairState.repairs.push({
        judge_hash: gate.judgeHash,
        target: repairTarget,
        at: new Date().toISOString(),
        accepted_ce_ids: gate.acceptedCeIds,
        addressed_ce_fingerprints: gate.addressedCeFingerprints,
      });
      await writeRepairState(ctx.artifactsDir, repairState);
    }
    const rendered = renderContractRepairPrompt({
      target: repairTarget,
      instruction: gate.directive.instruction,
      artifactPaths: ctx.artifactPaths,
      repoRoot: ctx.root,
    });
    return {
      via: "step",
      prompt: rendered.prompt,
      outputPath: rendered.outputPath,
      stopCondition: `Stop after rewriting "${repairTarget}" per the judge repair directive and running next-step.`,
    };
  }
  if (gate.kind === "escalate") {
    // Non-convergence (stall or runaway backstop): surface it to the user loudly
    // rather than promoting a plan over an un-converged contract. The
    // outstanding accepted counterexamples are named so the user can resolve
    // them (revise the contract design or accept them as known limitations).
    await captureStepBoundaryFriction(
      ctx.artifactsDir,
      ctx.runId,
      {
        eventType: "repair_round",
        discriminator: `judge_nonconvergence:${gate.reason}`,
        note: `Judge↔repair loop escalated (${gate.reason}): ${gate.note}`,
        category: "trap",
      },
      "remediate-code",
    );
    const waiversPath = counterexampleWaiversPath(ctx.artifactsDir);
    const waiverIssuesSection =
      gate.waiverIssues && gate.waiverIssues.length > 0
        ? `\n\n## Waiver file refused — fix these first\n\n${gate.waiverIssues
            .map((issue) => `- ${issue}`)
            .join("\n")}`
        : "";
    const heading =
      gate.reason === "invalid_waivers"
        ? "# The Counterexample Waiver File Was Refused"
        : "# Judge↔Repair Loop Did Not Converge";
    return {
      via: "blocked",
      prompt: `${heading}

${gate.note}${waiverIssuesSection}

## Outstanding accepted counterexamples (unwaived)

${
  gate.outstanding.length > 0
    ? gate.outstanding.map((id) => `- ${id}`).join("\n")
    : "_(none newly accepted this round)_"
}

## Record an owner waiver (the recorded resolution verb)

To accept an outstanding counterexample as a KNOWN LIMITATION of this run, write the operator's decision to:

\`${waiversPath}\`

\`\`\`json
{
  "waivers": [
    { "ce_id": "<id from the list above>", "rationale": "<why this is acceptable>", "waived_by": "<who decided>" }
  ]
}
\`\`\`

The next next-step validates the file, records each waiver in repair-state.json (attributable, content-fingerprint-keyed), consumes the file, and proceeds once every outstanding counterexample is repaired or waived. Record a waiver ONLY for a decision the operator actually made — the record names its decider.

Read the judge_report and counterexample artifacts, decide with the user how to resolve each outstanding counterexample (revise the contract design and re-run, or record a waiver as above), then re-run next-step.`,
      stopCondition:
        "Stop — the contract pipeline is blocked on a non-converging judge↔repair loop pending a user decision.",
    };
  }
  return null;
};

/** Bounded re-emit of implementation_planning, then blocked — the shared shape
 *  of the four promotion rejections (integrity, traceability, obligation gates,
 *  citation grounding). Single-sourced so the four cannot drift into four
 *  different recovery contracts. */
async function dagRegenerationPlan(
  ctx: ContractGateContext,
  params: { heading: string; blockedBody: string; reEmitBody: string; violations: string[] },
): Promise<ContractStepPlan> {
  const repairState = await readRepairState(ctx.artifactsDir);
  if (repairState.dag_regenerations.length >= MAX_DAG_REGENERATION_ATTEMPTS) {
    return {
      via: "blocked",
      prompt: `# ${params.heading} ${repairState.dag_regenerations.length + 1} Times

${params.blockedBody}

${params.violations.map((violation) => `- ${violation}`).join("\n")}
`,
      stopCondition: `Stop after reporting the failure to the user.`,
    };
  }
  repairState.dag_regenerations.push({
    violations: params.violations,
    at: new Date().toISOString(),
  });
  await writeRepairState(ctx.artifactsDir, repairState);
  const archived = await archiveContractArtifact(
    ctx.artifactsDir,
    "implementation_dag",
    "invalid",
    ctx.options.renameFn,
  );
  return {
    via: "phase",
    phase: "implementation_planning",
    extraSection: `${params.reEmitBody}

${params.violations.map((violation) => `- ${violation}`).join("\n")}
${rejectionRewriteInstruction(archived)}`,
  };
}

/**
 * All phases exist: enforce referential integrity, traceability, the
 * fail-closed contract-obligation gates, and the Path-A canonical-block join,
 * then convert the implementation_dag into an extracted plan and ground its citations.
 */
const implementationPlanPromotionGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase) return null;

  // Path-A canonical-block membership (inv-2), FIRST in this walk so a late
  // source_finding_ids violation fails before any other gate executes instead
  // of throwing out of the promoter below and wedging every subsequent
  // next-step (COR-114e4941). Same bounded re-emit as every other promotion
  // rejection; no gate has executed past it.
  const pathARefusals = await collectPathARefusals(ctx.artifactsDir);
  if (pathARefusals.length > 0) {
    return await dagRegenerationPlan(ctx, {
      heading: "Path-A Canonical Block Join Failed",
      blockedBody:
        "The implementation_dag repeatedly declares source_finding_ids that cannot be joined to a canonical audit work block:",
      reEmitBody: `## Path-A Canonical Block Errors From the Previous Attempt

Each node's source_finding_ids must name exactly one canonical audit work block, and together the nodes must cover every block exactly once. Fix every entry below:`,
      violations: pathARefusals,
    });
  }

  // DAG referential integrity + bidirectional coverage (ARC-86b18f1b-2), run
  // before the traceability check so specific referential violations are
  // reported first (traceability is a superset check).
  const outcomes = await evaluateContractPipelineCrossGateOutcomes(
    await readCrossGatePayloads(ctx),
  );
  const integrity = gateOutcomeOf(outcomes, "implementation_dag_integrity");
  if (!integrity?.evaluated) {
    return await dagRegenerationPlan(ctx, {
      heading: "Implementation DAG Could Not Be Checked",
      blockedBody:
        "The implementation_dag integrity gate could not run, so its empty issue list proves nothing:",
      reEmitBody: `## The Implementation DAG Could Not Be Checked

The referential-integrity gate could not run against the previous output, so it was never shown to be sound. Rewrite a complete implementation_dag:`,
      violations: [integrity?.reason ?? "no outcome record was produced for the gate"],
    });
  }
  const integrityErrors = integrity.issues.filter((issue) => issue.severity === "error");
  if (integrityErrors.length > 0) {
    return await dagRegenerationPlan(ctx, {
      heading: "Implementation DAG Failed Referential Integrity",
      blockedBody:
        "The implementation_dag repeatedly contains referential integrity or coverage violations:",
      reEmitBody: `## Referential Integrity Errors From the Previous Attempt

The previous implementation_dag was rejected and archived due to referential integrity violations. Fix every issue below:`,
      violations: integrityErrors.map((issue) => `[${issue.path}] ${issue.message}`),
    });
  }

  const traceability = await validateImplementationDagTraceability(ctx.artifactsDir);
  if (!traceability.ok) {
    return await dagRegenerationPlan(ctx, {
      heading: "Implementation DAG Failed Traceability",
      blockedBody:
        "The implementation_dag repeatedly contains nodes that trace to no obligation and no judge-accepted counterexample:",
      reEmitBody: `## Traceability Errors From the Previous Attempt

The previous implementation_dag was rejected and archived. Every node must trace to at least one obligation from the obligation ledger or one judge-accepted counterexample:`,
      violations: traceability.violations,
    });
  }

  // Contract-obligations promotion gates: fail-closed cross-artifact checks that
  // must pass before a plan is promoted. These are the invariants that keep the
  // workflow correct regardless of host strength, so they are enforced here,
  // never left to host discretion.
  const obligationGate = await evaluateContractObligationsPromotionGate(
    ctx.artifactsDir,
    ctx.root,
    await readCrossGatePayloads(ctx),
  );
  if (!obligationGate.ok) {
    return await dagRegenerationPlan(ctx, {
      heading: "Contract-Obligation Gates Failed",
      blockedBody:
        "The contract-obligation promotion gates repeatedly failed and the plan cannot be promoted:",
      reEmitBody: `## Contract-Obligation Gate Errors From the Previous Attempt

The previous implementation_dag (and/or upstream contract artifacts) failed the fail-closed contract-obligation gates. Fix every issue below before the plan can be promoted:`,
      violations: obligationGate.violations,
    });
  }

  // Write-scope + command SHAPE, before anything is promoted. These refusals
  // used to throw out of the promoter — an unclassified stack that wedged every
  // subsequent next-step, reachable from an LLM form as ordinary as a
  // leading-slash "repo-relative" path. They take the same bounded re-emit as
  // every other promotion rejection now.
  const scopeRefusals = await collectDagWriteScopeRefusals(ctx.artifactsDir, ctx.root);
  if (scopeRefusals.length > 0) {
    return await dagRegenerationPlan(ctx, {
      heading: "Block Write Scope Failed",
      blockedBody:
        "The implementation_dag repeatedly declares a write scope or targeted command the plan cannot carry:",
      reEmitBody: `## Write-Scope and Command Errors From the Previous Attempt

Each node's declared write scope becomes the block \`touched_files\` a host binds an implementer to and re-checks against the landed diff, and each targeted command is executed verbatim through a shell. Fix every entry below:`,
      violations: scopeRefusals,
    });
  }

  await promoteImplementationDagToExtractedPlan(ctx.artifactsDir, ctx.root);

  // M-B3 source-grounded citation gate (promotion backstop): ground every
  // promoted extracted-plan finding's citations against the working tree.
  const citationGate = await evaluatePromotedPlanCitationGrounding(
    ctx.artifactsDir,
    ctx.root,
  );
  if (citationGate) {
    // The plan was promoted to extracted-plan.json BEFORE this gate ran, so the
    // ungrounded marker is now on disk. Remove it before any return — otherwise
    // a subsequent next-step reads the promoted plan and hands it straight to
    // handlePendingExtractedPlan, bypassing the re-emit and completing the
    // pipeline on hallucinated citations.
    await rm(ctx.paths.extractedPlan, { force: true });
    // The grounding-driven re-emit is a backend-observed step-boundary fact:
    // route it through the single CE-005 chokepoint as phase_reemit.
    await captureStepBoundaryFriction(
      ctx.artifactsDir,
      ctx.runId,
      {
        eventType: "phase_reemit",
        discriminator: "implementation_planning:citation_grounding:promotion",
        note:
          "implementation_planning re-emitted: a promoted plan finding cited a " +
          "component that does not exist in the working tree (M-B3 citation grounding).",
        category: "trap",
      },
      "remediate-code",
    );
    return await dagRegenerationPlan(ctx, {
      heading: "Citation Grounding Failed",
      blockedBody:
        "The promoted plan repeatedly cites components that do not exist in the working tree:",
      reEmitBody: `## Source-Grounded Citation Gate Errors From the Previous Attempt

The previous implementation_dag produced findings that cite components not present in the working tree. Every cited path or symbol must point at something real:`,
      violations: citationGate.violations,
    });
  }

  // Normalized block write scope, tracked-tree half. Runs AFTER the
  // citation gate because the two overlap but neither contains the other: a
  // finding grounds on any real path OR symbol, so a node with plausible prose
  // can ground while the write scope a host would bind a worker to is still
  // fabricated. Same bounded recovery, same plan removal.
  const writeScopeGate = await evaluatePromotedPlanWriteScope(ctx.artifactsDir, ctx.root);
  if (writeScopeGate) {
    await rm(ctx.paths.extractedPlan, { force: true });
    return await dagRegenerationPlan(ctx, {
      heading: "Block Write Scope Failed",
      blockedBody:
        "The promoted plan repeatedly declares a block write scope that does not exist in the working tree:",
      reEmitBody: `## Block Write-Scope Errors From the Previous Attempt

Each node's declared write scope becomes the block \`touched_files\` a host binds an implementer to and re-checks against the landed diff. The following entries name a directory that does not exist:`,
      violations: writeScopeGate.violations,
    });
  }

  return { via: "pipeline_complete" };
};

/** Render the detected cycles for a prompt. */
function renderCycleDescriptions(cycles: readonly { members: string[] }[]): string {
  return cycles
    .map((cycle, index) => `Cycle ${index + 1}: [${cycle.members.join(", ")}]`)
    .join("\n");
}

/** Build the seam-obligation graph from the obligation ledger AS IT STANDS NOW. */
async function readSeamObligationGraph(
  artifactsDir: string,
): Promise<{ nodes: SeamObligationNode[]; goalId: string; ledgerHash: string }> {
  const envelope = await readContractArtifact(artifactsDir, "obligation_ledger");
  const ledger = envelopePayload(envelope) as ObligationLedger | undefined;
  const obligationIds = new Set((ledger?.obligations ?? []).map((o) => o.id));
  return {
    nodes: (ledger?.obligations ?? []).map((obligation) => ({
      id: obligation.id,
      needs: (obligation.depends_on ?? []).filter((dep) => obligationIds.has(dep)),
    })),
    goalId: ledger?.goal_id ?? "",
    ledgerHash: envelope?.content_hash ?? "unknown",
  };
}

/**
 * Cyclic-seam resolution gate: runs after obligation_ledger is present and
 * before assessment. Detects circular interface-definition obligations, then
 * routes to an LLM resolution step when cycles are found. Cap:
 * MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS; on exhaustion, route to a user-decision
 * step (then blocked if still unresolved).
 */
const cyclicSeamResolutionGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase !== "cyclic_seam_resolution") return null;
  const graph = await readSeamObligationGraph(ctx.artifactsDir);
  const detectedCycles = detectCyclicSeamObligations(graph.nodes);

  if (detectedCycles.length === 0) {
    await writeDerivedContractArtifact(ctx.artifactsDir, "cyclic_seam_resolution", {
      contract_version:
        "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
      goal_id: graph.goalId,
      cycles: [],
      status: "no_cycles",
      created_at: new Date().toISOString(),
    });
    return { via: "rederive" };
  }

  const repairState = await readCyclicSeamRepairState(ctx.artifactsDir);
  const attemptsForLedger = repairState.attempts.filter(
    (attempt) => attempt.ledger_hash === graph.ledgerHash,
  );

  // Guard: the artifact exists and is already marked resolved/no_cycles. This
  // branch should not normally be reached (the artifact exists, so the frontier
  // skips it), but re-deriving is the safe answer.
  const existingResolution = envelopePayload(
    await readContractArtifact(ctx.artifactsDir, "cyclic_seam_resolution"),
  ) as Record<string, unknown> | undefined;
  if (
    existingResolution &&
    (existingResolution.status === "resolved" ||
      existingResolution.status === "no_cycles")
  ) {
    return { via: "rederive" };
  }

  const cycleDescriptions = renderCycleDescriptions(detectedCycles);

  if (attemptsForLedger.length >= MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS) {
    if (!repairState.user_decision_emitted) {
      repairState.user_decision_emitted = true;
      await writeCyclicSeamRepairState(ctx.artifactsDir, repairState);
      return {
        via: "blocked",
        prompt: `# Cyclic Seam Resolution — User Decision Required

The automatic cycle-break resolution reached its cap (${MAX_CYCLIC_SEAM_RESOLUTION_ATTEMPTS} attempt(s)) without producing a valid cycle-free obligation graph. The following obligation cycles remain unresolved:

${cycleDescriptions}

**Choose one of the two sanctioned break strategies per cycle:**

1. **Mediator module** — Introduce a third obligation/module that both sides depend on. The mediator owns the shared primitive; neither original module defines an interface for the other.
2. **Single authority** — Designate one obligation/module as the definitive owner of the co-defined interface. The other becomes a consumer only. This is recorded as a named, scoped exception.

To proceed, manually rewrite \`${contractInputFilePath(ctx.artifactsDir, "obligation_ledger")}\` so that no circular \`depends_on\` references exist, then delete \`${contractInputFilePath(ctx.artifactsDir, "cyclic_seam_resolution")}\` and \`${cyclicSeamRepairStatePath(ctx.artifactsDir)}\` and re-run next-step.

If you choose to stop instead, this run will remain blocked.
`,
        stopCondition:
          "Stop after presenting the user-decision prompt. Do not attempt further resolution.",
      };
    }
    // The user decision was emitted and cycles are still present — blocked.
    return {
      via: "blocked",
      prompt: `# Cyclic Seam Resolution — Blocked

Cycles in the obligation graph remain unresolved after the automatic cap and a user-decision step. The run cannot proceed without manual intervention.

${cycleDescriptions}

Manually rewrite the obligation_ledger to remove circular depends_on references, delete the cyclic_seam_resolution artifact and cyclic-seam-repair-state.json, and re-run next-step.
`,
      stopCondition: "Stop — the run is blocked on cyclic seam resolution.",
    };
  }

  // Emit the LLM cyclic-seam-resolution step.
  const outputPath = contractInputFilePath(ctx.artifactsDir, "cyclic_seam_resolution");
  const ledgerInputPath = contractInputFilePath(ctx.artifactsDir, "obligation_ledger");
  const priorRejection = [...repairState.attempts]
    .reverse()
    .find(
      (attempt) =>
        attempt.ledger_hash === graph.ledgerHash && attempt.recheck_reason,
    )?.recheck_reason;
  const rejectionSection = priorRejection
    ? `\n## Why the Previous Attempt Was Rejected\n\n${priorRejection}\n`
    : "";

  repairState.attempts.push({
    ledger_hash: graph.ledgerHash,
    at: new Date().toISOString(),
    recheck_passed: false,
  });
  await writeCyclicSeamRepairState(ctx.artifactsDir, repairState);

  return {
    via: "step",
    prompt: `# Cyclic Seam Resolution

Circular interface-definition obligations were detected in the obligation ledger. You must resolve every cycle using one of the two sanctioned strategies below, then REWRITE THE LEDGER and write the resolution record.

## Detected Cycles

${cycleDescriptions}
${rejectionSection}
## Sanctioned Break Strategies

For each cycle, choose one:

1. **Mediator module** — Introduce a third obligation/module that both sides depend on. The mediator owns the shared primitive; neither original module defines an interface for the other. The mediator must be an obligation that EXISTS in the ledger and is NOT a member of the cycle.
2. **Single authority** — Designate one of the cycle's own obligations as the definitive owner of the interface. The others become consumers only. Record this as an explicit, scoped exception.

## Required Inputs

- \`${ledgerInputPath}\` (obligation_ledger)

## Your Task

Two files, both required — the record alone is not a break:

1. **Rewrite \`${ledgerInputPath}\`** so the cycle's \`depends_on\` edges actually route through the obligation you designate. The re-check re-runs cycle detection over the ledger you leave behind; a resolution record whose ledger still carries the cycle is rejected, not accepted.
2. **Write the resolution record** to exactly \`${outputPath}\`, naming for each cycle the obligation id you designated:

\`\`\`json
{
  "contract_version": "remediate-code-contract-pipeline/cyclic-seam-resolution/v1alpha1",
  "goal_id": "<from obligation_ledger>",
  "cycles": [
    {
      "members": ["<obligation-id>", "..."],
      "break_strategy": "mediator | single_authority",
      "designated_obligation_id": "<the mediating obligation, or the single authority — must exist in the rewritten ledger>",
      "resolution_description": "<what was changed and why>",
      "exception_registration": "<if single_authority: the named scoped exception; otherwise null>"
    }
  ],
  "status": "resolved"
}
\`\`\`

If after analysis you find the cycles are already broken (e.g. upon re-reading the ledger the depends_on edges do not actually form a cycle), set status to "no_cycles" and cycles to [].

**Stop after writing the two files.** Do not edit source files. Do not advance to the next pipeline step.
`,
    outputPath,
    stopCondition:
      "Stop after rewriting the obligation_ledger, writing the cyclic_seam_resolution output file, and running next-step.",
  };
};

/**
 * Cyclic-seam RE-CHECK. The worker has written a `resolved` record; verify the
 * break it actually authored against the obligation graph as it actually
 * stands, and archive + loop back when it does not hold.
 *
 * TST-61cff370 / TST-114e4941: this check used to be vacuous. It fabricated a
 * synthetic node per cycle — `{ id: "_mediator_A_B", needs: [] }` or
 * `{ id: "_authority_A_B", needs: [] }` — and asked whether redirecting the
 * cycle's edges at that edge-free sink would be acyclic, against the SAME
 * unmodified ledger. For any single detected cycle the answer is yes by
 * construction, so the re-check could never reject: a worker could claim
 * `status: "resolved"` while changing nothing, and the pipeline advanced. It
 * now reads the designated obligation off the record and validates it against
 * the live graph — see `validateAuthoredCycleBreak`.
 */
const cyclicSeamRecheckGate: ContractGate = async (ctx) => {
  const resolutionEnvelope = await readContractArtifact(
    ctx.artifactsDir,
    "cyclic_seam_resolution",
  );
  if (!resolutionEnvelope) return null;
  const resolution = envelopePayload(resolutionEnvelope) as
    | Record<string, unknown>
    | undefined;
  if (
    !resolution ||
    resolution.status !== "resolved" ||
    !Array.isArray(resolution.cycles) ||
    resolution.cycles.length === 0
  ) {
    return null;
  }

  const graph = await readSeamObligationGraph(ctx.artifactsDir);
  let rejection: string | undefined;
  for (const cycleRecord of resolution.cycles as Array<Record<string, unknown>>) {
    if (!Array.isArray(cycleRecord.members)) continue;
    const members = (cycleRecord.members as unknown[]).filter(
      (member): member is string => typeof member === "string",
    );
    const strategy = cycleRecord.break_strategy;
    if (strategy !== "mediator" && strategy !== "single_authority") {
      rejection =
        `Cycle [${members.join(", ")}] declares break_strategy ` +
        `${JSON.stringify(strategy ?? null)}, which is neither "mediator" nor "single_authority".`;
      break;
    }
    const authored: AuthoredCycleBreak = {
      strategy,
      designatedId:
        typeof cycleRecord.designated_obligation_id === "string"
          ? cycleRecord.designated_obligation_id
          : undefined,
    };
    const validation = validateAuthoredCycleBreak({ members }, graph.nodes, authored);
    if (!validation.accepted) {
      rejection = validation.reason ?? `Cycle [${members.join(", ")}] was not resolved.`;
      break;
    }
  }

  if (!rejection) return null;

  const repairState = await readCyclicSeamRepairState(ctx.artifactsDir);
  const last = repairState.attempts.at(-1);
  // Carry the reason forward so the NEXT resolution prompt says what failed,
  // instead of re-asking for the same claim and burning the attempt cap on an
  // unexplained retry. A record that appeared without a matching emitted
  // attempt (a resumed run, a hand-written artifact) still gets its rejection
  // recorded — the outcome is the attempt.
  if (last && last.ledger_hash === graph.ledgerHash) {
    last.recheck_passed = false;
    last.recheck_reason = rejection;
  } else {
    repairState.attempts.push({
      ledger_hash: graph.ledgerHash,
      at: new Date().toISOString(),
      recheck_passed: false,
      recheck_reason: rejection,
    });
  }
  await writeCyclicSeamRepairState(ctx.artifactsDir, repairState);
  const archived = await archiveContractArtifact(
    ctx.artifactsDir,
    "cyclic_seam_resolution",
    "invalid",
    ctx.options.renameFn,
  );
  if (!archived.originalFree) {
    // The rejected record is STILL at its canonical path, and re-deriving would
    // read the same record, reject it again, fail to archive it again — an
    // unbounded loop with no cap to stop it: the attempt ledger updates the
    // same entry in place (one ledger hash), and `rederive` carries no depth
    // bound. This branch is what makes the re-check's new ability to REJECT
    // safe; before the re-check could reject, the failure was unreachable.
    return {
      via: "blocked",
      prompt: `# A Rejected Cyclic-Seam Resolution Could Not Be Archived

The cycle-break re-check rejected the resolution record:

${rejection}

The record could not be moved into the contract history directory, so it is still at its canonical path. Re-running would read the same rejected record and loop without bound, so the run stops here instead.

Remove or unlock \`${contractArtifactFilePath(ctx.artifactsDir, "cyclic_seam_resolution")}\` (and its \`.input.json\` sibling if present), then re-run next-step so the resolution phase is re-emitted with the rejection above.`,
      stopCondition:
        "Stop — a rejected cyclic-seam resolution could not be archived and would otherwise loop.",
    };
  }
  // Re-enter to emit the next attempt or the cap.
  return { via: "rederive" };
};

/**
 * Design-spec structural gates before the adversarial critic phase, in the order
 * they run: the design artifact's own structure, then the cheap cross-artifact
 * floor, then citation grounding. Error-severity gate failures re-emit the
 * responsible phase; warning-only results (e.g. circular obligation
 * dependencies) ride the critic prompt as advisory.
 */
const preCriticStructuralGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase !== "critic") return null;

  const outcomes = await evaluateContractPipelineCrossGateOutcomes(
    await readCrossGatePayloads(ctx),
  );

  // (a) The design artifact itself. `contract_finalization` precedes `critic`,
  //     so a not-evaluated outcome here means the payload is malformed, not
  //     absent — its empty issue list is not proof of a clean design.
  const designSpec = gateOutcomeOf(outcomes, "design_spec");
  if (!designSpec?.evaluated) {
    return {
      via: "phase",
      phase: "contract_finalization",
      extraSection: `## Design Structural Gates Could Not Run

The finalized module contracts could not be checked before adversarial review: ${
        designSpec?.reason ?? "no outcome record was produced for the design gate"
      }. Rewrite a complete, well-formed finalized_module_contracts artifact.
`,
    };
  }
  const gateErrors = designSpec.issues.filter((issue) => issue.severity === "error");
  if (gateErrors.length > 0) {
    return {
      via: "phase",
      phase: "contract_finalization",
      extraSection: `## Design Structural Gate Errors

The contract_finalization output failed deterministic structural gates. Fix every issue below before adversarial review can begin:

${gateErrors.map((issue) => `- [${issue.path}] ${issue.message}`).join("\n")}
`,
    };
  }
  const gateWarnings = designSpec.issues.filter((issue) => issue.severity === "warning");
  if (gateWarnings.length > 0) {
    return {
      via: "phase",
      phase: "critic",
      extraSection: `## Advisory: Design Structural Warnings

The following structural issues were detected and should inform your adversarial review. They do not block the pipeline but may indicate areas of design fragility:

${gateWarnings.map((issue) => `- [${issue.path}] ${issue.message}`).join("\n")}
`,
    };
  }

  // (b) Pre-adversarial structural floor (S5): the cheap cross-artifact checks
  //     whose inputs all exist by the critic phase, so the adversarial loop only
  //     ever sees structurally-sound obligations/tests/contracts and a gap is
  //     re-emitted to the precise responsible phase instead of being discovered
  //     at promotion after the adversarial budget is spent.
  const preCriticGate = await evaluatePreCriticStructuralGate(
    ctx.artifactsDir,
    ctx.root,
    await readCrossGatePayloads(ctx),
  );
  if (preCriticGate) {
    return {
      via: "phase",
      phase: preCriticGate.phase,
      extraSection: `## Pre-Adversarial Structural Gate Errors

The ${preCriticGate.phase} output failed deterministic structural gates. Fix every issue below before adversarial review begins:

${preCriticGate.errorLines.join("\n")}
`,
    };
  }

  // (c) M-B3 source-grounded citation gate at the pre-critic boundary: ground
  //     the module_decomposition's file_scope citations against the working tree
  //     before the adversarial loop. A module citing only a non-existent path and
  //     no real symbol is re-emitted to the `decomposition` phase — the phase that
  //     OWNS file_scope (the finalized contracts carry interface fields, not
  //     paths, so re-emitting contract_finalization could never change file_scope
  //     and an ungrounded scope would loop forever).
  const preCriticCitationGate = await evaluatePreCriticCitationGrounding(
    ctx.artifactsDir,
    ctx.root,
  );
  if (preCriticCitationGate) {
    await captureStepBoundaryFriction(
      ctx.artifactsDir,
      ctx.runId,
      {
        eventType: "phase_reemit",
        discriminator: "decomposition:citation_grounding:pre_critic",
        note:
          "decomposition re-emitted: a module's file_scope cited a component " +
          "that does not exist in the working tree (M-B3 citation grounding).",
        category: "trap",
      },
      "remediate-code",
    );
    return {
      via: "phase",
      phase: "decomposition",
      extraSection: `## Source-Grounded Citation Gate Errors

A module's file_scope cites a component that does not exist in the working tree. file_scope lives in the module decomposition (the finalized contracts carry interface fields, not paths), so fix the offending path(s) in the decomposition — every cited path or symbol must point at something real before adversarial review begins:

${preCriticCitationGate.errorLines.join("\n")}
`,
    };
  }

  return null;
};

/**
 * DC-3 merge intercept: when a parallel phase's aggregated artifact is still
 * missing, merge the per-module shards into it once they are ALL present.
 * Returns true when the aggregate was written. A missing shard (or a degenerate
 * ≤1-module decomposition, which never used the shard path) returns false, and
 * the caller re-emits the wave — never a partial aggregate. After a complete
 * merge the artifact is written enveloped and the pipeline re-derives; the
 * seam_reconciliation / critique pass downstream stays the consistency gate over
 * the merged contracts.
 */
async function tryMergeModuleShards(
  artifactsDir: string,
  phase: ParallelModulePhase,
): Promise<boolean> {
  const modules = await readDecomposedModules(artifactsDir);
  if (modules.length <= 1) return false;

  const scan = await scanModuleShards(artifactsDir, phase, modules);
  if (scan.missing.length > 0) return false;

  // goal_id: the upstream module_decomposition is authoritative (every artifact
  // shares one goal_id; the goal-ID consistency gate enforces it). Fall back to
  // a shard's goal_id only if the decomposition somehow lacks one.
  const decompositionGoalId = await readDecompositionGoalId(artifactsDir);
  const goalId =
    decompositionGoalId ||
    [...scan.present.values()]
      .map((contract) => (typeof contract.goal_id === "string" ? contract.goal_id : undefined))
      .find((candidate): candidate is string => Boolean(candidate)) ||
    "";

  await writeDerivedContractArtifact(
    artifactsDir,
    PARALLEL_MODULE_PHASES[phase],
    mergeModuleShards(modules, scan.present, goalId),
  );
  return true;
}

/**
 * Parallel-capable phase (DC-3): `module_contract_drafting` fans out to one
 * agent per module. The aggregated `module_contracts` artifact is missing here,
 * so first try to merge per-module shards (the worker may have just written
 * them) — a COMPLETE shard set merges into the aggregated artifact and the
 * pipeline re-derives; anything else re-emits the wave (which itself falls back
 * to the single aggregated step for a degenerate ≤1-module decomposition).
 */
const parallelModuleWaveGate: ContractGate = async (ctx) => {
  const phase = ctx.nextPhase;
  if (phase === null || !isParallelModulePhase(phase)) return null;
  const merged = await tryMergeModuleShards(ctx.artifactsDir, phase);
  return merged ? { via: "rederive" } : { via: "module_wave", phase };
};

/**
 * Auto-phasing (T3): at the conceptual-design critique, hand the critic the
 * tool-DERIVED phase cut so it assesses design quality WITHIN a mechanically
 * dependency-ordered foundations→consumers phasing, instead of rejecting an
 * arbitrary N-goal change as "over-scoped" and forcing the host to re-scope by
 * hand at intake. The cut is derived from the finalized module contracts'
 * producer/consumer artifact-token edges and PERSISTED as `phase_cut.json`, so the cut
 * the critic sees and the cut the implementation-DAG promotion enforces are one
 * source. Only injected when there is a genuine multi-phase cut to communicate.
 */
const phaseCutCritiqueGate: ContractGate = async (ctx) => {
  if (ctx.nextPhase !== "critique") return null;
  const cut = await ensurePhaseCutArtifact(ctx.artifactsDir);
  if (!cut || cut.phases.length <= 1) return null;
  const reReview = await buildReReviewSection("critique", ctx.artifactsDir);
  const phaseCutSection = renderPhaseCutSection(cut);
  return {
    via: "phase",
    phase: "critique",
    extraSection: reReview ? `${phaseCutSection}\n${reReview}` : phaseCutSection,
  };
};

/**
 * Granularity collapse (T1 slice 4b): for low-complexity work, fold the suffix
 * [nextPhase .. end of its group] into ONE round-trip producing several
 * artifacts, instead of one gated step per phase. Reads the POST-escalation
 * riskSignal (the escalate-on-evidence intercept may have already raised the
 * tier), so the dial is never frozen at run start — `fine` for medium/high keeps
 * full per-phase isolation. Only collapses a genuine multi-phase suffix, so a
 * lone trailing member falls through to its ordinary per-phase step.
 */
const collapsedRoundTripGate: ContractGate = (ctx) => {
  const phase = ctx.nextPhase;
  if (
    phase === null ||
    roundTripGranularityForTier(ctx.riskSignal?.tier) !== "collapsed"
  ) {
    return null;
  }
  const group = COLLAPSE_GROUPS.find((g) => g.includes(phase));
  if (!group) return null;
  const suffix = group.slice(group.indexOf(phase));
  if (suffix.length <= 1) return null;
  return { via: "collapsed_round_trip", phases: [...suffix] };
};

/**
 * Skeleton-scaffolded phases (S3): the tool pre-fills structure/ids from the
 * derived obligation ledger so the worker fills only the judgment slots.
 */
const scaffoldedPhaseGate: ContractGate = async (ctx) => {
  const phase = ctx.nextPhase;
  if (phase !== "test_validator_plan" && phase !== "implementation_planning") {
    return null;
  }
  return {
    via: "phase",
    phase,
    extraSection: await buildScaffoldSection(phase, ctx.artifactsDir),
  };
};

/**
 * The fallback: the ordinary per-phase step. Diff-based re-review (B2) rides it
 * — when a verdict-bearing review phase is re-emitted because an upstream
 * changed, the worker gets its prior verdict plus the precise
 * changed-since-last-review delta, so it re-affirms cheaply or revises only the
 * affected items rather than running blind.
 *
 * Reached only when every gate declined, which by construction means
 * `nextPhase` is a real phase: the promotion gate above never declines when the
 * frontier is null.
 */
const ordinaryPhaseStep = async (
  ctx: ContractGateContext,
): Promise<ContractStepPlan> => {
  const phase = ctx.nextPhase;
  if (phase === null) {
    throw new Error(
      "contract pipeline: the gate walk reached the fallback with no next phase — " +
        "the promotion gate must handle a null frontier.",
    );
  }
  return {
    via: "phase",
    phase,
    extraSection: await buildReReviewSection(phase, ctx.artifactsDir),
  };
};

/**
 * THE ORDERED GATE TABLE. Insertion order IS execution order (the walk consumes
 * the scaffold's derived `handledKeys`), names are unique by construction (a
 * duplicate object key is a compile error), and no gate can emit a step of its
 * own — the scaffold owns the single emission site.
 */
const CONTRACT_PIPELINE_GATES: Readonly<Record<string, ContractGate>> = {
  seed_source_digest_bound: seedSourceDigestGate,
  ingested_artifact_invalid: invalidIngestionGate,
  stale_artifact_archived: staleArchiveGate,
  phase_frontier_resolved: phaseFrontierGate,
  goal_id_consistent: goalIdConsistencyGate,
  finalized_module_set_preserved: finalizedModuleSetGate,
  work_block_seam_prepared: workBlockSeamGate,
  conceptual_critique_converged: conceptualCritiqueGate,
  obligation_ledger_derived: obligationLedgerDerivationGate,
  degenerate_seam_reconciliation_collapsed: degenerateSeamReconciliationGate,
  contract_finalization_derived: contractFinalizationDerivationGate,
  judge_repair_converged: judgeRepairGate,
  implementation_plan_promoted: implementationPlanPromotionGate,
  cyclic_seam_resolved: cyclicSeamResolutionGate,
  cyclic_seam_rechecked: cyclicSeamRecheckGate,
  pre_critic_structural: preCriticStructuralGate,
  parallel_module_wave: parallelModuleWaveGate,
  phase_cut_critique: phaseCutCritiqueGate,
  collapsed_round_trip: collapsedRoundTripGate,
  scaffolded_phase: scaffoldedPhaseGate,
};

/**
 * Bind the ONE shared step-emission scaffold to an invocation's context.
 *
 * Scaffold ADOPTER, never a second scaffold: this consumes `createStepEmissionScaffold` from
 * `audit-tools/shared` — the same scaffold the audit orchestrator entry point
 * drives — rather than a second one of this module's own. The pipeline's
 * numbered early-return-and-re-emit shape is `emitFirstApplicable`, a row shape
 * in that table, not a fork of it.
 */
function createContractPipelineEmission(ctx: ContractGateContext) {
  return createStepEmissionScaffold<
    ContractGateContext,
    ContractStepPlan,
    RemediationStep | null
  >({
    table: CONTRACT_PIPELINE_GATES,
    fallback: ordinaryPhaseStep,
    write: (plan) => writeContractStepPlan(ctx, plan),
    // The pipeline's externally-observable emission is the PERSISTED step
    // contract, which `write` has just produced; the CLI renders it to the host.
    // There is deliberately no second stdout announcement here.
    log: () => {},
  });
}

/**
 * The gate walk order, exported so a drift guard reads the real set instead of
 * reconstructing one by reflecting over a chain of `if` statements.
 *
 * This and the scaffold's `handledKeys` are BOTH `Object.keys` of the SAME
 * object literal, and the walk consumes `handledKeys` directly — so the two
 * agree by construction, not by a test that compares them. No such test exists,
 * and none is needed: there is no second list to drift from.
 */
export const CONTRACT_PIPELINE_GATE_ORDER: readonly string[] = Object.freeze(
  Object.keys(CONTRACT_PIPELINE_GATES),
);

/**
 * Build and write the next contract-pipeline step.
 * Returns null when the pipeline is complete and the extracted plan is ready.
 */
export async function buildNextContractPipelineStep(
  options: ContractPipelineStepOptions,
): Promise<RemediationStep | null> {
  const { root, artifactsDir, runId, sourcePaths } = options;

  // Adversarial-depth dial (T1 slices 3/4): derive the depth for the critique /
  // critic phases from the intake risk signal, escalating on decomposition
  // evidence. The (possibly raised) riskSignal is also consumed by the
  // granularity-collapse gate, so it is carried on the context alongside it.
  const { riskSignal, adversarialDepth } = await resolveAdversarialDepth(artifactsDir);

  // Resolve artifact paths for the prompt renderers. The host's world is the
  // plain INPUT files (D3): every host-facing path — both where a role WRITES
  // its output and where it READS its upstreams — is `<name>.input.json`. The
  // tool's canonical envelopes (`<name>.json`) are derived at ingest and never
  // named to the host.
  const artifactPaths: Partial<Record<ContractPipelineArtifactName, string>> = {};
  for (const name of CP_ARTIFACT_NAMES) {
    artifactPaths[name] = contractInputFilePath(artifactsDir, name);
  }

  const seedPath = pathASeedFilePath(artifactsDir);
  const ctx: ContractGateContext = {
    options,
    root,
    artifactsDir,
    runId,
    sourcePaths,
    paths: intakePaths(artifactsDir),
    artifactPaths,
    // Present only for structured_audit runs.
    pathASeedPath: existsSync(seedPath) ? seedPath : undefined,
    riskSignal,
    adversarialDepth,
    artifactsSettled: false,
    nextPhase: null,
  };

  const emission = createContractPipelineEmission(ctx);
  return await emission.emitFirstApplicable([...emission.handledKeys], ctx);
}

/**
 * Build the diff-based re-review section for a review phase being re-emitted after
 * staleness, or undefined when this is not a re-review (non-review phase, or no
 * prior snapshot). See `reviewSnapshot.ts`.
 */
async function buildReReviewSection(
  phase: string,
  artifactsDir: string,
): Promise<string | undefined> {
  const artifact = PHASE_TO_ARTIFACT[phase];
  if (!artifact || !isReviewArtifact(artifact)) return undefined;
  if (!reviewSnapshotExists(artifactsDir, artifact)) return undefined;
  const snapshot = await readReviewSnapshot(artifactsDir, artifact);
  if (!snapshot) return undefined;
  const delta = await computeReReviewDelta(artifactsDir, artifact, snapshot);
  return renderReReviewSection(artifact, snapshot, delta);
}

// ── DAG → extracted plan conversion ──────────────────────────────────────────

// ── Obligation-kind → lens/severity mappings ──────────────────────────────────

/**
 * The obligation-kind vocabulary, in priority order (higher index = higher
 * priority; `invariant` is highest).
 *
 * MNT-114e4941-3: this used to be a THIRD independent copy of the vocabulary —
 * a local `type ObligationKind` union beside derive.ts's `TESTABLE_KINDS` and
 * contractPipelineGates.ts's `TESTABLE_OBLIGATION_KINDS`, with nothing forcing
 * the three to agree, while the ledger's own `obligation.kind` is typed as a
 * bare `string`. The consequence was not theoretical: an unrecognized kind was
 * CAST to this union, scored -1 by `indexOf`, and then indexed the lens map to
 * `undefined` — so a ledger kind outside these four promoted a finding with
 * `lens: undefined`.
 *
 * Membership and priority are now derived from the single definition list in
 * `contractPipeline/obligationKinds.ts`. An unrecognized kind is not dropped or
 * cast: it is routed through the shared `isTestablePhaseObligation` predicate.
 */
export { OBLIGATION_KIND_PRIORITY };
export type { ObligationKind };

const OBLIGATION_KIND_SET: ReadonlySet<string> = new Set(OBLIGATION_KIND_PRIORITY);

/**
 * Classify a raw ledger `kind` string (which the ledger types as a bare
 * `string`) into this module's vocabulary. A recognized kind maps to itself; an
 * unrecognized one is classified by the SHARED testability predicate rather
 * than guessed here — testable ⇒ `behavioral` (the testable default, so it
 * carries a real lens and a mid severity), otherwise ⇒ `structural`.
 */
export function classifyObligationKind(kind: string): ObligationKind {
  if (OBLIGATION_KIND_SET.has(kind)) return kind as ObligationKind;
  return isTestablePhaseObligation(kind) ? "behavioral" : "structural";
}

function deriveObligationLensAndSeverity(kinds: readonly ObligationKind[]): {
  lens: string;
  severity: Finding["severity"];
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
  const severityMap: Record<ObligationKind, Finding["severity"]> = {
    invariant: "high",
    behavioral: "medium",
    structural: "low",
    test: "low",
  };
  return { lens: lensMap[topKind], severity: severityMap[topKind] };
}

// ── Normalized block write scope + declared command shape ─────────────────────────────────────
//
// `touched_files` is the PROMPT-BOUND WRITE SCOPE the host-handoff substrate
// enforces against the landed diff, and `targeted_commands` are executed
// verbatim through a shell in the repository root. That consumer can check the
// SHAPE of what it is handed; it can never check whether the shape is CORRECT
// for this repository. So the producer normalizes here: an absolute or
// separator-inconsistent path becomes one canonical repo-relative form, a path
// that escapes the repository is refused outright, and a command carrying shell
// chaining or substitution is refused rather than handed to a shell.

/**
 * The tracked-path corpus for write-scope checking, or null when the tree
 * cannot be read. Null degrades to "shape-only normalization" exactly as the
 * M-B3 citation gate degrades on an unreadable tree — a fixture directory or a
 * fresh checkout must not be bricked, only an unsound path in a REAL tree is
 * refused.
 */
async function readTrackedWriteScopeCorpus(root: string): Promise<{
  files: ReadonlySet<string>;
  directories: ReadonlySet<string>;
} | null> {
  if (!(await isInsideGitWorkTree(root))) return null;
  const files = await enumerateRepoTreePaths(root);
  if (files.size === 0) return null;
  const directories = new Set<string>();
  for (const path of files) {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      directories.add(segments.slice(0, i).join("/"));
    }
  }
  return { files, directories };
}

/**
 * Normalize one block's declared write scope into repo-relative, forward-slashed,
 * unique, sorted paths, refusing outright anything that leaves the repository.
 *
 * Case is PRESERVED (`repoRelativePath`, not the lowercasing
 * `normalizeRepoPath`): this string is the write scope a host enforces against a
 * landed diff on a case-sensitive filesystem, so lowercasing it would make a
 * legitimate edit look out of scope. Lowercasing is used only as a MATCH key,
 * never as the stored value.
 *
 * The tracked-tree half is NOT here: see
 * {@link evaluatePromotedPlanWriteScope}, which runs at this same promotion
 * boundary with a bounded re-emit instead of an unrecoverable throw.
 */
export interface BlockWriteScopeNormalization {
  /** The entries that normalized cleanly, repo-relative, unique and sorted. */
  touched_files: string[];
  /** One line per REFUSED entry. Non-empty ⇒ the caller must not promote. */
  refusals: string[];
}

export function normalizeBlockTouchedFiles(
  root: string,
  files: readonly string[],
  blockId: string,
): BlockWriteScopeNormalization {
  const normalized = new Set<string>();
  const refusals: string[] = [];
  for (const raw of files) {
    const candidate = typeof raw === "string" ? raw.trim() : "";
    if (candidate.length === 0) {
      refusals.push(`Block "${blockId}" declares an empty touched_files entry.`);
      continue;
    }
    const directoryIntent = /[\\/]$/u.test(candidate);
    const portableCandidate = toPosixPath(candidate);
    const absolute = isAbsolute(portableCandidate)
      ? portableCandidate
      : resolve(root, portableCandidate);
    try {
      const normalizedPath = repoRelativePath(
        root,
        absolute,
        `block "${blockId}" touched_files entry`,
      );
      normalized.add(directoryIntent ? `${normalizedPath}/` : normalizedPath);
    } catch {
      refusals.push(
        `Block "${blockId}" declares the touched_files entry ${JSON.stringify(raw)}, which ` +
          `does not resolve to a path beneath the repository root. A POSIX-absolute form ` +
          `("/src/x.ts") is read as absolute, not repo-relative — drop the leading slash. The ` +
          `write scope is re-checked against the landed diff, so it may only name paths ` +
          `beneath ${root}.`,
      );
    }
  }
  // Content-derived order: an incidentally-ordered write scope would churn the
  // plan's content hash on every re-promotion.
  return {
    touched_files: [...normalized].sort((left, right) => compareCodeUnits(left, right)),
    refusals,
  };
}

/**
 * The tracked-tree half of The normalized-write-scope invariant, run against
 * the PROMOTED plan so a violation takes the same bounded re-emit path the M-B3
 * citation gate takes, rather than throwing out of the promotion.
 *
 * It exists because the citation gate is NOT a superset: a finding grounds if
 * ANY cited path OR SYMBOL is real, so a node whose prose names a real symbol
 * can ground while its declared write scope is still fabricated — and the write
 * scope is what a host binds a worker to.
 *
 * A path that is not tracked but whose parent directory IS stays legal: a
 * remediation block legitimately creates new files, and dropping a declared
 * write target is the failure mode that strands an implementer with an
 * obligation it has no scope to discharge. Fail-open on an unreadable tree, as
 * the citation gate does.
 */
export async function evaluatePromotedPlanWriteScope(
  artifactsDir: string,
  root: string,
): Promise<{ violations: string[] } | null> {
  const corpus = await readTrackedWriteScopeCorpus(root);
  if (!corpus) return null;
  const plan = await readOptionalJsonFile<{
    blocks?: Array<{ block_id?: unknown; touched_files?: unknown }>;
  }>(intakePaths(artifactsDir).extractedPlan);
  const violations: string[] = [];
  for (const block of Array.isArray(plan?.blocks) ? plan.blocks : []) {
    const blockId = typeof block.block_id === "string" ? block.block_id : "(unnamed block)";
    const touched = Array.isArray(block.touched_files) ? block.touched_files : [];
    violations.push(
      ...writeScopeCorpusViolations(
        corpus,
        touched.filter((path): path is string => typeof path === "string"),
        `Block "${blockId}"`,
      ),
    );
  }
  return violations.length > 0 ? { violations } : null;
}

/**
 * The ONE tracked-tree membership rule for a declared write-scope path: legal
 * when the file is tracked, sits at the repo root, or its parent directory
 * exists in the tracked tree (a block legitimately creates NEW files in
 * existing directories). Shared by the promotion gate above and the
 * clarification scope-delta validation, so the two cannot drift.
 */
function writeScopeCorpusViolations(
  corpus: { files: ReadonlySet<string>; directories: ReadonlySet<string> },
  paths: readonly string[],
  label: string,
): string[] {
  const violations: string[] = [];
  for (const path of paths) {
    const key = normalizeRepoPath(path);
    const parent = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "";
    if (corpus.files.has(key) || parent === "" || corpus.directories.has(parent)) {
      continue;
    }
    violations.push(
      `${label} declares the write-scope path "${path}", whose directory does ` +
        `not exist in the tracked tree.`,
    );
  }
  return violations;
}

/**
 * Tracked-tree parity for a POST-promotion write-scope widening
 * (open-bugs.md:110): a clarification scope delta must clear the same rule the
 * promotion gate enforced, or the delta lane becomes a bypass of it. Returns
 * violation lines; [] on an unreadable tree (fail-open, exactly as the
 * promotion gate degrades).
 */
export async function checkWriteScopePathsAgainstTrackedTree(
  root: string,
  paths: readonly string[],
  label: string,
): Promise<string[]> {
  const corpus = await readTrackedWriteScopeCorpus(root);
  if (!corpus) return [];
  return writeScopeCorpusViolations(corpus, paths, label);
}

/**
 * Refuse a targeted command that leaves the declared shape — a single
 * invocation with no shell chaining, substitution or redirection. Deliberately
 * ecosystem-neutral: this module never asserts WHICH runner is legitimate
 * (language-neutral by contract), only that the string handed to a shell cannot
 * do more than invoke one command.
 *
 * The RULE is not here. It is `commandLeavesDeclaredShape`
 * (`audit-tools/shared`), the one predicate the host-handoff consumer and the
 * triage re-verification spawn also ask. This function owns only the WORDING and
 * the refusals-as-data contract. It used to own a second, quote-BLIND regex
 * instead, and the two disagreed in both directions: `pytest -k 'not slow'`
 * cleared promotion and then dead-ended at the consumer as
 * `block_contract_invalid`, while `echo "a & b"` was refused here though the
 * consumer admits it.
 *
 * Refusals are RETURNED, never thrown: the promotion boundary turns them into
 * the same bounded re-emit every other promotion rejection takes, so a
 * malformed command re-emits implementation_planning instead of wedging every
 * subsequent next-step with an unclassified stack.
 */
export interface BlockCommandNormalization {
  targeted_commands: string[];
  /** One line per REFUSED command. Non-empty ⇒ the caller must not promote. */
  refusals: string[];
}

export function normalizeBlockTargetedCommands(
  commands: readonly string[],
  blockId: string,
): BlockCommandNormalization {
  const partitioned = partitionCommandsByDeclaredShape(commands, (kind, raw) =>
    kind === "empty"
      ? `Block "${blockId}" declares an empty targeted_commands entry.`
      : `Block "${blockId}" declares the targeted_commands entry ${JSON.stringify(raw)}, ` +
        `which carries shell chaining, substitution or redirection. A targeted command is ` +
        `executed verbatim through a shell, so it must be one invocation — split it into ` +
        `separate entries.`,
  );
  return { targeted_commands: partitioned.commands, refusals: partitioned.refusals };
}

/**
 * Collect every write-scope and command refusal the promotion WOULD hit, before
 * a plan is written. Runs the same two normalizers over the same derived node
 * scope the promoter uses, so this pre-check and the promotion cannot disagree
 * about what is refusable — and the refusal reaches the host as the bounded
 * `implementation_planning` re-emit every other promotion rejection takes,
 * rather than as a thrown stack that wedges every subsequent next-step.
 */
export async function collectDagWriteScopeRefusals(
  artifactsDir: string,
  root: string,
): Promise<string[]> {
  const dag = envelopePayload(
    await readContractArtifact(artifactsDir, "implementation_dag"),
  ) as ImplementationDAG | undefined;
  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  if (nodes.length === 0) return [];
  const { resolve: deriveNodeFiles } = await buildNodeWriteScopeResolver(artifactsDir);
  const refusals: string[] = [];
  for (const [index, node] of nodes.entries()) {
    const blockId = toBlockId(ensureNodeId(node.id, index));
    refusals.push(
      ...normalizeBlockTouchedFiles(root, deriveNodeFiles(node), blockId).refusals,
      ...normalizeBlockTargetedCommands(node.targeted_commands ?? [], blockId).refusals,
    );
  }
  return refusals;
}

/**
 * Path-A canonical-block membership validation, run BEFORE anything is promoted
 * (OBL-seam-prep-remediate-core-inv-2 / COR-114e4941). These are exactly the
 * checks the promoter itself performs while building its node→canonical-group
 * map — but there they THROW out of `promoteImplementationDagToExtractedPlan`,
 * an unclassified stack that wedged every subsequent next-step. Hoisted here so
 * an invalid `source_finding_ids` declaration takes the same bounded re-emit as
 * every other promotion rejection, with no gate having executed past it.
 *
 * Returns one line per violation; empty means the DAG is promotable on this
 * axis (or Path A is not in play at all).
 */
export async function collectPathARefusals(
  artifactsDir: string,
): Promise<string[]> {
  const dag = envelopePayload(
    await readContractArtifact(artifactsDir, "implementation_dag"),
  ) as ImplementationDAG | undefined;
  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  if (nodes.length === 0) return [];
  if (!nodes.some((node) => Array.isArray(node.source_finding_ids))) return [];

  const pathASeed = await readOptionalJsonFile<PathASeed>(
    pathASeedFilePath(artifactsDir),
  );
  const approvedSource = pathASeed
    ? projectApprovedFindings(
        await readOptionalJsonFile<unknown>(pathASeed.audit_findings_path),
      )
    : undefined;
  if (!approvedSource) {
    return [
      "implementation_dag declares source_finding_ids but no Path-A seed is present, so the ids cannot be joined to a canonical audit work block.",
    ];
  }

  const signature = (ids: readonly string[]): string =>
    JSON.stringify([...ids].sort((left, right) => compareCodeUnits(left, right)));
  const canonicalGroups = new Map(
    approvedSource.workBlocks.map((block) => [
      signature(block.finding_ids),
      [...block.finding_ids].sort((left, right) => compareCodeUnits(left, right)),
    ]),
  );
  const usedGroups = new Set<string>();
  const refusals: string[] = [];
  for (const [index, node] of nodes.entries()) {
    const nodeId = ensureNodeId(node.id, index);
    const sourceIds = node.source_finding_ids;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      refusals.push(
        `implementation_dag node "${nodeId}" must declare source_finding_ids for Path-A promotion.`,
      );
      continue;
    }
    const uniqueIds = [...new Set(sourceIds)];
    if (uniqueIds.length !== sourceIds.length) {
      refusals.push(
        `implementation_dag node "${nodeId}" repeats a source_finding_ids member.`,
      );
    }
    const groupSignature = signature(uniqueIds);
    const canonicalGroup = canonicalGroups.get(groupSignature);
    if (!canonicalGroup) {
      refusals.push(
        `implementation_dag node "${nodeId}" source_finding_ids do not match a canonical audit work block.`,
      );
      continue;
    }
    if (usedGroups.has(groupSignature)) {
      refusals.push(
        `implementation_dag node "${nodeId}" duplicates a canonical audit work block.`,
      );
    }
    usedGroups.add(groupSignature);
  }
  if (
    refusals.length === 0 &&
    usedGroups.size !== canonicalGroups.size
  ) {
    refusals.push(
      "implementation_dag source_finding_ids do not cover every canonical audit work block exactly once.",
    );
  }
  return refusals;
}

/**
 * Convert a completed ImplementationDAG into the extracted-plan.json format
 * that the existing handlePendingExtractedPlan/applyPlanPipeline path consumes.
 *
 * `root` defaults to the repository that owns `artifactsDir`, so the existing
 * one-argument callers keep working while the pipeline passes the run's real
 * root for write-scope normalization.
 */
export async function promoteImplementationDagToExtractedPlan(
  artifactsDir: string,
  root: string = climbOutOfAuditTools(artifactsDir),
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
      /** Canonical audit finding ids implemented by this DAG node. */
      source_finding_ids?: string[];
      files_likely_touched?: string[];
      preconditions?: string[];
      expected_changes?: string;
      depends_on?: string[];
    }>;
  };

  const pathASeed = await readOptionalJsonFile<PathASeed>(
    pathASeedFilePath(artifactsDir),
  );
  const approvedSource = pathASeed
    ? projectApprovedFindings(
        await readOptionalJsonFile<unknown>(pathASeed.audit_findings_path),
      )
    : undefined;

  // Load obligation_ledger for lens/severity derivation (graceful: may be absent).
  const ledgerPayload = envelopePayload(
    await readContractArtifact(artifactsDir, "obligation_ledger"),
  ) as ObligationLedger | undefined;
  const obligationMap = new Map<string, ObligationKind>();
  if (ledgerPayload?.obligations) {
    for (const obl of ledgerPayload.obligations) {
      // Classified, never cast: an unrecognized kind used to index the lens map
      // to `undefined` and promote a lens-less finding (MNT-114e4941-3).
      obligationMap.set(obl.id, classifyObligationKind(String(obl.kind ?? "")));
    }
  }

  // Auto-phasing (T3): read the persisted phase cut and re-key its module-phase
  // map by `moduleSlug(name)` — the fragment the obligation ledger encodes into
  // `OBL-<slug>-…` ids. The block phase ordinal is then derived MECHANICALLY from
  // each node's obligations (never trusting a worker-carried field, which a node
  // merge could drop), so a foundation block always sorts below the consumers that
  // depend on it. Absent cut (single module / no finalized contracts) → no
  // ordinals, i.e. one phase, no barrier.
  const phaseCut = await readPhaseCutArtifact(artifactsDir);
  const slugToOrdinal = new Map<string, number>();
  if (phaseCut) {
    for (const [name, ordinal] of Object.entries(phaseCut.module_phase)) {
      slugToOrdinal.set(moduleSlug(name), ordinal);
    }
  }
  const lastOrdinal = Math.max(0, ...slugToOrdinal.values());
  const hasMultiPhase = phaseCut ? phaseCut.phases.length > 1 : false;

  // Root-cause fix for scope-less nodes: the DAG's write scope
  // (`output_files`/`files_likely_touched`) is host-authored and a coarse
  // "Remediate <module>" decomposition can leave it EMPTY, which promotes a
  // finding with empty affected_files AND a block with empty touched_files — an
  // undispatchable node (no worktree seed, no write scope, no paths for a
  // single-shot worker to inline) that silently dooms the whole run and
  // cascade-blocks its dependents. Derive the write scope DETERMINISTICALLY from
  // the module decomposition instead of trusting the host to have filled it: each
  // node's obligations are `OBL-<moduleSlug>-…`, and every module declares its
  // `file_scope`, so a node that declared no files inherits the file_scope of the
  // module(s) its obligations belong to. A node that DID declare files still gains
  // those modules' finalized-contract write targets (P38) — the scope is a UNION,
  // not a precedence. Single-sourced with the DAG validator, which refuses a node
  // this resolves to nothing for — see buildNodeWriteScopeResolver.
  const { resolve: deriveNodeFiles } = await buildNodeWriteScopeResolver(artifactsDir);

  const nodes = (Array.isArray(dag?.nodes) ? [...dag.nodes] : []).sort((left, right) =>
    compareCodeUnits(String(left.id), String(right.id)),
  );

  // Path-A promotion is an identity-preserving projection. DAG node ids describe
  // implementation tasks; they may not replace the canonical auditor finding
  // ids or split/merge the canonical coherence components.
  const canonicalItemsByNodeId = new Map<string, string[]>();
  if (
    approvedSource &&
    nodes.some((node) => Array.isArray(node.source_finding_ids))
  ) {
    const signature = (ids: readonly string[]): string =>
      JSON.stringify(
        [...ids].sort((left, right) => compareCodeUnits(left, right)),
      );
    const canonicalGroups = new Map(
      approvedSource.workBlocks.map((block) => [
        signature(block.finding_ids),
        [...block.finding_ids].sort((left, right) => compareCodeUnits(left, right)),
      ]),
    );
    const usedGroups = new Set<string>();
    for (const [index, node] of nodes.entries()) {
      const nodeId = ensureNodeId(node.id, index);
      const sourceIds = node.source_finding_ids;
      if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
        throw new Error(
          `implementation_dag node "${nodeId}" must declare source_finding_ids for Path-A promotion.`,
        );
      }
      const uniqueIds = [...new Set(sourceIds)];
      if (uniqueIds.length !== sourceIds.length) {
        throw new Error(
          `implementation_dag node "${nodeId}" repeats a source_finding_ids member.`,
        );
      }
      const groupSignature = signature(uniqueIds);
      const canonicalGroup = canonicalGroups.get(groupSignature);
      if (!canonicalGroup) {
        throw new Error(
          `implementation_dag node "${nodeId}" source_finding_ids do not match a canonical audit work block.`,
        );
      }
      if (usedGroups.has(groupSignature)) {
        throw new Error(
          `implementation_dag node "${nodeId}" duplicates a canonical audit work block.`,
        );
      }
      usedGroups.add(groupSignature);
      canonicalItemsByNodeId.set(nodeId, canonicalGroup);
    }
    if (usedGroups.size !== canonicalGroups.size) {
      throw new Error(
        "implementation_dag source_finding_ids do not cover every canonical audit work block exactly once.",
      );
    }
  }

  let findings: Finding[] = nodes.map((node, index) => {
    const id = ensureNodeId(node.id, index);
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
      // output_files (declared write scope) takes priority over files_likely_touched,
      // unioned with the owning module contract's declared write targets; when the
      // node declared neither, it inherits the module file_scope (deriveNodeFiles)
      // so the finding is never scope-less. Map each path to the { path } shape that
      // Finding.affected_files expects.
      affected_files: deriveNodeFiles(node).map((p) => ({ path: p })),
      evidence:
        obligationEvidence.length > 0
          ? obligationEvidence
          : [node.description ?? node.title ?? `Contract-pipeline task ${id}`],
      concrete_change: node.description ?? "",
      contract_goal_id: dag?.goal_id,
      contract_obligation_ids: contractObligations,
      verification_obligation_ids: verificationObligations,
      addresses_counterexamples: addressedCounterexamples,
      targeted_commands: node.targeted_commands ?? [],
      preconditions: node.preconditions ?? [],
      expected_changes: node.expected_changes ?? "",
    };
  });

  if (approvedSource && canonicalItemsByNodeId.size > 0) {
    const nodeByFindingId = new Map<string, (typeof nodes)[number]>();
    for (const [index, node] of nodes.entries()) {
      const nodeId = ensureNodeId(node.id, index);
      for (const findingId of canonicalItemsByNodeId.get(nodeId) ?? []) {
        nodeByFindingId.set(findingId, node);
      }
    }
    findings = [...approvedSource.findings]
      .sort((left, right) => compareCodeUnits(left.id, right.id))
      .map((finding) => {
        const node = nodeByFindingId.get(finding.id)!;
        const contractObligations = [...new Set(node.satisfies_obligations ?? [])];
        const verificationObligations = [
          ...new Set(node.verification_obligation_ids ?? []),
        ];
        return {
          ...finding,
          affected_files: [...finding.affected_files].sort((left, right) =>
            compareCodeUnits(left.path, right.path),
          ),
          contract_goal_id: dag?.goal_id,
          contract_obligation_ids: contractObligations,
          verification_obligation_ids: verificationObligations,
          addresses_counterexamples: [
            ...new Set(node.addresses_counterexamples ?? []),
          ],
          targeted_commands: [...(node.targeted_commands ?? [])],
          preconditions: [...(node.preconditions ?? [])],
          expected_changes: node.expected_changes ?? "",
        };
      });
  }

  // finding_id → { obligation_ids, node_ids } trace. Each promoted finding maps
  // 1:1 to a DAG node, so its node_ids are itself plus every node it depends on
  // (the upstream nodes whose output it builds on). obligation_ids unions the
  // satisfied and verification obligations. This is the auditable backward trace
  // from a remediation finding to the contract obligations it discharges.
  const nodeIdSet = new Set(nodes.map((n, i) => ensureNodeId(n.id, i)));
  const traceability: Record<
    string,
    { obligation_ids: string[]; node_ids: string[] }
  > = {};
  for (const [index, node] of nodes.entries()) {
    const id = ensureNodeId(node.id, index);
    const obligationIds = [
      ...new Set([
        ...(node.satisfies_obligations ?? []),
        ...(node.verification_obligation_ids ?? []),
      ]),
    ];
    const dependsOn = (node.depends_on ?? []).filter((dep) => nodeIdSet.has(dep));
    const nodeIds = [...new Set([id, ...dependsOn])];
    const findingIds = canonicalItemsByNodeId.get(id) ?? [id];
    for (const findingId of findingIds) {
      traceability[findingId] = {
        obligation_ids: obligationIds,
        node_ids: nodeIds,
      };
    }
  }

  const blocks = nodes.map((node, index) => {
    const nodeId = ensureNodeId(node.id, index);
    const deps = ((node as { depends_on?: string[] }).depends_on ?? []).map(
      (depId) => toBlockId(depId),
    );
    // Same derivation as the finding's affected_files: declared write scope, else
    // the module file_scope inherited via the node's obligations — so the block's
    // file-ownership scheduler never sees an empty (undispatchable) touched set.
    // Normalized before it leaves this producer: the host-handoff substrate binds
    // this list as the write scope and can validate its shape but never its
    // correctness.
    // Refusals are collected, not thrown: `collectDagWriteScopeRefusals` runs
    // these same two normalizers at the promotion gate and re-emits, so by the
    // time promotion runs there is nothing left to refuse. The throw below is a
    // BACKSTOP for a caller that skipped that gate — never the operator-facing
    // path.
    //
    // "Nothing left to refuse" is now TRUE BY CONSTRUCTION, not by hope: the
    // command half asks the ONE shared `commandLeavesDeclaredShape` predicate
    // that the host-handoff consumer asks, so a command this gate admits cannot
    // be refused downstream (and vice versa). It used to be a claim about two
    // independent implementations that disagreed in both directions.
    const scope = normalizeBlockTouchedFiles(root, deriveNodeFiles(node), toBlockId(nodeId));
    const commands = normalizeBlockTargetedCommands(
      node.targeted_commands ?? [],
      toBlockId(nodeId),
    );
    const refusals = [...scope.refusals, ...commands.refusals];
    if (refusals.length > 0) {
      throw new Error(
        `implementation_dag node "${nodeId}" has an unpromotable write scope, which the ` +
          `promotion gate should have refused first: ${refusals.join(" | ")}`,
      );
    }
    const touchedFiles = scope.touched_files;
    const targetedCommands = commands.targeted_commands;
    // Phase ordinal from the union of this node's obligations (max → fail-toward-
    // later). Only stamped when there is a genuine multi-phase cut, so a single-
    // phase change carries no ordinal and the scheduler runs no barrier.
    const phaseOrdinal = hasMultiPhase
      ? phaseOrdinalForObligations(
          [
            ...(node.satisfies_obligations ?? []),
            ...(node.verification_obligation_ids ?? []),
          ],
          slugToOrdinal,
          lastOrdinal,
        )
      : undefined;
    return {
      block_id: toBlockId(nodeId),
      items: canonicalItemsByNodeId.get(nodeId) ?? [nodeId],
      // INV-remediate-pipeline-02: a block with prerequisites is never
      // wave-dispatched as independent — parallel_safe derives from depends_on.
      parallel_safe: deps.length === 0,
      dependencies: deps,
      // touched_files is REQUIRED on the block contract; promote the node's
      // declared write scope so the file-ownership scheduler can read it.
      touched_files: touchedFiles,
      ...(phaseOrdinal !== undefined ? { phase_ordinal: phaseOrdinal } : {}),
      ...(targetedCommands.length > 0 ? { targeted_commands: targetedCommands } : {}),
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
