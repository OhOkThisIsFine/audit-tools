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
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  writeJsonFile,
  readOptionalJsonFile,
  readValidatedRepoSessionIntent,
  resolveSessionConfig,
  formatValidationIssues,
  hashContent,
  isRecord,
  withFsRetry,
  type ValidationIssue,
  type JudgeReport,
  type JudgeRepairDirective,
  type ImplementationDAG,
  type ObligationLedger,
  type SessionConfig,
  type CounterexampleReport,
  captureStepBoundaryFriction,
} from "audit-tools/shared";
import { loadRemediateSessionConfig } from "./sessionConfigLoad.js";
import { counterexampleFingerprint } from "../contractPipeline/counterexampleFingerprint.js";
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
  type ContractPipelineArtifactEnvelope,
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
} from "../contractPipeline/phaseCut.js";
import { ensurePhaseCutArtifact, readPhaseCutArtifact } from "../contractPipeline/phaseCutArtifact.js";
import {
  detectCyclicSeamObligations,
  validateCycleBreak,
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
  renderContractPipelinePrompt,
  renderContractRepairPrompt,
  CONTRACT_PIPELINE_PHASE_ORDER,
  PHASE_TO_ARTIFACT,
} from "./contractPipelinePrompts.js";
import {
  CONTRACT_PIPELINE_VALIDATORS,
  CP_MODULE_CONTRACTS_VERSION,
  validateDesignSpecGates,
  validateGoalIdConsistency,
  validateImplementationDAGIntegrity,
  validatePairedObligations,
  validateEvidenceThreaded,
  validateDigestCoverage,
  validateReconciliationDerivation,
  validateContractCitationGrounding,
  deriveNodeModelTierFromNode,
} from "../validation/contractPipeline.js";
import type { Finding } from "audit-tools/shared";
import type { ContractPipelineArtifactName } from "../contractPipeline/artifactStore.js";
import { scheduleWave, type WaveScheduleResult } from "./dispatch.js";
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
 * Granularity collapse group (T1 slice 4b). The framing phases — goal, context,
 * decomposition — are ONE coherent act of authoring (scope the change top-down):
 * they carry no adversarial judgment and no deterministic derivation interleaves
 * them, so for low-complexity work they fold into a single round-trip producing
 * all three artifacts instead of three gated steps. The group deliberately STOPS
 * at decomposition (before module_contract_drafting): keeping the decomposition→
 * drafting boundary lets the slice-4a escalate-on-evidence intercept inspect the
 * fresh decomposition and raise the tier — un-collapsing every remaining phase —
 * before any contract is drafted or the per-module wave fans out. Collapse is
 * best-effort: any member artifact the worker omits or writes malformed is
 * re-emitted as its own fine-grained step by `nextMissingContractPhase`, so no
 * work is ever lost. See `roundTripGranularityForTier`.
 */
const FRAMING_COLLAPSE_GROUP = [
  "goal_normalization",
  "context_collection",
  "decomposition",
] as const;

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

interface ContractRepairState {
  schema_version: "remediate-code-contract-pipeline/repair-state/v1alpha1";
  /**
   * One entry per judge-ordered repair step emission (keyed by judge hash).
   * `accepted_ce_ids` records the judge-accepted counterexample ids this repair
   * was dispatched to address, for human debugging/display only.
   * `addressed_ce_fingerprints` is the CONTENT-keyed form the convergence gate
   * actually diffs against — see `keyOf` in `evaluateJudgeGate`: raw reviewer
   * ids are not stable cross-round identity (two independent adversarial
   * rounds commonly both label their top counterexample "CE-001"), so the gate
   * resolves each accepted id against the live counterexample artifact and
   * keys on content (violated_obligation_ids + normalized claim) instead,
   * falling back to raw-id keying only when an id cannot be resolved. The
   * cumulative union of fingerprints across repairs is the "already-addressed"
   * set; a re-accepted (un-converged) counterexample is detected as a stall
   * rather than silently re-repaired. Entries written before this field
   * existed lack it — they default to `[]` (fail-open: at most one extra
   * repair round on an in-flight upgrade, never a false stall).
   */
  repairs: {
    judge_hash: string;
    target: string;
    at: string;
    accepted_ce_ids?: string[];
    addressed_ce_fingerprints?: string[];
  }[];
  /**
   * One entry per conceptual-design-critique-driven design repair (keyed by
   * critique hash). `blocking_ids` records the blocking critique-item ids the
   * repair was dispatched to address — the cumulative union is the
   * "already-addressed" set the critique convergence gate diffs each fresh
   * critique against, so a re-raised (un-resolved) blocking concern is detected
   * as a stall rather than silently re-repaired forever.
   */
  critique_repairs: { critique_hash: string; at: string; blocking_ids: string[] }[];
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
      critique_repairs: [],
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
   * Session config for the parallel per-module wave scheduler (DC-3). Optional:
   * when omitted it is loaded from `<root>/session-config.json`, so the wave cap
   * is derived from the SAME quota/host machinery (`scheduleWave`) implement
   * dispatch uses. Threaded explicitly only so tests can inject it deterministically.
   */
  sessionConfig?: SessionConfig | null;
  /**
   * Whether the host can dispatch independent sub-agents. Threaded from the
   * resolved `host_can_dispatch_subagents` handshake (`resolveHostDispatchCapability`),
   * NOT a manual flag. The adversarial 'critique' / 'critic' phase prompts MANDATE
   * an independent sub-agent reviewer when true and degrade to inline self-review
   * when false. Fail-safe: when omitted, the mandate is rendered.
   */
  hostCanDispatchSubagents?: boolean;
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
  | { kind: "escalate"; reason: "stall" | "runaway"; outstanding: string[]; note: string }
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

  const repairState = await readRepairState(artifactsDir);
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

  const acceptedIds = acceptedCeIdsOf(judge);

  // Content-fingerprint keying (not raw id): two independent adversarial
  // rounds may each label their genuinely-distinct top counterexample with
  // the SAME reviewer id string (e.g. "CE-001", the prompt schema's own
  // example value). Keying convergence on the raw id would then read "same CE
  // re-accepted after a repair" and falsely escalate while a real new defect
  // is being correctly repaired. Resolve each accepted id against the live
  // counterexample artifact and key on content instead; an id with no
  // matching counterexample falls back to raw-id keying — today's behavior —
  // so nothing regresses when content can't be resolved.
  const cePayload = envelopePayload(
    await readContractArtifact(artifactsDir, "counterexample"),
  ) as CounterexampleReport | undefined;
  const ceById = new Map(
    (cePayload?.counterexamples ?? []).map((ce) => [ce.id, ce] as const),
  );
  const keyOf = (rawId: string): string => {
    const ce = ceById.get(rawId);
    return ce ? `fp:${counterexampleFingerprint(ce)}` : `id:${rawId}`;
  };

  const addressed = new Set(
    repairState.repairs.flatMap(
      (r) =>
        r.addressed_ce_fingerprints ??
        (r.accepted_ce_ids ?? []).map((id) => `id:${id}`),
    ),
  );
  const newAccepted = acceptedIds.filter((id) => !addressed.has(keyOf(id)));
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
      outstanding: acceptedIds,
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
    outstanding: acceptedIds,
    note: `The judge re-accepted counterexample(s) that a prior repair already addressed (${acceptedIds.join(", ") || "none newly accepted"}), with no new accepted counterexample this round. The repair loop is not converging on these items. Resolve them with the user — adjust the contract design or accept the counterexamples as known limitations — before the plan can be promoted.`,
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
 * null when the structural floor is clean. Each underlying validator is tolerant
 * of an absent input, so this is safe to call at the critic boundary.
 */
export async function evaluatePreCriticStructuralGate(
  artifactsDir: string,
): Promise<{ phase: "contract_finalization" | "test_validator_plan"; errorLines: string[] } | null> {
  const obligationLedger = envelopePayload(
    await readContractArtifact(artifactsDir, "obligation_ledger"),
  );
  const testValidatorPlan = envelopePayload(
    await readContractArtifact(artifactsDir, "test_validator_plan"),
  );
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

  // Upstream-owned checks first: a derivation/coverage gap is fixed in the
  // finalized contracts (the obligation ledger is derived from them).
  const designErrors = [
    ...validateReconciliationDerivation(seamReport, finalizedContracts),
    ...validateDigestCoverage(sourceType, findingEnumeration, obligationLedger),
  ].filter((issue) => issue.severity === "error");
  if (designErrors.length > 0) {
    return {
      phase: "contract_finalization",
      errorLines: designErrors.map((issue) => `- [${issue.path}] ${issue.message}`),
    };
  }

  // A testable obligation without a paired spec is fixed in the test plan
  // (skeleton-scaffolded from the derived ledger).
  const testErrors = validatePairedObligations(obligationLedger, testValidatorPlan).filter(
    (issue) => issue.severity === "error",
  );
  if (testErrors.length > 0) {
    return {
      phase: "test_validator_plan",
      errorLines: testErrors.map((issue) => `- [${issue.path}] ${issue.message}`),
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
  const result = validateContractCitationGrounding(citations, repoRoot);
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
  const result = validateContractCitationGrounding(findings, repoRoot);
  const errors = result.issues.filter((issue) => issue.severity === "error");
  if (errors.length === 0) return null;
  return { violations: errors.map((issue) => `[${issue.path}] ${issue.message}`) };
}

// ── DC-3: parallel per-module contract drafting ───────────────────────────────
//
// `module_contract_drafting` (→ module_contracts) aggregates a `module_contracts[]`
// array keyed by module name. DC-3 fans it out to ONE agent per module through the
// shared wave scheduler (`scheduleWave`, the SAME quota/host machinery implement
// dispatch uses), replacing the former single sequential agent — each agent reads
// its own module's file scope, so no single agent owns both sides of a seam. Each
// agent writes a per-module SHARD; the orchestrator merges all shards into the
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

  // Adversarial-depth dial (T1 slices 3/4): derive the depth for the critique /
  // critic phases from the intake risk signal, escalating on decomposition
  // evidence. Extracted to resolveAdversarialDepth (behavior-preserving). The
  // (possibly raised) riskSignal is also consumed by the granularity-collapse
  // gate below, so it is returned alongside the depth.
  const { riskSignal, adversarialDepth } = await resolveAdversarialDepth(artifactsDir);

  // Detect the path-A seed file: present only for structured_audit runs.
  const seedPath = pathASeedFilePath(artifactsDir);
  const pathASeedPath = existsSync(seedPath) ? seedPath : undefined;

  // Resolve artifact paths for the prompt renderers. The host's world is the
  // plain INPUT files (D3): every host-facing path — both where a role WRITES its
  // output and where it READS its upstreams — is `<name>.input.json`. The tool's
  // canonical envelopes (`<name>.json`) are derived at ingest and never named to
  // the host.
  const artifactPaths: Partial<Record<ContractPipelineArtifactName, string>> = {};
  for (const name of CP_ARTIFACT_NAMES) {
    artifactPaths[name] = contractInputFilePath(artifactsDir, name);
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
      hostCanDispatchSubagents: options.hostCanDispatchSubagents,
      adversarialDepth,
    });
    return buildStep({
      prompt: extraSection ? `${rendered.prompt}\n${extraSection}` : rendered.prompt,
      outputPath: rendered.outputPath,
      stopCondition: `Stop after writing the contract-pipeline output for phase "${phase}" and running next-step.`,
    });
  };

  // T1 slice 4b: emit ONE round-trip whose prompt concatenates the rendered
  // specs of several consecutive authoring phases. The worker writes every
  // named artifact top-down (each later phase's inputs are the files it wrote in
  // the earlier sections of the same round-trip), then runs next-step once. The
  // group header overrides the per-section "stop after writing" lines so they are
  // not read as three separate stop points.
  const buildCollapsedFramingStep = (
    phases: string[],
  ): Promise<RemediationStep> => {
    const sections = phases.map((phase) => {
      const rendered = renderContractPipelinePrompt({
        role: phase,
        artifactPaths,
        sourcePaths,
        repoRoot: root,
        pathASeedPath,
        hostCanDispatchSubagents: options.hostCanDispatchSubagents,
        adversarialDepth,
      });
      return { phase, rendered };
    });
    const outputPaths = sections.map((s) => s.rendered.outputPath);
    const header = `# Collapsed Authoring Round-Trip — ${phases.length} Phases

This is a low-complexity change, so these ${phases.length} coherent authoring phases are combined into a SINGLE round-trip. Complete EVERY section below — author them top-down, writing each artifact to its named path (each later section's inputs are the files you write in the earlier sections of this same round-trip). Then run next-step ONCE.

Treat any per-section "Stop after writing the output file / do not advance" instruction as scoped to that section only — it does NOT mean stop the round-trip. Finish all sections first.

If you cannot complete a section (an artifact would be malformed), write the ones you can and run next-step: the pipeline re-emits any missing or invalid artifact as its own fine-grained step, so no work is lost.

Artifacts to produce (in order):
${outputPaths.map((p, i) => `${i + 1}. \`${p}\` (${phases[i]})`).join("\n")}`;
    const body = sections
      .map((s) => `\n---\n\n${s.rendered.prompt}`)
      .join("\n");
    return buildStep({
      prompt: `${header}\n${body}`,
      outputPath: outputPaths[outputPaths.length - 1],
      stopCondition: `Stop after writing all ${phases.length} collapsed-framing artifacts (${phases.join(", ")}) and running next-step once.`,
    });
  };

  const buildParallelModuleWaveStep = async (
    phase: ParallelModulePhase,
  ): Promise<RemediationStep> => {
    // DC-3: fan the phase out to ONE agent per module, concurrency-capped by the
    // shared wave scheduler (the same quota/host machinery implement dispatch
    // uses). Each agent writes a per-module shard; the orchestrator merges the
    // shards into the aggregated artifact on the next next-step (see the
    // module-shard-merge intercept), guaranteeing completeness before any
    // downstream derivation. A degenerate decomposition (zero or one module)
    // has no parallelism to exploit — fall back to the single aggregated step.
    const modules = await readDecomposedModules(artifactsDir);
    if (modules.length <= 1) {
      return buildPhaseStep(phase);
    }

    // Concurrency cap from the shared scheduler: session config is loaded from
    // the same path decideNextStep uses, env + on-disk learned quota feed the
    // same wave-sizing implement dispatch consumes. itemCount = module count.
    // scheduleWave sizes concurrency from dispatch fields, so load the effective config
    // through the single remediate loader (always the ambient descriptor — see there).
    const sessionConfig = await loadRemediateSessionConfig({
      root,
      override: options.sessionConfig,
      artifactsFirst: false,
    });
    const schedule: WaveScheduleResult = await scheduleWave({
      sessionConfig: sessionConfig ?? null,
      itemCount: modules.length,
      env: process.env,
    });
    const maxConcurrent = schedule.max_concurrent;

    const inputArtifact = "module_decomposition";
    const inputPaths = (
      ["goal_spec", "context_bundle", "module_decomposition"] as const
    ).map((key) => `- \`${artifactPaths[key]}\` (${key})`);

    const moduleLines = modules
      .map((mod, i) => {
        const shardPath = moduleShardPath(artifactsDir, phase, mod.name);
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

    const cwdNote = `\n> Set the shell/tool working directory to \`${root}\` before running any commands.\n`;
    const nextCommand = loaderCommand("next-step");
    const prompt = `# Per-Module Contract Drafting — Parallel Wave (${modules.length} modules)

This phase fans out to ONE sub-agent PER MODULE. Dispatch the ${modules.length} modules below as parallel sub-agents in waves of at most **${maxConcurrent}** concurrent agents (the quota/host concurrency cap). Each sub-agent reads only its module's file scope, then writes ONLY that module's contract shard — no agent owns both sides of a seam, and no agent writes the aggregated artifact.
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

    const stepArtifactPaths: Record<string, string> = {};
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
      stopCondition: `Stop after writing every per-module shard for phase "${phase}" and running next-step.`,
      artifactPaths: stepArtifactPaths,
    });
  };

  /**
   * DC-3 merge intercept: when a parallel phase's aggregated artifact is still
   * missing, merge the per-module shards into it once they are ALL present. A
   * missing shard re-emits the wave (never promotes a partial aggregate). After
   * a complete merge the artifact is written enveloped and the pipeline
   * re-derives; the existing seam_reconciliation / critique pass downstream
   * stays the consistency gate over the merged contracts.
   */
  const tryMergeModuleShards = async (
    phase: ParallelModulePhase,
  ): Promise<RemediationStep | "merged" | "incomplete"> => {
    const modules = await readDecomposedModules(artifactsDir);
    // Degenerate decompositions never used the shard path — let the normal
    // single-agent aggregate step handle them.
    if (modules.length <= 1) return "incomplete";

    const scan = await scanModuleShards(artifactsDir, phase, modules);
    if (scan.missing.length > 0) {
      // Completeness not met → re-emit the wave for the missing modules.
      return buildParallelModuleWaveStep(phase);
    }

    // goal_id: the upstream module_decomposition is authoritative (every artifact
    // shares one goal_id; the goal-ID consistency gate enforces it). Fall back to
    // a shard's goal_id only if the decomposition somehow lacks one.
    const decompositionGoalId = await readDecompositionGoalId(artifactsDir);
    const goalId =
      decompositionGoalId ||
      [...scan.present.values()]
        .map((c) => (typeof c.goal_id === "string" ? c.goal_id : undefined))
        .find((g): g is string => Boolean(g)) ||
      "";

    const merged = mergeModuleShards(modules, scan.present, goalId);
    await writeContractArtifact(artifactsDir, PARALLEL_MODULE_PHASES[phase], merged);
    return "merged";
  };

  // 1. Ingest raw worker outputs into validated envelopes. An output that
  //    fails validation is archived and its producing phase re-emitted with
  //    the validation errors — LLM output is untrusted until validated.
  const ingestion = await ingestContractArtifacts(artifactsDir);
  if (ingestion.invalid.length > 0) {
    const first = ingestion.invalid[0];
    const archived = await archiveContractArtifact(artifactsDir, first.name, "invalid");
    const phase = ARTIFACT_TO_PHASE[first.name] ?? "goal_normalization";
    return buildPhaseStep(
      phase,
      `## Validation Errors From the Previous Attempt

The previous \`${first.name}\` output failed validation and was archived. Fix every issue below in the rewritten output:

${formatValidationIssues(first.issues)}
${rejectionRewriteInstruction(archived)}`,
    );
  }

  // 2. Archive stale artifacts so the staleness DAG re-derives everything
  //    downstream of a repaired (re-ingested) upstream artifact.
  const staleness = await detectStaleArtifacts(artifactsDir);
  for (const name of staleness.stale) {
    await archiveContractArtifact(artifactsDir, name, "stale");
  }

  // 2a. OBL-m-friction-inv-5 (post_repair_rederive): when a judge needs_repair →
  //     regenerate-target landed, the re-ingested target makes its downstream
  //     artifacts stale and they are archived above — the REAL remediate
  //     post-repair re-derive site (judge → repair target → back-half re-derive).
  //     Route this backend-observed step-boundary fact through the single CE-005
  //     chokepoint. Discriminator = repair target artifact id + repair iteration
  //     count (there is no RepairOutcome.attempt in remediate), so re-recording
  //     the same re-derive is a collision-free no-op (CE-006).
  if (staleness.stale.length > 0) {
    const repairState = await readRepairState(artifactsDir);
    const lastRepair = repairState.repairs[repairState.repairs.length - 1];
    if (lastRepair) {
      const iteration = repairState.repairs.length;
      await captureStepBoundaryFriction(
        artifactsDir,
        runId,
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
      const archived = await archiveContractArtifact(artifactsDir, mismatchedArtifact, "invalid");
      return buildPhaseStep(
        phase,
        `## Goal-ID Consistency Error

Every contract-pipeline artifact must share the same goal_id. The following mismatch was detected:

${goalIdErrors.map((i) => `- [${i.path}] ${i.message}`).join("\n")}

Rewrite the output so its goal_id matches the goal_id established in goal_spec.json.
${rejectionRewriteInstruction(archived)}`,
      );
    }
  }

  // 2.6. Conceptual-design-critique gate (A1). Once the critique exists, a
  //      blocking concern routes a design repair BEFORE any downstream artifact
  //      is derived — closing the gap where a `blocking` item inside a
  //      non-`rejected` verdict (and even a bare `rejected` verdict) silently
  //      proceeded because only the judge verdict was ever consumed. The signal
  //      is mechanical (any blocking item), so the author's verdict label can't
  //      wave a blocking concern through. Convergence-terminated: repairing the
  //      finalized contracts re-stales + re-emits the critique, a clean
  //      re-critique proceeds, a stalled loop escalates to the user.
  if (contractArtifactExists(artifactsDir, "conceptual_design_critique")) {
    const gate = await evaluateCritiqueGate(artifactsDir);
    if (gate.kind === "repair") {
      const repairState = await readRepairState(artifactsDir);
      const critiqueRepairs = repairState.critique_repairs ?? [];
      if (!critiqueRepairs.some((r) => r.critique_hash === gate.critiqueHash)) {
        critiqueRepairs.push({
          critique_hash: gate.critiqueHash,
          at: new Date().toISOString(),
          blocking_ids: gate.blockingIds,
        });
        repairState.critique_repairs = critiqueRepairs;
        await writeRepairState(artifactsDir, repairState);
      }
      const rendered = renderContractRepairPrompt({
        target: "finalized_module_contracts",
        instruction:
          "Revise the design to resolve every BLOCKING concern in the conceptual design critique " +
          `(${gate.blockingIds.join(", ")}). Read conceptual_design_critique.json for each concern's ` +
          "description, then rewrite the finalized module contracts so the blocking concerns no longer apply.",
        artifactPaths,
        repoRoot: root,
      });
      return buildStep({
        prompt: rendered.prompt,
        outputPath: rendered.outputPath,
        stopCondition:
          "Stop after rewriting finalized_module_contracts to resolve the blocking critique concerns and running next-step.",
      });
    }
    if (gate.kind === "escalate") {
      await captureStepBoundaryFriction(
        artifactsDir,
        runId,
        {
          eventType: "repair_round",
          discriminator: `critique_nonconvergence:${gate.reason}`,
          note: `Conceptual-design critique↔repair loop escalated (${gate.reason}): ${gate.note}`,
          category: "trap",
        },
        "remediate-code",
      );
      return writeCurrentStep({
        stepKind: CONTRACT_STEP_KIND,
        status: "blocked",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `# Conceptual-Design Critique Did Not Converge

${gate.note}

## Outstanding blocking concerns

${gate.blocking.map((id) => `- ${id}`).join("\n")}

Read conceptual_design_critique.json, decide with the user how to resolve each blocking concern (revise the contract design and re-run, or downgrade it to advisory), then re-run next-step.`,
        allowedCommands: [],
        stopCondition:
          "Stop — the contract pipeline is blocked on a non-converging conceptual-design critique pending a user decision.",
      });
    }
    // gate.kind === "proceed": fall through.
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

  // 2.8. Degenerate seam_reconciliation collapse. A single-module decomposition
  //      has NO inter-module seams, so seam_reconciliation is a structural no-op:
  //      write an empty seam report deterministically (no host round-trip),
  //      mirroring the obligation_ledger / cyclic_seam no-op fast paths. The empty
  //      report makes validateReconciliationDerivation pass vacuously. A
  //      multi-module decomposition falls through to the LLM seam_reconciliation
  //      step (which mismatches exist is a judgment call).
  if (nextPhase === "seam_reconciliation") {
    const modules = await readDecomposedModules(artifactsDir);
    if (modules.length <= 1) {
      const drafted = envelopePayload(
        await readContractArtifact(artifactsDir, "module_contracts"),
      );
      const goalId =
        isRecord(drafted) && typeof drafted.goal_id === "string" ? drafted.goal_id : "";
      await writeContractArtifact(artifactsDir, "seam_reconciliation_report", {
        contract_version:
          "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
        goal_id: goalId,
        mismatches: [],
        created_at: new Date().toISOString(),
      });
      return buildNextContractPipelineStep(options);
    }
  }

  // 2.9. Deterministic contract_finalization (all module counts). Finalization is
  //      a mechanical merge, not fresh authoring: carry each drafted module
  //      contract verbatim (preserving neighbor_needs for the ordering derivation)
  //      and attach the agreed_interface of every seam that touches the module as a
  //      seam_adjustment. The tool derives it instead of dispatching a per-module
  //      LLM wave — the judgment already happened at seam_reconciliation. Attaching
  //      each agreed interface verbatim guarantees the INV-CO-12 reconciliation-
  //      derivation gate passes. A downstream gate that still finds the merge
  //      inadequate (e.g. a draft with empty inputs/outputs, or a seam naming a
  //      module out of scope) re-emits contract_finalization as an LLM step via
  //      buildPhaseStep — the only path that still needs judgment.
  if (nextPhase === "contract_finalization") {
    const drafted = envelopePayload(
      await readContractArtifact(artifactsDir, "module_contracts"),
    );
    const seamReport = envelopePayload(
      await readContractArtifact(artifactsDir, "seam_reconciliation_report"),
    );
    const finalized = deriveFinalizedModuleContracts(drafted, seamReport);
    await writeContractArtifact(artifactsDir, "finalized_module_contracts", finalized);
    return buildNextContractPipelineStep(options);
  }

  // 3. Judge gate: implementation planning is reachable only through an approved
  //    verdict (the fixpoint) or a convergent targeted repair. A stalled /
  //    non-converging repair loop escalates to the user (blocked) instead of
  //    silently proceeding with residual risk.
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
          accepted_ce_ids: gate.acceptedCeIds,
          addressed_ce_fingerprints: gate.addressedCeFingerprints,
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
    if (gate.kind === "escalate") {
      // Non-convergence (stall or runaway backstop): surface it to the user
      // loudly rather than promoting a plan over an un-converged contract. The
      // outstanding accepted counterexamples are named so the user can resolve
      // them (revise the contract design or accept them as known limitations).
      await captureStepBoundaryFriction(
        artifactsDir,
        runId,
        {
          eventType: "repair_round",
          discriminator: `judge_nonconvergence:${gate.reason}`,
          note: `Judge↔repair loop escalated (${gate.reason}): ${gate.note}`,
          category: "trap",
        },
        "remediate-code",
      );
      return writeCurrentStep({
        stepKind: CONTRACT_STEP_KIND,
        status: "blocked",
        runId,
        repoRoot: root,
        artifactsDir,
        prompt: `# Judge↔Repair Loop Did Not Converge

${gate.note}

## Outstanding accepted counterexamples

${
  gate.outstanding.length > 0
    ? gate.outstanding.map((id) => `- ${id}`).join("\n")
    : "_(none newly accepted this round)_"
}

Read the judge_report and counterexample artifacts, decide with the user how to resolve each outstanding counterexample (revise the contract design and re-run, or accept it as a known limitation), then re-run next-step.`,
        allowedCommands: [],
        stopCondition:
          "Stop — the contract pipeline is blocked on a non-converging judge↔repair loop pending a user decision.",
      });
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
      const archived = await archiveContractArtifact(artifactsDir, "implementation_dag", "invalid");
      return buildPhaseStep(
        "implementation_planning",
        `## Referential Integrity Errors From the Previous Attempt

The previous implementation_dag was rejected and archived due to referential integrity violations. Fix every issue below:

${integrityErrors.map((i) => `- [${i.path}] ${i.message}`).join("\n")}
${rejectionRewriteInstruction(archived)}`,
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
      const archived = await archiveContractArtifact(artifactsDir, "implementation_dag", "invalid");
      return buildPhaseStep(
        "implementation_planning",
        `## Traceability Errors From the Previous Attempt

The previous implementation_dag was rejected and archived. Every node must trace to at least one obligation from the obligation ledger or one judge-accepted counterexample:

${traceability.violations.map((v) => `- ${v}`).join("\n")}
${rejectionRewriteInstruction(archived)}`,
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
      const archived = await archiveContractArtifact(artifactsDir, "implementation_dag", "invalid");
      return buildPhaseStep(
        "implementation_planning",
        `## Contract-Obligation Gate Errors From the Previous Attempt

The previous implementation_dag (and/or upstream contract artifacts) failed the fail-closed contract-obligation gates. Fix every issue below before the plan can be promoted:

${obligationGate.violations.map((v) => `- ${v}`).join("\n")}
${rejectionRewriteInstruction(archived)}`,
      );
    }

    await promoteImplementationDagToExtractedPlan(artifactsDir);

    // 4d. M-B3 source-grounded citation gate (promotion backstop): ground every
    //     promoted extracted-plan finding's citations against the working tree.
    //     A finding citing only a non-existent path and no real symbol is a
    //     hallucinated citation; re-emit implementation_planning (bounded by the
    //     same dag_regenerations cap). Fail-closed only on an unreadable tree.
    const citationGate = await evaluatePromotedPlanCitationGrounding(artifactsDir, root);
    if (citationGate) {
      // Grounding failed: the plan was promoted to extracted-plan.json BEFORE this
      // gate ran, so the ungrounded marker is now on disk. Remove it before any
      // return — otherwise a subsequent next-step reads the promoted plan via
      // readExtractedPlanIfPresent and hands it straight to handlePendingExtractedPlan,
      // bypassing the re-emit and completing the pipeline on hallucinated citations.
      // No pipelineComplete unless the promoted plan grounds.
      await rm(intakePaths(artifactsDir).extractedPlan, { force: true });
      const repairState = await readRepairState(artifactsDir);
      if (repairState.dag_regenerations.length >= MAX_DAG_REGENERATION_ATTEMPTS) {
        return writeCurrentStep({
          stepKind: CONTRACT_STEP_KIND,
          status: "blocked",
          runId,
          repoRoot: root,
          artifactsDir,
          prompt: `# Citation Grounding Failed ${repairState.dag_regenerations.length + 1} Times

The promoted plan repeatedly cites components that do not exist in the working tree:

${citationGate.violations.map((v) => `- ${v}`).join("\n")}

Report this to the user and stop. The contract pipeline cannot promote a plan whose findings cite non-existent files or symbols; the run needs a corrected implementation_dag.
`,
          allowedCommands: [],
          stopCondition: "Stop after reporting the citation-grounding failure to the user.",
        });
      }
      repairState.dag_regenerations.push({
        violations: citationGate.violations,
        at: new Date().toISOString(),
      });
      await writeRepairState(artifactsDir, repairState);
      const archived = await archiveContractArtifact(artifactsDir, "implementation_dag", "invalid");
      // The grounding-driven re-emit is a backend-observed step-boundary fact:
      // route it through the single CE-005 chokepoint as phase_reemit.
      await captureStepBoundaryFriction(
        artifactsDir,
        runId,
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
      return buildPhaseStep(
        "implementation_planning",
        `## Source-Grounded Citation Gate Errors From the Previous Attempt

The previous implementation_dag produced findings that cite components not present in the working tree. Every cited path or symbol must point at something real:

${citationGate.violations.map((v) => `- ${v}`).join("\n")}
${rejectionRewriteInstruction(archived)}`,
      );
    }

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

To proceed, manually rewrite \`${contractInputFilePath(artifactsDir, "obligation_ledger")}\` so that no circular \`depends_on\` references exist, then delete \`${contractInputFilePath(artifactsDir, "cyclic_seam_resolution")}\` and \`${cyclicSeamRepairStatePath(artifactsDir)}\` and re-run next-step.

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

    const outputPath = contractInputFilePath(artifactsDir, "cyclic_seam_resolution");
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

- \`${contractInputFilePath(artifactsDir, "obligation_ledger")}\` (obligation_ledger)

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
  "status": "resolved"
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
    // 5a. Design-spec structural gates on the finalized_module_contracts (the
    //     "design" artifact) + obligation_ledger run first: a malformed design
    //     artifact (error) re-emits the design phase, and a circular-obligation
    //     dependency (warning) is appended to the critic prompt as advisory.
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

    // 5b. Pre-adversarial structural floor (S5): once the design artifact itself
    //     is clean, run the cheap cross-artifact checks whose inputs all exist by
    //     the critic phase (paired-obligation coverage, source-scoped digest
    //     coverage, seam reconciliation derivation) so the adversarial loop only
    //     ever sees structurally-sound obligations/tests/contracts, and a gap is
    //     re-emitted to the precise responsible phase instead of being discovered
    //     at promotion after the adversarial budget is spent. evaluateContract
    //     ObligationsPromotionGate stays the fail-closed backstop at promotion.
    const preCriticGate = await evaluatePreCriticStructuralGate(artifactsDir);
    if (preCriticGate) {
      return buildPhaseStep(
        preCriticGate.phase,
        `## Pre-Adversarial Structural Gate Errors

The ${preCriticGate.phase} output failed deterministic structural gates. Fix every issue below before adversarial review begins:

${preCriticGate.errorLines.join("\n")}
`,
      );
    }

    // 5c. M-B3 source-grounded citation gate (pre-critic boundary): ground the
    //     module_decomposition's file_scope citations against the working tree
    //     before the adversarial loop. A module citing only a non-existent path
    //     and no real symbol is re-emitted to the `decomposition` phase — the
    //     phase that OWNS file_scope (the finalized contracts carry interface
    //     fields, not paths, so re-emitting contract_finalization could never
    //     change file_scope and an ungrounded scope would loop forever). The
    //     grounding-driven re-emit is a backend-observed step-boundary fact routed
    //     through the single CE-005 chokepoint as phase_reemit.
    const preCriticCitationGate = await evaluatePreCriticCitationGrounding(
      artifactsDir,
      root,
    );
    if (preCriticCitationGate) {
      await captureStepBoundaryFriction(
        artifactsDir,
        runId,
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
      return buildPhaseStep(
        "decomposition",
        `## Source-Grounded Citation Gate Errors

A module's file_scope cites a component that does not exist in the working tree. file_scope lives in the module decomposition (the finalized contracts carry interface fields, not paths), so fix the offending path(s) in the decomposition — every cited path or symbol must point at something real before adversarial review begins:

${preCriticCitationGate.errorLines.join("\n")}
`,
      );
    }
  }

  // Parallel-capable phase (DC-3): module_contract_drafting fans out to one agent
  // per module. The aggregated `module_contracts` artifact is missing here, so
  // first try to merge per-module shards (the worker may have just written them) —
  // a COMPLETE shard set merges into the aggregated artifact and the pipeline
  // re-derives; an incomplete set re-emits the wave; a degenerate (≤1 module)
  // decomposition falls through to a single aggregated step. The seam_reconciliation
  // / contract_finalization / critique pass downstream remains the consistency gate
  // over the merged contracts.
  if (isParallelModulePhase(nextPhase)) {
    const mergeOutcome = await tryMergeModuleShards(nextPhase);
    if (mergeOutcome === "merged") {
      return buildNextContractPipelineStep(options);
    }
    if (mergeOutcome !== "incomplete") {
      // A re-emitted wave step (missing shards).
      return mergeOutcome;
    }
    return buildParallelModuleWaveStep(nextPhase);
  }

  // Auto-phasing (T3): at the conceptual-design critique, hand the critic the
  // tool-DERIVED phase cut so it assesses design quality WITHIN a mechanically
  // dependency-ordered foundations→consumers phasing, instead of rejecting an
  // arbitrary N-goal change as "over-scoped" and forcing the host to re-scope by
  // hand at intake. The cut is derived deterministically from the finalized module
  // contracts' directional neighbor_needs edges (present by the critique phase) and
  // PERSISTED as the `phase_cut.json` sidecar here, so the cut the critic sees and
  // the cut the implementation-DAG promotion enforces are one source. Only injected
  // into the prompt when there is a genuine multi-phase cut to communicate.
  if (nextPhase === "critique") {
    const cut = await ensurePhaseCutArtifact(artifactsDir);
    if (cut && cut.phases.length > 1) {
      const reReview = await buildReReviewSection(nextPhase, artifactsDir);
      const phaseCutSection = renderPhaseCutSection(cut);
      return buildPhaseStep(
        "critique",
        reReview ? `${phaseCutSection}\n${reReview}` : phaseCutSection,
      );
    }
  }

  // Granularity collapse (T1 slice 4b): for low-complexity work, fold the framing
  // suffix [nextPhase..decomposition] into ONE round-trip producing several
  // artifacts, instead of one gated step per phase. Reads the POST-escalation
  // riskSignal (slice 4a may have already raised the tier above), so the dial is
  // never frozen at run start — `fine` for medium/high keeps full per-phase
  // isolation. Only collapses a genuine multi-phase suffix; a single trailing
  // framing phase falls through to the normal per-phase dispatch below.
  if (
    nextPhase &&
    roundTripGranularityForTier(riskSignal?.tier) === "collapsed" &&
    (FRAMING_COLLAPSE_GROUP as readonly string[]).includes(nextPhase)
  ) {
    const startIdx = FRAMING_COLLAPSE_GROUP.indexOf(
      nextPhase as (typeof FRAMING_COLLAPSE_GROUP)[number],
    );
    const suffix = FRAMING_COLLAPSE_GROUP.slice(startIdx);
    if (suffix.length > 1) {
      return buildCollapsedFramingStep([...suffix]);
    }
  }

  // Skeleton-scaffolded phases (S3): the tool pre-fills structure/ids from the
  // derived obligation ledger so the worker fills only the judgment slots.
  if (nextPhase === "test_validator_plan" || nextPhase === "implementation_planning") {
    const scaffold = await buildScaffoldSection(nextPhase, artifactsDir);
    return buildPhaseStep(nextPhase, scaffold);
  }

  // Diff-based re-review (B2): when a verdict-bearing review phase is re-emitted
  // because an upstream changed, hand the worker its prior verdict + the precise
  // changed-since-last-review delta so it re-affirms cheaply or revises only the
  // affected items — never a blind full re-run. The section appears only when a
  // prior snapshot exists (i.e. this is a re-review, not first authoring).
  const reReviewSection = await buildReReviewSection(nextPhase, artifactsDir);
  return buildPhaseStep(nextPhase, reReviewSection);
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
  // module(s) its obligations belong to. (Declared files still win when present.)
  const decomposedModules = await readDecomposedModules(artifactsDir);
  // Sorted longest-slug-first so an obligation id resolves to its OWNING module by
  // longest-`OBL-<slug>-`-prefix match — the same resolution phaseCut uses, so a
  // shorter slug that prefixes another module's slug never mis-claims its files.
  const moduleScopesBySlug = decomposedModules
    .map((m) => ({ slug: moduleSlug(m.name), files: m.file_scope }))
    .sort((a, b) => b.slug.length - a.slug.length);
  const deriveNodeFiles = (node: {
    output_files?: string[];
    files_likely_touched?: string[];
    satisfies_obligations?: string[];
    verification_obligation_ids?: string[];
  }): string[] => {
    const declared = [...new Set(node.output_files ?? node.files_likely_touched ?? [])];
    if (declared.length > 0) return declared;
    const obligationIds = [
      ...(node.satisfies_obligations ?? []),
      ...(node.verification_obligation_ids ?? []),
    ];
    const inherited = new Set<string>();
    for (const id of obligationIds) {
      const owner = moduleScopesBySlug.find((m) => id.startsWith(`OBL-${m.slug}-`));
      if (owner) for (const f of owner.files) inherited.add(f);
    }
    return [...inherited];
  };

  const nodes = Array.isArray(dag?.nodes) ? dag.nodes : [];
  const findings = nodes.map((node, index) => {
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
      // output_files (declared write scope) takes priority over files_likely_touched;
      // when the node declared neither, inherit the module file_scope (deriveNodeFiles)
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
    traceability[id] = { obligation_ids: obligationIds, node_ids: nodeIds };
  }

  const blocks = nodes.map((node, index) => {
    const nodeId = ensureNodeId(node.id, index);
    const deps = ((node as { depends_on?: string[] }).depends_on ?? []).map(
      (depId) => toBlockId(depId),
    );
    // Same derivation as the finding's affected_files: declared write scope, else
    // the module file_scope inherited via the node's obligations — so the block's
    // file-ownership scheduler never sees an empty (undispatchable) touched set.
    const touchedFiles = deriveNodeFiles(node);
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
      items: [nodeId],
      // INV-remediate-pipeline-02: a block with prerequisites is never
      // wave-dispatched as independent — parallel_safe derives from depends_on.
      parallel_safe: deps.length === 0,
      dependencies: deps,
      // touched_files is REQUIRED on the block contract; promote the node's
      // declared write scope so the file-ownership scheduler can read it.
      touched_files: touchedFiles,
      ...(phaseOrdinal !== undefined ? { phase_ordinal: phaseOrdinal } : {}),
      ...(node.targeted_commands && node.targeted_commands.length > 0
        ? { targeted_commands: [...node.targeted_commands] }
        : {}),
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

// ── Lean-path extracted plan (the `low` risk tier's plan emission) ────────────
//
// The heavy pipeline above derives its `extracted-plan.json` from the adversarial
// DAG (`source: "contract_pipeline"`). The `low` risk tier skips that design loop
// (its findings are a handful of concrete, already-grounded fixes) and emits this
// lean sibling instead, tagged `source: "lean_fast_path"` so the two producers are
// distinguished at the artifact level. Both rejoin the SAME plan→implement→close
// machinery — `normalizeExtractedPlan` synthesizes one block per finding and
// `applyPlanPipeline` merges blocks sharing a file + splits by context budget, so
// block derivation is single-sourced, not reimplemented here. The retained safety
// net (grounding re-pass, affected-file hash snapshot, per-node verify-before-merge,
// final whole-repo gate) still runs; only the adversarial DESIGN loop + obligation
// derivation are dropped. (Relocated from the retired `steps/leanFastPath.ts` — DD-21.)

/** Source tag stamped on a lean-fast-path extracted plan (distinguishes it from `contract_pipeline`). */
export const LEAN_FAST_PATH_SOURCE = "lean_fast_path";

/** The minimal `extracted-plan.json` shape the lean path emits. */
export interface LeanExtractedPlan {
  plan_id: string;
  findings: Finding[];
  project_type: string;
  source: typeof LEAN_FAST_PATH_SOURCE;
  candidate_closing_actions: string[];
}

/**
 * Build the lean extracted plan from the approved findings. Blocks are
 * intentionally omitted: `normalizeExtractedPlan` synthesizes one block per
 * finding and `applyPlanPipeline` then merges blocks sharing a file + splits by
 * context budget — the same deterministic block derivation the contract pipeline
 * feeds into, single-sourced rather than reimplemented here.
 */
export function buildLeanExtractedPlan(
  findings: Finding[],
  planId: string,
): LeanExtractedPlan {
  return {
    plan_id: planId,
    findings,
    project_type: "unknown",
    source: LEAN_FAST_PATH_SOURCE,
    candidate_closing_actions: ["none"],
  };
}
