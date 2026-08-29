import { loadRemediateSessionConfig } from "./sessionConfigLoad.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StateStore, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  RemediationBlock,
  RemediationItemState,
  RemediationPlan,
} from "../state/types.js";
// IO / validation / rendering helpers
import {
  discardOnSchemaVersionMismatch,
  readOptionalJsonFile,
  stagedAndUntracked,
  writeJsonFile,
  writeTextFile,
  buildAuditDeliverablePair,
  formatValidationIssues,
  isRecord,
  withFsRetry,
  RunLogger,
  coerceJsonObjectArg,
  headCommit,
  projectAuditFindingsReportSubset,
  // obligation engine + intent
  interpretFreeFormIntent,
  interpretIntent,
  unresolvedFromClauses,
  advance,
  describeStoppedFold,
  decideFrictionTriage,
  buildFrictionTriageBlock,
  linkFrictionRunIds,
  // domain constants
  LENSES,
  SEVERITIES,
  // types
  type ConstraintClauseRecord,
  type FrictionTriageDecision,
  type ObligationDef,
  type ObligationOutcome,
  type StoppedFoldDescription,
  type InterpretedIntent,
  type SessionIntentLoadResult,
} from "audit-tools/shared";
import type { CoverageLedger } from "../state/types.js";
import { applyPlanPipeline, buildCoverageLedger } from "../phases/plan.js";
import {
  groundExtractedFindings,
  type ExtractedFindingGrounding,
} from "../phases/grounding.js";
import { runTriagePhase } from "../phases/triage.js";
import { runClosePhase } from "../phases/close.js";
import { validateRemediationPlan } from "../validation/remediationState.js";
import {
  readExtractedPlanIfPresent,
} from "./dispatch.js";
import {
  ingestRemediationHostResults,
  hostDependencyLevels,
  precomputeRecoveryTestVerdicts,
  prepareRemediationHostHandoff,
  type CurrentRemediationHostState,
  type RemediationHostIngestSummary,
} from "./dispatch/hostHandoff.js";
import {
  FileLockTimeoutError,
  withFileLock,
} from "../../shared/io/fileLock.js";
import {
  AUDIT_FINDINGS_FILENAME,
  AUDIT_REPORT_FILENAME,
  auditArtifactsDir,
  auditFindingsPath,
  auditReportPath,
  promotedAuditFindingsPath,
  promotedAuditReportPath,
  remediationArtifactsDir,
} from "../../shared/io/auditToolsPaths.js";
import {
  callerWorkingDirectory,
  discoverRepoRoot,
  resolveRepoRoot,
} from "../../shared/io/repoRoot.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { RemediationStep } from "./types.js";
import {
  dependencyAwaitingClarification,
  dependencyVerifiedComplete,
} from "./stepUtils.js";
import {
  isTerminalStatus,
  isVerifiedCompleteStatus,
} from "../state/itemStatus.js";
import {
  deduplicateCrossLensFindings,
  fixupBlocksAfterDedup,
} from "../dedup/crossLensDedup.js";
import { checkAffectedFileIntegrity } from "../utils/fileIntegrity.js";
import { applyIntentOrdering } from "../intent/intentOrdering.js";
import { resolveIntakeStep } from "./intakeResolver.js";
import {
  runToolOwnedFinalGate,
  writeFinalGateRedRecord,
  writeFinalGateOutcomeRecord,
  type FinalGateOutcomeKind,
  type GateRunner,
  type ToolOwnedFinalGateResult,
} from "./finalGate.js";
import {
  buildNextContractPipelineStep,
  shouldEnterContractPipeline,
  writePathASeedFromFindings,
} from "./contractPipeline.js";
import {
  contractArtifactExists,
  contractPipelineDir,
} from "../contractPipeline/artifactStore.js";
import {
  buildReviewRequest,
  applyReviewResolution,
  isResolutionForRequest,
  screenResolutionIds,
  REVIEW_REQUEST_SCHEMA_VERSION,
  type ReviewRequest,
  type ReviewResolution,
} from "../review/reviewGate.js";
import { buildAutonomousReviewDecision } from "../review/autonomousGate.js";
import { runFindingFilterPass, type FindingFilterResult } from "../findingFilter.js";
import {
  intakePaths,
  isIntakeReady,
  manifestIsInputBound,
  readIntakeArtifacts,
  resolveManifestSources,
  type IntakeSourceManifest,
} from "../intake.js";
import {
  ensureIntakeRiskSignal,
  readIntakeRiskSignal,
  writeIntakeRiskSignal,
  escalateRiskSignal,
  findingRiskEvidence,
  distinctAffectedFiles,
} from "../riskSignal.js";
import type { IntentCheckpoint } from "audit-tools/shared";
import {
  ambiguityReviewPrompt,
  clarificationPrompt,
  collectIntakeClarificationsPrompt,
  collectStartingPointPrompt,
  loaderCommand,
  reviewApprovalPrompt,
  synthesizeIntakePrompt,
  triagePrompt,
} from "./prompts.js";

// Single-sourced prose renders of the canonical lens / severity vocabularies
// (`audit-tools/shared` `LENSES` / `SEVERITIES`) for the intent-checkpoint
// prompt copy. Previously these 11-lens / 5-severity lists were hand-copied as
// backtick-quoted literals in three places in this file and would silently drift
// from the canonical enum (the very drift `types/lens.ts` exists to prevent).
const VALID_LENSES_PROSE = LENSES.map((lens) => `\`${lens}\``).join(", ");
const VALID_SEVERITIES_PROSE = SEVERITIES.map((sev) => `\`${sev}\``).join(", ");

export interface NextStepOptions {
  root?: string;
  artifactsDir?: string;
  input?: string | string[];
  finalizeClosing?: boolean;
  forceReplan?: boolean;
  /**
   * True when this invocation supplied `--guidance-file` (folded into
   * intake/conversation-start.md before the step decision). Like a fresh
   * `--input`, a guidance file introduces NEW intake, so against a run already
   * past intake it must trip the resume-vs-restart conflict gate rather than
   * silently resuming (and executing) the old, unrelated run. Set once at the
   * bootstrap call; bare `next-step` follow-ups leave it undefined.
   */
  guidanceFileSupplied?: boolean;
  /**
   * Skip the tool-owned final completion gate (INV-RS-10) at the all-terminal
   * transition. Production never sets this; it is a test-hermeticity affordance
   * so suites that drive an unrelated flow to completion do not spawn a real
   * build. Also honored via `REMEDIATE_SKIP_FINAL_GATE`. The gate's correctness
   * is verified directly by the final-gate suites regardless of this flag.
   */
  skipFinalGate?: boolean;
  /**
   * Injectable runner for the tool-owned final gate (INV-RS-10). When set, the
   * gate uses it instead of spawning real commands, so the all-terminal
   * transition (coarse re-block / bounded terminate) can be exercised
   * deterministically in tests. Unset in production → real env-scrubbed builds.
   */
  finalGateRunner?: GateRunner;
}

const SESSION_INTENT_RESULT: unique symbol = Symbol("session-intent-result");

type InternalNextStepOptions = NextStepOptions & {
  readonly [SESSION_INTENT_RESULT]: SessionIntentLoadResult;
};

function sessionIntentResult(options: NextStepOptions): SessionIntentLoadResult {
  if (!(SESSION_INTENT_RESULT in options)) {
    throw new Error("Canonical session intent was not loaded at the next-step boundary.");
  }
  return (options as InternalNextStepOptions)[SESSION_INTENT_RESULT];
}

function randomRunId(prefix = "RUN"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRoot(root?: string): string {
  // The library-entry arm of the same two-arm resolution the CLI performs
  // (`resolveRootOption` in src/remediate/index.ts). A SUPPLIED root is honored
  // verbatim through `resolveRepoRoot` — an explicit root is an instruction, so
  // a sub-project inside a larger repo stays the sub-project — while an ABSENT
  // one is DISCOVERED from the caller's working directory rather than falling
  // back to the literal ".". The old `?? "."` made an embedded call from a
  // nested cwd root the run at that SUBDIRECTORY and fork a phantom nested
  // artifact tree there; anchoring alone could not fix it, because
  // `resolveRepoRoot` only climbs out of `.audit-tools/` and never up to the
  // owning repository. See src/shared/io/repoRoot.ts.
  return root === undefined
    ? discoverRepoRoot(callerWorkingDirectory())
    : resolveRepoRoot(root);
}

function resolveArtifactsDir(root: string, artifactsDir?: string): string {
  // The default rebases onto the anchored root via the shared helper (the sole
  // owner of the `.audit-tools/remediation` join literal); an explicit dir is
  // honored verbatim.
  return artifactsDir ? resolve(artifactsDir) : remediationArtifactsDir(root);
}

function stateRunId(state: RemediationState | null): string {
  // When the plan is absent (fully-green close deleted the state, or complete
  // was persisted without a plan), use the stable fallback "run" so the friction
  // record path is deterministic across multiple next-step calls on the same run.
  return state?.plan?.plan_id ?? "run";
}

/**
 * Where an autonomous run's LEFTOVER deliverable pair lands.
 *
 * REMEDIATION-OWNED, deliberately. This module used to write the canonical
 * `.audit-tools/audit-findings.json` + `audit-report.md` pair directly and
 * unarchived, which destroys the audit source `defaultInputCandidates` resolves
 * FIRST — the original contract becomes unrecoverable for any external consumer
 * (INV-RNF-NO-CANONICAL-PAIR-WRITE). The canonical pair belongs to
 * audit-artifact-promotion-lifecycle, whose exported write-with-archive is the
 * only sanctioned way to replace it.
 */
export function autonomousLeftoverFindingsPath(root: string): string {
  return join(remediationArtifactsDir(root), "autonomous-leftovers-findings.json");
}

export function autonomousLeftoverReportPath(root: string): string {
  return join(remediationArtifactsDir(root), "autonomous-leftovers-report.md");
}

/**
 * The intake sources a bare `next-step` discovers, IN PRIORITY ORDER — index 0
 * wins. Exported so the ordering can be asserted by CALLING it: the property
 * that matters ("a real audit always beats this run's own leftovers") is a fact
 * about the returned array, and a test that reads it out of the source text is
 * asserting the prose, not the order.
 */
export function defaultInputCandidates(root: string): string[] {
  // Prefer the canonical machine contract (audit-findings.json) over its
  // human-facing render (audit-report.md). The JSON is the source of truth on
  // both sides of the audit -> remediate pipeline, and feeding it triggers the
  // lossless structured hand-off in the plan phase instead of a lossy LLM
  // re-extraction from the markdown render that sits beside it.
  const auditDir = auditArtifactsDir(root);
  return [
    promotedAuditFindingsPath(auditDir),
    auditFindingsPath(auditDir),
    join(root, AUDIT_FINDINGS_FILENAME),
    promotedAuditReportPath(auditDir),
    auditReportPath(auditDir),
    join(root, AUDIT_REPORT_FILENAME),
    // LAST, so a real audit always wins. The autonomous leftover pair moved off
    // the canonical paths (it may no longer overwrite them), and without a
    // candidate entry the next unattended run would stop round-tripping its own
    // leftovers back through intake — the behaviour the old canonical write was
    // there to provide, kept without the destructive overwrite.
    autonomousLeftoverFindingsPath(root),
    autonomousLeftoverReportPath(root),
  ];
}

interface InputResolution {
  supplied: boolean;
  existing: string[];
  missing: string[];
  checked: string[];
  /**
   * EVERY discovered source that exists — the full context set surfaced to the
   * host, not just the single `existing[0]` the pipeline auto-selects. On the
   * no-`--input` path this is all default candidates that exist on disk; on the
   * `--input` path it equals `existing`. Used only to build the awareness
   * manifest at the discovered-sources gate; never narrows the pipeline's own
   * single-best selection (which still uses `existing`).
   */
  allExisting: string[];
}

function inputValues(input?: string | string[]): string[] {
  if (input === undefined) return [];
  return Array.isArray(input) ? input : [input];
}

function resolveInputPaths(
  root: string,
  input?: string | string[],
): InputResolution {
  const values = inputValues(input).filter((value) => value.trim().length > 0);
  if (values.length > 0) {
    // First-wins dedup by resolved absolute path so a repeated `--input`
    // (or two spellings of the same file) contributes a single source, keeping
    // input order stable for the `input-NN` manifest labels.
    const checked: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const resolved = resolve(root, value);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      checked.push(resolved);
    }
    const existing = checked.filter((candidate) => existsSync(candidate));
    return {
      supplied: true,
      existing,
      missing: checked.filter((candidate) => !existsSync(candidate)),
      checked,
      allExisting: existing,
    };
  }

  const checked = defaultInputCandidates(root);
  // Default discovery probes the same logical artifact (the audit output) in
  // several canonical locations and two formats. Select the single
  // highest-priority match — never feed both the structured contract and its
  // markdown render — so a lone .json input takes the lossless structured
  // fast-path instead of being demoted to multi-source LLM extraction.
  const allExisting = checked.filter((candidate) => existsSync(candidate));
  const best = allExisting[0];
  return {
    supplied: false,
    existing: best ? [best] : [],
    missing: [],
    checked,
    allExisting,
  };
}

/**
 * True when a supplied `--input` is the SAME input the existing run was already
 * built from (its recorded intake source manifest is input-bound — `"input"`, or
 * `"mixed"` when a guidance file rode along — with an input path set equal to the
 * supplied paths; the guidance entry is not an input, so it is excluded from the
 * comparison). The `/remediate-code` loader re-passes the same `--input` on every
 * `next-step`; treating that unchanged input as a RESUME — not an
 * `input_conflict` — spares the host a needless resume/restart ack dance, while a
 * genuinely DIFFERENT input still trips the conflict gate. Enforced in the tool,
 * never by asking the loader to remember to drop the flag (a needed manual flag
 * is a bug signal).
 */
/**
 * True when `candidatePath` (the best default-discovered input, e.g.
 * `.audit-tools/audit-findings.json`) was modified more recently than
 * `reportPath` (a leftover `remediation-report.md`). A freshly-regenerated
 * audit doc postdating the last remediation report is a NEW remediation
 * source, not evidence the old run is still "the" answer — used to stop
 * `complete_redelivery` from silently re-presenting a stale report over it.
 * Missing/unreadable files compare as "not fresher" (fail toward redelivering,
 * the pre-existing behaviour) rather than throwing.
 */
function isDefaultCandidateFresherThanReport(
  candidatePath: string | undefined,
  reportPath: string,
): boolean {
  if (!candidatePath) return false;
  try {
    return statSync(candidatePath).mtimeMs > statSync(reportPath).mtimeMs;
  } catch {
    return false;
  }
}

function suppliedInputMatchesRun(
  inputResolution: InputResolution,
  manifest: IntakeSourceManifest | undefined,
): boolean {
  if (!inputResolution.supplied) return false;
  if (!manifest || !manifestIsInputBound(manifest)) return false;
  const supplied = new Set(inputResolution.checked.map((p) => resolve(p)));
  const recorded = new Set(
    manifest.sources
      .filter((s) => s.type !== "conversation")
      .map((s) => resolve(s.path)),
  );
  if (supplied.size === 0 || supplied.size !== recorded.size) return false;
  for (const p of supplied) if (!recorded.has(p)) return false;
  return true;
}

export type {
  FindingRiskTier,
  FindingClassification,
} from "./stepUtils.js";
export {
  dependencyVerifiedComplete,
  classifyFindingRisk,
} from "./stepUtils.js";
export { isTerminalStatus, isVerifiedCompleteStatus };
export { hostDependencyLevels };

function documentableFindings(state: RemediationState): Finding[] {
  if (!state.plan || !state.items) return [];
  return state.plan.findings.filter(
    (finding) => state.items?.[finding.id]?.status === "pending",
  );
}

/**
 * Blocks eligible for the next host handoff: those with pending
 * work AND every dependency VERIFIED-COMPLETE (INV-RS-01 — a SKIP or blocked
 * dependency never makes a dependent eligible). This dependency-frontier gate
 * replaced the old `dependenciesSatisfied` (any-terminal) check so a block whose
 * prerequisite was skipped/blocked is held back until its required surface lands.
 */
function implementableBlocks(state: RemediationState): RemediationBlock[] {
  if (!state.plan || !state.items) return [];
  return state.plan.blocks.filter(
    (block) =>
      dependencyVerifiedComplete(block, state) &&
      block.items.some((findingId) => {
        const item = state.items?.[findingId];
        return item?.status === "pending";
      }),
  );
}

/**
 * Pending nodes that are genuinely DEAD-ENDED: at least one dependency did not
 * reach a verified-complete disposition and never will (a prerequisite was
 * skipped or blocked, or the edges are cyclic). Once no eligible block remains,
 * these are marked `blocked` — their upstream surface never landed — rather than
 * looping forever.
 *
 * A node held only by an UNANSWERED WORKER QUESTION is deliberately excluded
 * (`dependencyAwaitingClarification`): since the clarification round is deferred
 * to the end of the implement phase, such a node reaches this sweep while its
 * answer is still outstanding, and blocking it would report "upstream failed"
 * for what is really "awaiting an answer". It stays `pending` and is re-decided
 * once the answer lands.
 */
function blockedByUnsatisfiedDependency(
  state: RemediationState,
): RemediationBlock[] {
  if (!state.plan || !state.items) return [];
  return state.plan.blocks.filter(
    (block) =>
      !dependencyVerifiedComplete(block, state) &&
      !dependencyAwaitingClarification(block, state) &&
      block.items.some((findingId) => state.items?.[findingId]?.status === "pending"),
  );
}

/**
 * Whether any item is paused on a worker question that has not been answered yet.
 * Drives the deferred clarification round (the `deferred_clarification`
 * obligation): the question waits until the implement frontier drains, then is
 * asked in one batched window.
 */
function hasUnansweredClarification(state: RemediationState): boolean {
  return Object.values(state.items ?? {}).some(
    (it) => it.status === "needs_clarification",
  );
}

// Dependency-level partitioning is single-sourced with the host handoff boundary.
/**
 * The phase ordinal whose UNTOUCHED entry a whole-repo test-suite gate must run
 * before, or null when no per-phase gate is due this pass (auto-phasing, T3 —
 * the integration checkpoint layered on top of the INV-PHASE-01 ordering
 * barrier). A gate is due iff:
 *   - the eligible handoff frontier this pass (`hostDependencyLevels`, which
 *     already applies the phase barrier, so the frontier is a SINGLE phase) is at
 *     a phase P > 0 — i.e. a lower foundations phase precedes it (and, by the
 *     barrier, is fully VERIFIED-complete now); AND
 *   - phase P is at its untouched entry — every block at phase P still has all
 *     its items `pending` (nothing dispatched yet).
 * The second clause makes the predicate pure and reblock-safe: it fires exactly
 * once as foundations→consumers crosses into P, never again on P's later
 * intra-phase levels, and re-fires only if a coarse re-block reopens the lower
 * phases and the frontier later re-climbs to P. Phase 0 (and an ordinal-free
 * single-phase plan) is never gated here — there is no preceding phase to
 * validate; the all-terminal tool-owned final gate (INV-RS-10) is the whole-repo
 * checkpoint for the last/only phase.
 */
export function phaseBoundaryToGate(state: RemediationState): number | null {
  const plan = state.plan;
  const items = state.items;
  if (!plan || !items) return null;
  const frontier = hostDependencyLevels(state).flat();
  if (frontier.length === 0) return null;
  const phaseOf = (b: RemediationBlock): number => b.phase_ordinal ?? 0;
  const dispatchPhase = Math.min(...frontier.map(phaseOf));
  if (dispatchPhase <= 0) return null;
  const pristine = plan.blocks
    .filter((b) => phaseOf(b) === dispatchPhase)
    .every((b) => b.items.every((id) => items[id]?.status === "pending"));
  return pristine ? dispatchPhase : null;
}

// Tool-owned final completion gate (INV-RS-10)
// ---------------------------------------------------------------------------
//
// The gate runner and its red record live in the sibling leaf module
// `finalGate.ts`. They are imported below for local use in the boundary and
// completion gates and re-exported to preserve this module's public surface +
// existing test imports. See `finalGate.ts` for the INV-RS-10 / CE-001 / CE-002
// documentation.

export {
  isAuditToolsMonorepo,
  toolOwnedFinalGateCommands,
  runToolOwnedFinalGate,
  finalGateOutcomePath,
  writeFinalGateOutcomeRecord,
} from "./finalGate.js";
export type {
  FinalGateCommandSpec,
  FinalGateCommandResult,
  ToolOwnedFinalGateResult,
  FinalGateOutcomeKind,
  FinalGateOutcomeRecord,
  GateRunner,
} from "./finalGate.js";

function resolvedOrTerminalItems(state: RemediationState): RemediationItemState[] {
  return Object.values(state.items ?? {}).filter((item) =>
    isTerminalStatus(item.status),
  );
}

function allItemsTerminal(state: RemediationState): boolean {
  const items = Object.values(state.items ?? {});
  return items.length > 0 && resolvedOrTerminalItems(state).length === items.length;
}

/**
 * Reorder a finalized plan by the checkpoint's interpreted intent.
 *
 * The checkpoint persists the operator's `free_form_intent` verbatim; the
 * structured `InterpretedIntent` is derived from it by the single shared
 * interpreter. INV-S04: the raw directive is never read past this line — only
 * the derived lens-weight / priority / scope signals reach the ordering, so the
 * verbatim string cannot leak into a worker prompt through this path.
 *
 * Absent checkpoint, absent intent, or an intent that interprets to nothing all
 * return the plan untouched.
 */
async function applyCheckpointIntentOrdering(
  artifactsDir: string,
  plan: RemediationPlan,
): Promise<RemediationPlan> {
  const checkpoint = await readOptionalJsonFile<IntentCheckpoint>(
    join(artifactsDir, "intent_checkpoint.json"),
  ).catch(() => undefined);
  const freeForm = checkpoint?.free_form_intent;
  if (typeof freeForm !== "string" || freeForm.trim().length === 0) return plan;
  const ordered = applyIntentOrdering(
    plan.findings,
    plan.blocks,
    interpretFreeFormIntent(freeForm),
  );
  return { ...plan, findings: ordered.findings, blocks: ordered.blocks };
}

function normalizeExtractedPlan(value: unknown): {
  plan: RemediationPlan;
  /** Findings as received (post-default, pre-dedup) for coverage accounting. */
  sourceFindings: Finding[];
  /** Cross-lens dedup absorbed→survivor map for the coverage ledger. */
  mergeMap: Map<string, string>;
} {
  if (!isRecord(value)) {
    throw new Error("extracted-plan.json must be an object.");
  }
  const rawFindings = Array.isArray(value.findings) ? value.findings : [];
  const findings = rawFindings.map((finding) => {
    if (!isRecord(finding)) return finding;
    return {
      category: "General",
      affected_files: [],
      evidence: [],
      ...finding,
    };
  }) as Finding[];
  const rawBlocks = Array.isArray(value.blocks) ? value.blocks : [];
  const blocks =
    rawBlocks.length > 0
      ? rawBlocks.map((block) => {
          if (!isRecord(block)) return block;
          return {
            parallel_safe: true,
            dependencies: [],
            // touched_files is REQUIRED on the block contract; default to an
            // empty array so a free-form block that omits it still validates,
            // while an explicit value on `block` wins via the spread below.
            touched_files: [],
            ...block,
          };
        })
      : findings.map((finding, index) => ({
          block_id: `B-${String(index + 1).padStart(3, "0")}`,
          items: [finding.id],
          parallel_safe: true,
          touched_files: finding.affected_files.map((af) => af.path),
        }));
  const dedup = deduplicateCrossLensFindings(findings);
  const dedupBlocks = fixupBlocksAfterDedup(
    blocks as RemediationBlock[],
    dedup.mergeMap,
  );
  const plan: RemediationPlan = {
    plan_id:
      typeof value.plan_id === "string" ? value.plan_id : randomRunId("PLAN"),
    ...(typeof value.goal_id === "string" ? { goal_id: value.goal_id } : {}),
    ...(typeof value.source === "string" ? { source: value.source } : {}),
    findings: dedup.findings,
    blocks: dedupBlocks,
    project_type:
      typeof value.project_type === "string" ? value.project_type : "unknown",
    test_command:
      typeof value.test_command === "string" ? value.test_command : undefined,
    e2e_command:
      typeof value.e2e_command === "string" ? value.e2e_command : undefined,
    candidate_closing_actions: ["none"],
    block_strategy:
      value.block_strategy === "test_graph" ||
      value.block_strategy === "git_cocommit" ||
      value.block_strategy === "file_overlap" ||
      value.block_strategy === "manual"
        ? value.block_strategy
        : undefined,
  };

  const issues = validateRemediationPlan(plan).filter(
    (issue) => issue.severity === "error",
  );
  if (issues.length > 0) {
    throw new Error(`Invalid extracted plan:\n${formatValidationIssues(issues)}`);
  }
  if (plan.findings.length === 0) {
    throw new Error("Extracted plan contains zero findings.");
  }
  return { plan, sourceFindings: findings, mergeMap: dedup.mergeMap };
}

async function saveStateForPlan(
  artifactsDir: string,
  existing: RemediationState,
  plan: RemediationPlan,
  planCoverage?: CoverageLedger,
): Promise<RemediationState> {
  const { host_handoff: _staleHostHandoff, ...carryForwardState } = existing;
  const items: Record<string, RemediationItemState> = {};
  const blockIds = blockIdsByFinding(plan);
  for (const finding of plan.findings) {
    items[finding.id] = {
      finding_id: finding.id,
      status: "pending",
      block_id: blockIds.get(finding.id) ?? "UNKNOWN",
    };
  }
  const state: RemediationState = {
    ...carryForwardState,
    status: "planning",
    plan,
    items,
    closing_plan: { action: "none" },
    ...(planCoverage ? { plan_coverage: planCoverage } : {}),
  };
  await new StateStore(artifactsDir).saveState(state);
  await writeJsonFile(join(artifactsDir, "remediation_plan.json"), plan);
  return state;
}

// Plan-time bookkeeping recomputed on every plan pass; it must not participate
// in the carry-forward identity of a finding.
const PLAN_TIME_BOOKKEEPING_KEYS = new Set([
  "hash_at_plan_time",
  "evidence_grounded",
]);

function stripPlanTimeBookkeeping(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripPlanTimeBookkeeping(entry));
  }
  if (!isRecord(value)) {
    return value;
  }

  const stripped: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (PLAN_TIME_BOOKKEEPING_KEYS.has(key)) continue;
    stripped[key] = stripPlanTimeBookkeeping(value[key]);
  }
  return stripped;
}

/**
 * The re-plan carry-forward identity of a finding: canonical JSON with the
 * plan-time bookkeeping keys stripped, so a re-plan whose only delta is a
 * recomputed file hash or a re-evaluated grounding flag carries the prior item
 * forward, while a real change to the finding does not.
 *
 * EXPORTED so the invariant suite can call THIS function. It was module-internal,
 * and the suite claiming to cover the invariant declared its own copy of the key
 * set, the strip and the key builder — so dropping `evidence_grounded` from the
 * production set, or widening it with a real field like `severity`, left the
 * block green while carry-forward regressed. A test asserting against its own
 * re-implementation pins nothing about shipped behaviour.
 */
export function findingCarryForwardKey(finding: Finding): string {
  return JSON.stringify(stripPlanTimeBookkeeping(finding));
}

// Single-block membership is enforced by `fixupBlocksAfterDedup` (each finding
// id appears in exactly one block's items after fixup), so this scan is a plain
// projection. First-wins in block order is kept as the tie-break for defense in
// depth — it is the same order fixup resolves ownership in, so the two can
// never disagree even on a malformed plan.
function blockIdsByFinding(plan: RemediationPlan): Map<string, string> {
  const byFinding = new Map<string, string>();
  for (const block of plan.blocks) {
    for (const id of block.items) {
      if (!byFinding.has(id)) {
        byFinding.set(id, block.block_id);
      }
    }
  }
  return byFinding;
}

function carryForwardMatchingItems(
  previous: RemediationState,
  replanned: RemediationState,
): RemediationState {
  if (!previous.plan || !previous.items || !replanned.plan || !replanned.items) {
    return replanned;
  }

  const previousFindings = new Map(
    previous.plan.findings.map((finding) => [finding.id, finding]),
  );
  const replannedBlockIds = blockIdsByFinding(replanned.plan);
  const items = { ...replanned.items };
  let carried = false;

  for (const finding of replanned.plan.findings) {
    const previousFinding = previousFindings.get(finding.id);
    const previousItem = previous.items[finding.id];
    // A still-pending item carries no work to preserve, so it is re-minted from
    // the fresh plan rather than carried forward. (This test used to also admit
    // a pending item that held an `item_spec`; the document phase that produced
    // one was dissolved by N-R13 and the field is gone, so the second condition
    // could never be true and is not restated here.)
    if (!previousFinding || !previousItem) {
      continue;
    }
    if (previousItem.status === "pending") {
      continue;
    }
    if (findingCarryForwardKey(previousFinding) !== findingCarryForwardKey(finding)) {
      continue;
    }

    items[finding.id] = {
      ...previousItem,
      block_id: replannedBlockIds.get(finding.id) ?? previousItem.block_id,
    };
    carried = true;
  }

  if (!carried) {
    return replanned;
  }

  const hasPending = replanned.plan.findings.some(
    (finding) => items[finding.id]?.status === "pending",
  );

  return {
    ...replanned,
    items,
    status: hasPending ? "planning" : replanned.status,
  };
}

async function forceReplanFromExistingIntake(
  root: string,
  artifactsDir: string,
  previous: RemediationState,
  store: StateStore,
  runLogger: RunLogger,
): Promise<RemediationState | null> {
  const pendingState: RemediationState = {
    status: "pending",
    started_at: previous.started_at,
    step_count: previous.step_count,
    // Carry the run-lifetime staging-manifest fields across a force-replan.
    // Dropping run_start_dirty here would make handlePendingExtractedPlan's
    // capture-once guard re-capture AFTER edits have landed, misclassifying
    // the run's own hand-applied edits as pre-existing dirt (silently
    // under-staged at close); applied_edit_surface is git-proven ground truth
    // that must survive replanning for the same reason.
    ...(previous.run_start_dirty
      ? { run_start_dirty: previous.run_start_dirty }
      : {}),
    ...(previous.applied_edit_surface
      ? { applied_edit_surface: previous.applied_edit_surface }
      : {}),
  };
  const extractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (!extractedPlan) {
    await store.saveState(pendingState);
    return null;
  }

  const replanned = await handlePendingExtractedPlan(
    root,
    artifactsDir,
    pendingState,
    extractedPlan,
    runLogger,
  );
  if (!replanned) {
    return null;
  }

  const carried = carryForwardMatchingItems(previous, replanned);
  await store.saveState(carried);
  return carried;
}

async function presentReportStep(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");
  // Terminal friction-TRIAGE close-out, folded into present_report (single-sourced in
  // `audit-tools/shared`). MANDATORY + BLOCKING: stays "dispose" until every mechanical
  // event + reflection is disposed AND ≥1 open observation written. Never trivially
  // satisfied by an empty event set — the host must actively confirm the friction state.
  //
  // When `artifactsDir` was deleted by a fully-green close (close.ts rm -rf on a
  // green run), there is nowhere to persist the friction record and no mechanical
  // events to triage — skip the triage entirely and go straight to complete.
  const artifactsDirExists = existsSync(artifactsDir);
  const triage = artifactsDirExists
    ? await decideRemediateFrictionCloseout(artifactsDir, state)
    : null;
  const frictionBlock = triage ? buildFrictionTriageBlock(triage) : "";
  const isBlocked = triage?.action === "dispose";
  return writeCurrentStep({
    stepKind: "present_report",
    status: isBlocked ? "ready" : "complete",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: isBlocked
      ? `# Remediation Run Friction Triage\n\nComplete friction triage before presenting the report.\n${frictionBlock}`
      : `# Present Remediation Report\n\nRead \`${reportPath}\` and summarize the remediation outcome.\nMention resolved, ignored, and deemed-inappropriate counts plus the closing action.\n${frictionBlock}`,
    allowedCommands: [],
    stopCondition: isBlocked
      ? "Complete friction triage (write dispositions and open_observations), then call next-step again."
      : "Present the remediation report summary and stop.",
    artifactPaths: {
      final_report: reportPath,
      ...(triage ? { friction_record: triage.recordPath } : {}),
    },
  });
}

function currentHostBoundaryState(
  state: RemediationState,
): CurrentRemediationHostState {
  return {
    contract_version: "remediate-code-state/v1alpha1",
    ...state,
  } as CurrentRemediationHostState;
}

/**
 * The `recover-ingest` verb's whole body: ingest the host's landed results in
 * RECOVERY mode and persist through the same file-locked, atomically-writing
 * store, with the same `contract_version` strip.
 *
 * It is a separate verb rather than a flag on `next-step` because the
 * relaxation it enables must be an operator's explicit act — see
 * `ingestRemediationHostResults`, which states what is waived and the residual
 * risk. Nothing else here differs from the normal ingestion: the same workload,
 * the same contract gates, the same eligibility frontier.
 *
 * ## Why this runs in two phases
 *
 * A required-test rerun is `spawnSync`, which blocks the event loop for its
 * whole duration. Run inside the state lock, it would starve the lock's own
 * heartbeat timer (`setInterval` in the shared fileLock) — the held lock's mtime
 * would stop being refreshed, a second acquirer would classify it as stale at
 * ~30s and steal it, and mutual exclusion would be gone precisely during the
 * longest critical section in the codebase. Holding a lock across a blocking
 * spawn is therefore not merely slow; it is unsound.
 *
 * So:
 *
 * - **Phase 1, UNLOCKED.** Snapshot the state, capture HEAD, and run every
 *   distinct required-test command exactly once
 *   (`precomputeRecoveryTestVerdicts`). HEAD is captured BEFORE the spawns, not
 *   after, because a host-authored command that MOVES HEAD would otherwise
 *   produce verdicts of mixed provenance and go undetected. (The guard compares
 *   commit shas: it sees HEAD movement, not worktree dirt — a command that only
 *   dirties files is invisible to it, which is acceptable because phase 2's
 *   corroboration is commit-based.)
 * - **Phase 2, LOCKED.** Re-read HEAD and abort the whole recovery if it moved
 *   (`tree_moved_between_phases`) — the phase-1 verdicts would describe a tree
 *   that no longer exists, and nothing is accepted or appended. Otherwise ingest
 *   with the pre-computed verdicts, which the ingest only READS: in recovery
 *   mode it never spawns, and a command missing from the table fails closed.
 *
 * What remains inside the lock is git plumbing (ancestry, ref scan, diff-tree),
 * the ledger append, and the state write — sub-second work, comfortably inside
 * heartbeat coverage. The HEAD-unchanged guard closes the gap the phase split
 * opens; the operational protocol is still one writer at a time, now enforced by
 * a lock that cannot be stolen mid-hold instead of by convention.
 *
 * One accepted cost: `StateStore.mutate` always writes, so a recovery run that
 * changes nothing rewrites `state.json` with identical content. Expressing a
 * true no-op means plumbing the locked store's `SKIP_WRITE` sentinel through
 * `StateStore.mutate`, which is a change to the store's API rather than to this
 * verb. The `state_changed` flag on the returned summary stays authoritative
 * for callers either way.
 */
export async function recoverIngestHostResults(options: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
}): Promise<RemediationHostIngestSummary> {
  const root = resolveRoot(options.root);
  const artifactsDir = resolveArtifactsDir(root, options.artifactsDir);
  const store = new StateStore(artifactsDir);

  // ── Phase 1: unlocked ────────────────────────────────────────────────────
  const snapshot = await store.loadState();
  if (!snapshot) {
    throw new Error(
      `No remediation state at ${artifactsDir} — there is nothing to ingest.`,
    );
  }
  const headBeforeTests = await headCommit(root);
  const requiredTestVerdicts = await precomputeRecoveryTestVerdicts({
    root,
    artifactsDir,
    runId: options.runId,
    state: currentHostBoundaryState(snapshot),
  });
  if (requiredTestVerdicts === "unsupported_retired_state") {
    throw new Error(
      "Remediation state uses a retired dispatch shape and cannot cross the host handoff boundary.",
    );
  }

  // ── Phase 2: locked, spawn-free ──────────────────────────────────────────
  let ingested!: RemediationHostIngestSummary;
  await store.mutate(async (state) => {
    if (!state) {
      throw new Error(
        `No remediation state at ${artifactsDir} — there is nothing to ingest.`,
      );
    }
    const headNow = await headCommit(root);
    if (headNow !== headBeforeTests) {
      ingested = {
        accepted_count: 0,
        completed_work_item_ids: [],
        pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
        issues: [
          {
            code: "tree_moved_between_phases",
            message:
              `HEAD moved from ${headBeforeTests ?? "(none)"} to ${headNow ?? "(none)"} ` +
              "while the required tests were running, so their verdicts no longer describe " +
              "this tree. Nothing was accepted; re-run recover-ingest on a settled tree.",
          },
        ],
        state_changed: false,
        state: currentHostBoundaryState(state),
      };
      return state;
    }
    const outcome = await ingestRemediationHostResults({
      root,
      artifactsDir,
      runId: options.runId,
      state: currentHostBoundaryState(state),
      recovery: { requiredTestVerdicts },
    });
    if (outcome === "unsupported_retired_state") {
      throw new Error(
        "Remediation state uses a retired dispatch shape and cannot cross the host handoff boundary.",
      );
    }
    ingested = outcome;
    if (!outcome.state_changed) return state;
    const { contract_version: _contractVersion, ...persistableState } =
      outcome.state;
    return persistableState;
  });
  return ingested;
}

async function buildImplementDispatchStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  options: NextStepOptions;
  store: StateStore;
  runLogger: RunLogger;
}): Promise<RemediateOutcome> {
  const { root, artifactsDir, state, store, runLogger } = ctx;
  const runId = stateRunId(state);
  const boundaryState = currentHostBoundaryState(state);
  const ingested = await ingestRemediationHostResults({
    root,
    artifactsDir,
    runId,
    state: boundaryState,
  });
  if (ingested === "unsupported_retired_state") {
    throw new Error(
      "Remediation state uses a retired dispatch shape and cannot cross the host handoff boundary.",
    );
  }
  if (ingested.state_changed) {
    const { contract_version: _contractVersion, ...persistableState } =
      ingested.state;
    await store.saveState(persistableState);
    return { kind: "transition", state: persistableState };
  }

  const baselineCommit = await headCommit(root);
  if (!baselineCommit) {
    throw new Error("Cannot prepare remediation host work without a repository HEAD commit.");
  }
  const handoff = await prepareRemediationHostHandoff({
    root,
    artifactsDir,
    runId,
    baselineCommit,
    state: boundaryState,
  });
  if (handoff === "unsupported_retired_state") {
    throw new Error(
      "Remediation state uses a retired dispatch shape and cannot cross the host handoff boundary.",
    );
  }
  if (
    state.host_handoff?.workload_sha256 !==
    handoff.handoff_record.workload_sha256
  ) {
    await store.saveState({
      ...state,
      host_handoff: handoff.handoff_record,
    });
  }

  // Name the runs this dispatch round relates to on the friction record (semantics:
  // `FrictionRunLinks`). Each reference is sourced from the envelope that owns it — the
  // persisted handoff record for the dispatch run, the step contract's own run id for
  // the step — never synthesized from the other.
  await linkFrictionRunIds(
    artifactsDir,
    stateRunId(state),
    { step_run_id: runId, dispatch_run_id: handoff.handoff_record.run_id },
    "remediate-code",
  );

  // Ingest issues reached the PROMPT and nothing else — a channel that survives
  // exactly as long as the host reads that one step. They are also the durable
  // record of which submitted results were rejected and why, so they are logged
  // as well as rendered.
  for (const issue of ingested.issues) {
    runLogger.event({
      phase: "next-step",
      kind: "outcome",
      obligation: "host_ingest",
      note:
        `host_ingest_issue code=${issue.code}` +
        (issue.work_item_id ? ` work_item=${issue.work_item_id}` : "") +
        (issue.result_path ? ` result=${issue.result_path}` : "") +
        ` message=${issue.message}`,
    });
  }

  const resultDiagnostics =
    ingested.issues.length === 0
      ? ""
      : `
## Result status requiring attention

${ingested.issues
  .map(
    (issue) =>
      `- ${issue.work_item_id ? `\`${issue.work_item_id}\`: ` : ""}${issue.message}${issue.result_path ? ` (\`${issue.result_path}\`)` : ""}`,
  )
  .join("\n")}

The workload was restored from its tool-owned digest when necessary. Repair or
complete only the named result files; do not rewrite the workload or its
baseline.
`;

  const nextCommand = loaderCommand("next-step");
  return {
    kind: "emit",
    step: await writeCurrentStep({
      stepKind: "dispatch_implement",
      status: "ready",
      runId,
      repoRoot: root,
      artifactsDir,
      prompt: `
# Implement the Eligible Remediation Workload

Read the generated workload at:

\`${handoff.workload_path}\`

It contains the complete, dependency-safe current frontier. Complete every work
item and write its exact prompt-bound result contract to its \`result_path\`.
The host owns execution choices, grouping, and concurrency; audit-tools performs
no launch, routing, or quota decision. Do not start a later dependency level.
${resultDiagnostics}

After all completed changes are merged and their result files exist, run:

\`${nextCommand}\`
`,
      allowedCommands: [
        ...new Set(
          handoff.workload.work_items.flatMap((item) => item.required_tests),
        ),
        nextCommand,
      ],
      stopCondition:
        "Stop after every emitted work item has a complete result and next-step has been run.",
      artifactPaths: { host_workload: handoff.workload_path },
    }),
  };
}

// A held phase lock is reported to the host immediately. `withFileLock` still
// owns stale-lock recovery and heartbeats for the winning process.
const PHASE_LOCK_TIMEOUT_MS = 0;

// Cooperative multi-agent (slice 4, spec/multi-ide-concurrent-runs-design.md):
// emitted when another agent/IDE currently holds the phase mutex and is advancing
// this run's serial state machine. A non-blocking "retry shortly" — the host
// re-runs next-step and joins once the peer yields (or finishes into the pooled
// implement phase this peer can then join).
async function buildPhaseBusyStep(params: {
  root: string;
  artifactsDir: string;
  runId: string;
}): Promise<RemediationStep> {
  const { root, artifactsDir, runId } = params;
  const nextCommand = loaderCommand("next-step");
  return writeCurrentStep({
    stepKind: "phase_busy",
    status: "ready",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt: `
# Remediation busy — another agent is advancing this run

Another agent/IDE is currently advancing this remediation's state machine (a
serial phase — plan, triage, or close). Nothing is wrong; this is the cooperative
multi-agent guard that stops two agents from running the same phase at once.

Wait a few seconds, then run:

\`${nextCommand}\`

Once the peer yields — or the run reaches the parallel implement phase — your
next-step joins in and takes on unclaimed work.
`,
    allowedCommands: [nextCommand],
    stopCondition:
      "Stop briefly, then re-run next-step to join the run once the peer yields the phase.",
  });
}

// --- Per-state handlers -----------------------------------------------------
// Each handler owns one branch of the original decideNextStepInner dispatch.
// Handlers that emit a step return RemediationStep directly; handlers that need
// the loop to continue with mutated state return { continueWithState }.

async function handleComplete(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
): Promise<RemediationStep> {
  return presentReportStep(root, artifactsDir, state);
}

/**
 * The terminal friction-TRIAGE close-out for the remediate half. Thin delegation to
 * the single-sourced `decideFrictionTriage` (`audit-tools/shared`) — the exact analog
 * of audit-code's `decideAuditFrictionCloseout`, so the triage shape, disposition
 * vocabulary, blocking semantics, and close-out logic cannot drift between the two
 * halves. Drops the former false-green (an empty up-front record no longer satisfies):
 * the blocking triage stays unsatisfied ("dispose") until every captured mechanical
 * event AND every surfaced agent-feedback reflection carries a disposition; an empty
 * set (zero events AND zero reflections) is trivially "disposed". Keyed only off
 * `(artifactsDir, runId)`; never coupled to any repo's backlog doc.
 */
export async function decideRemediateFrictionCloseout(
  artifactsDir: string,
  state: RemediationState | null,
): Promise<FrictionTriageDecision> {
  return decideFrictionTriage(artifactsDir, stateRunId(state), "remediate-code");
}

/**
 * Copy an unusable extracted plan somewhere recoverable and PROVE the copy
 * landed, returning the archive path. Read back and compared byte-for-byte:
 * "the write did not throw" is not evidence a file exists, and this is the last
 * moment the plan is recoverable at all.
 *
 * THROWS rather than returning when the copy cannot be made or verified, so the
 * caller's unlink is unreachable on that path — an irreversible delete never
 * runs before its archive is written and verified.
 */
async function archiveExtractedPlan(extractedPlanPath: string): Promise<string> {
  // BYTES, compared with Buffer.compare — the bar CP-NODE-3 set for the
  // verified-archive promotion path. A utf8-string compare is a weaker claim
  // than the one an archive has to make: it silently equates byte sequences that
  // decode alike (a BOM, a lone surrogate, an invalid sequence replaced by
  // U+FFFD on BOTH sides), so a corrupt copy can read as verified.
  const original = await readFile(extractedPlanPath);
  const archivePath = join(
    dirname(extractedPlanPath),
    "archive",
    `extracted-plan-${Date.now()}.json`,
  );
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, original);
  const readBack = await readFile(archivePath);
  if (Buffer.compare(original, readBack) !== 0) {
    throw new Error(
      `Extracted-plan archive at ${archivePath} does not match the original bytes.`,
    );
  }
  return archivePath;
}

async function handlePendingExtractedPlan(
  root: string,
  artifactsDir: string,
  existing: RemediationState,
  extractedPlan: unknown,
  // The plan path's high-consequence events — findings dropped by grounding, and
  // the plan being destroyed — are DURABLE, so the logger is a parameter rather
  // than a module-level singleton reached for at the point of use. stderr is not
  // captured into the artifact dir; before this, the durable tree held no trace
  // that a plan had been destroyed or that findings had been dropped.
  runLogger: RunLogger,
): Promise<RemediationState | null> {
  // The discard-and-re-extract recovery below covers EXACTLY the region whose
  // failures mean the extracted PLAN is unusable: normalization and grounding.
  // It deliberately stops there. Everything after it — sizing, the dirty
  // snapshot, the coverage ledger, persistence — fails for reasons that have
  // nothing to do with the plan's content, so discarding the plan on those is
  // both a data loss and a misdiagnosis.
  //
  // `resolvePlanContextBudget`'s refusal is the case that proved it. Its message
  // asks the operator to declare a window, but it threw into this catch: the
  // plan was deleted and the operator was told the file was corrupt. Because
  // re-extraction cannot change the host's declared window, the next step
  // reproduced it exactly — a deterministic loop that ate the extracted plan on
  // every lap. Pinned by `tests/remediate/plan-sizing-refusal.test.ts`.
  let plan: RemediationPlan;
  let sourceFindings: Finding[];
  let mergeMap: Map<string, string>;
  let grounding: ExtractedFindingGrounding;
  try {
    ({ plan, sourceFindings, mergeMap } = normalizeExtractedPlan(extractedPlan));

    // INTENT ORDERING, applied where the plan's findings and blocks are
    // FINALIZED. `applyIntentOrdering` existed with no production caller at all:
    // the checkpoint's interpreted intent was written and never read back, so
    // "the work the user emphasised is dispatched first" was a property the code
    // could state but not deliver. Ordering ONLY — it never drops or mutates a
    // finding; every input is present in the output with a different order, so a
    // plan whose checkpoint carries no intent is returned unchanged.
    plan = await applyCheckpointIntentOrdering(artifactsDir, plan);

    // Deterministic grounding for the LLM-extracted plan (this path never sees
    // structured audit findings): strip phantom affected_files paths, drop
    // findings whose every cited path was phantom, and classify evidence. No
    // bounded LLM repair here — the host re-extracts with the corrected prompt
    // if the whole plan grounds to nothing. Contract-pipeline-promoted plans
    // are grounded by construction (the traceability gate ties every node to
    // obligations/accepted counterexamples), so their obligation-reference
    // evidence is exempt from the path-citation check.
    grounding = await groundExtractedFindings(plan.findings, {
      root,
      evidenceGrounding: plan.source !== "contract_pipeline",
    });
    if (grounding.dropped.length > 0) {
      // DROPPED-ID BOOKKEEPING, durable. A caller reading a finding count across
      // the plan boundary must never receive the submitted count when findings
      // were dropped, so the ids, the dropped count and the surviving grounded
      // count all land in the run log — not only on stderr, which no artifact
      // captures.
      const droppedIds = grounding.dropped.map((d) => d.finding.id);
      runLogger.event({
        phase: "next-step",
        kind: "outcome",
        obligation: "plan_grounding",
        note:
          `grounding_dropped_findings dropped=${String(droppedIds.length)} ` +
          `grounded=${String(grounding.findings.length)} ` +
          `submitted=${String(plan.findings.length)} ` +
          `ids=${droppedIds.join(",")}`,
      });
      process.stderr.write(
        `[remediate-code] Grounding dropped ${grounding.dropped.length} extracted finding(s) whose cited paths do not exist: ${grounding.dropped.map((d) => `${d.finding.id} (${d.phantomPaths.join(", ")})`).join("; ")}\n`,
      );
    }
    plan.findings = grounding.findings;
    const keptIds = new Set(plan.findings.map((f) => f.id));
    plan.blocks = plan.blocks
      .map((b) => ({ ...b, items: (b.items ?? []).filter((id) => keptIds.has(id)) }))
      .filter((b) => (b.items ?? []).length > 0);
    if (plan.findings.length === 0) {
      throw new Error(
        "Every extracted finding cited only phantom paths; re-extract with real repo-relative paths.",
      );
    }
  } catch (error) {
    const paths = intakePaths(artifactsDir);
    const reason = error instanceof Error ? error.message : String(error);
    // ARCHIVE, VERIFY, THEN destroy — in that order, with the delete unreachable
    // if the archive did not land. This recovery used to unlink the plan
    // outright, unarchived and unverified, leaving a line on stderr as the only
    // record; the plan the run was built from was simply gone.
    let archivePath: string | undefined;
    if (existsSync(paths.extractedPlan)) {
      try {
        archivePath = await archiveExtractedPlan(paths.extractedPlan);
      } catch (archiveError) {
        const detail =
          archiveError instanceof Error
            ? archiveError.message
            : String(archiveError);
        runLogger.event({
          phase: "next-step",
          kind: "error",
          obligation: "extracted_plan_recovery",
          note: `extracted_plan_archive_failed reason=${reason} archive_error=${detail}`,
        });
        // NOT a re-emitted extraction step. Returning null here would report a
        // routine "re-extract, please" while the plan was destroyed and nothing
        // held a copy of it.
        throw new Error(
          `Extracted plan at ${paths.extractedPlan} is unusable (${reason}) but could ` +
            `not be archived (${detail}); it was left in place rather than destroyed.`,
        );
      }
      const { unlink } = await import("node:fs/promises");
      await unlink(paths.extractedPlan);
    }
    runLogger.event({
      phase: "next-step",
      kind: "outcome",
      obligation: "extracted_plan_recovery",
      note:
        `extracted_plan_removed reason=${reason} ` +
        `archive=${archivePath ?? "(nothing on disk to archive)"}`,
    });
    process.stderr.write(
      `[remediate-code] Unusable extracted-plan.json removed (${reason}); archived at ${archivePath ?? "(nothing on disk to archive)"}. Re-emitting extraction step.\n`,
    );
    return null;
  }

  // Past the recovery boundary: a failure below is a real failure and propagates.
  const pipelined = await applyPlanPipeline(plan, { root, artifactsDir });
  // Run-start dirty snapshot for the V2 staging manifest, capture-once: the
  // extracted-plan join runs at plan time (before any remediation edit), so
  // the dirty set here is pre-existing user dirt — the close phase excludes
  // it from DECLARED-surface staging.
  if (!existing.run_start_dirty) {
    existing = {
      ...existing,
      run_start_dirty: [...(await stagedAndUntracked(root))].sort(),
    };
  }
  // Discarded on mismatch, so the gate re-asks rather than replaying operator
  // decisions under semantics they were not made under. Re-asking costs a repeat
  // answer; applying them blind could act on a keep/decline that no longer means
  // what it meant when it was recorded.
  const reviewDecision = discardOnSchemaVersionMismatch(
    await readOptionalJsonFile<ReviewDecisionRecord>(reviewDecisionPath(artifactsDir)),
    REVIEW_DECISION_SCHEMA_VERSION,
  );
  // Coverage ledger. Path A (structured_audit): the single filter pass ran at
  // intake over the ORIGINAL findings and persisted its dispositions — build
  // coverage over those originals so every audit finding gets exactly one
  // disposition (planned / folded_into / dropped_* / dropped_by_checkpoint /
  // declined_by_review), reconciling to the original count. Path B (no persisted
  // dispositions): build over the post-pipeline node findings as before. Either
  // way declined findings are recorded; their payloads recover at close from the
  // unfiltered intake source.
  const filterDisp = await readOptionalJsonFile<PersistedReviewFilterDispositions>(
    reviewFilterDispositionsPath(artifactsDir),
  );
  const pipelinedBlockIds = blockIdsByFinding(pipelined);
  const coverage = filterDisp
    ? buildCoverageLedger({
        planId: pipelined.plan_id,
        sourceFindings: filterDisp.originals,
        droppedNoEvidence: filterDisp.droppedNoEvidence,
        droppedByCheckpoint: filterDisp.droppedByCheckpoint,
        declinedByReview: reviewDecision?.declined ?? [],
        droppedPhantomPaths: new Map(filterDisp.droppedPhantomPaths),
        phantomPathsRemoved: new Map(filterDisp.phantomPathsRemoved),
        mergeMap: new Map(filterDisp.mergeMap),
        items: {}, // originals carry no node block_id; planned entries omit it
      })
    : buildCoverageLedger({
        planId: pipelined.plan_id,
        sourceFindings,
        droppedNoEvidence: [],
        droppedByCheckpoint: [],
        declinedByReview: reviewDecision?.declined ?? [],
        droppedPhantomPaths: new Map(
          grounding.dropped.map((d) => [d.finding.id, d.phantomPaths]),
        ),
        phantomPathsRemoved: grounding.phantomPathsByFinding,
        mergeMap,
        items: Object.fromEntries(
          pipelined.findings.map((finding) => [
            finding.id,
            {
              finding_id: finding.id,
              status: "pending" as const,
              block_id: pipelinedBlockIds.get(finding.id) ?? "UNKNOWN",
            },
          ]),
        ),
      });
  return await saveStateForPlan(artifactsDir, existing, pipelined, coverage);
}

// ── Review-approval gate (go-forward program item 1) ───────────────────────────
//
// Between the audit findings and the contract pipeline, every ORIGINAL finding is
// presented to the user bucketed by review-necessity (src/review/reviewGate.ts).
// Approved findings seed the pipeline; disapproved findings are excluded from it
// AND recorded as a declined disposition (review_decision.json) — never silently
// swept to a terminal status inside a quality-tail node, the 2026-06-15 failure
// this gate exists to prevent.
//
// Fires only on Path A (structured_audit) — the only intake path with a
// pre-existing finding set; document/conversation runs derive findings inside the
// pipeline. File-driven and pre-state (no RemediationState exists at intake yet),
// mirroring the intake-clarification gate rather than waiting_for_clarification.

const REVIEW_DECISION_SCHEMA_VERSION = "remediate-code-review-decision/v1" as const;
// The review request/decision plan id is RUN-UNIQUE (INV-RSM-RESOLUTION-
// CORRELATE, COR-0b906e37): Path A mints `randomRunId("path-a-review")` per
// request, Path B uses the live plan's own plan_id. The former stable
// constants ("path-a-review"/"path-b-review") are retired — with a constant id
// a resolution left over from ANOTHER run in the same artifacts dir always
// correlated, so a stale cross-run answer was silently applied.

interface ReviewDecisionRecord {
  schema_version: typeof REVIEW_DECISION_SCHEMA_VERSION;
  plan_id: string;
  approved_ids: string[];
  declined: Array<{ finding_id: string; reason: string }>;
  created_at: string;
}

function reviewRequestPath(artifactsDir: string): string {
  return join(artifactsDir, "review_request.json");
}
function reviewResolutionPath(artifactsDir: string): string {
  return join(artifactsDir, "review_resolution.json");
}
function reviewDecisionPath(artifactsDir: string): string {
  return join(artifactsDir, "review_decision.json");
}

// Up-front ambiguity gate (note 3, part A) — its own request/resolution/decision
// files, mirroring the review gate so it fires (and halts) at most once per run.
function ambiguityRequestPath(artifactsDir: string): string {
  return join(artifactsDir, "ambiguity_request.json");
}
function ambiguityResolutionPath(artifactsDir: string): string {
  return join(artifactsDir, "ambiguity_resolution.json");
}
function ambiguityDecisionPath(artifactsDir: string): string {
  return join(artifactsDir, "ambiguity_decision.json");
}

/** Pull the Finding[] out of a parsed audit-findings.json payload. */
function extractAuditFindings(parsed: unknown): Finding[] {
  if (isRecord(parsed) && Array.isArray(parsed.findings)) {
    return (parsed.findings as unknown[]).filter(
      (f): f is Finding => isRecord(f) && typeof f.id === "string",
    );
  }
  return [];
}

async function handleWaitingForReviewApproval(
  root: string,
  artifactsDir: string,
  request: ReviewRequest,
  refusal?: string,
): Promise<RemediationStep> {
  return writeCurrentStep({
    stepKind: "collect_review_approval",
    status: "blocked",
    runId: randomRunId("REVIEW"),
    repoRoot: root,
    artifactsDir,
    prompt: reviewApprovalPrompt(request, reviewResolutionPath(artifactsDir), refusal),
    allowedCommands: [loaderCommand("next-step")],
    stopCondition:
      "Stop after presenting the findings for approval and collecting the user's approve/disapprove decision, unless the decision is already recorded and the prompt told you to continue.",
    artifactPaths: {
      review_request: reviewRequestPath(artifactsDir),
      review_resolution: reviewResolutionPath(artifactsDir),
    },
  });
}

/**
 * Uniform id-join contract pre-screen for the review gate (both paths): a
 * resolution naming an unknown finding id or tier is REFUSED whole — archived
 * (never applied) and the gate re-halts with the refusal and the valid set in
 * the re-prompt. The gate's default is approve, so the silent-drop alternative
 * turns a typo'd decline into an approval. Returns the re-halt step, or null
 * when the resolution's ids are clean. `applyReviewResolution` re-checks as the
 * mechanical backstop.
 */
async function refuseUnknownIdResolution(
  root: string,
  artifactsDir: string,
  request: ReviewRequest,
  resolution: ReviewResolution | null | undefined,
  resolutionPath: string,
  requestPath: string,
): Promise<RemediationStep | null> {
  const screen = screenResolutionIds(request, resolution);
  if (screen.unknown_finding_ids.length === 0 && screen.unknown_tiers.length === 0) {
    return null;
  }
  await withFsRetry(() =>
    rename(resolutionPath, `${resolutionPath}.refused-${Date.now()}`),
  );
  await writeJsonFile(requestPath, request);
  const parts: string[] = [];
  if (screen.unknown_finding_ids.length > 0) {
    parts.push(
      `finding id(s) not in the request: ${screen.unknown_finding_ids.map((i) => `\`${i}\``).join(", ")}`,
    );
  }
  if (screen.unknown_tiers.length > 0) {
    parts.push(
      `unknown tier(s): ${screen.unknown_tiers.map((t) => `\`${t}\``).join(", ")}`,
    );
  }
  return handleWaitingForReviewApproval(root, artifactsDir, request, parts.join("; "));
}

interface ReviewGateProceed {
  kind: "proceed";
  /** Survivors approved to seed the pipeline (declined excluded). */
  approved: Finding[];
  /** Declined survivors with the recorded reason — for the coverage ledger + the durable record. */
  declined: Array<{ finding_id: string; reason: string }>;
}
interface ReviewGateHalt {
  kind: "halt";
  step: RemediationStep;
}

/**
 * Run the review-approval gate over the SURVIVOR finding set (already passed
 * through the single filter pass: deduped, evidence-bearing, path-grounded,
 * checkpoint-kept). Returns a halt step while awaiting the user's decision, or a
 * `proceed` splitting the survivors into approved (seed the pipeline) and declined
 * (recorded, never acted on).
 *
 * Idempotent across the many pipeline next-step calls: once review_decision.json
 * exists the gate consumes it directly and proceeds, so it fires (and halts) at
 * most once per run. Empty survivors → nothing to review → approve-none/proceed.
 */
async function runReviewApprovalGate(
  root: string,
  artifactsDir: string,
  survivors: Finding[],
  autonomous = false,
): Promise<ReviewGateProceed | ReviewGateHalt> {
  const decisionPath = reviewDecisionPath(artifactsDir);

  // First crossing only: no decision yet AND the pipeline has not started.
  const gateOpen =
    survivors.length > 0 &&
    !existsSync(decisionPath) &&
    !contractArtifactExists(artifactsDir, "goal_spec");

  // Autonomous (unattended) mode: the gate NEVER halts. It re-evaluates the
  // survivors FRESH (no prior-run memory) and auto-approves only tier-safe +
  // allowlisted-change-kind findings; everything else is left LIVE. Leftovers
  // are re-emitted as a re-consumable audit deliverable pair (NO durable
  // rejection — leftovers carry no declined disposition). Idempotent: once
  // review_decision.json exists it is consumed directly below.
  if (gateOpen && autonomous) {
    const auto = buildAutonomousReviewDecision(survivors);
    const approvedSet = new Set(auto.approved_ids);
    // Leftovers stay LIVE: declined is EMPTY (no durable rejection). The
    // decision REPLAY keys on approved_ids (COR-227a02ae), so on later calls
    // exactly the approved subset — never the live leftovers — re-enters.
    const record: ReviewDecisionRecord = {
      schema_version: REVIEW_DECISION_SCHEMA_VERSION,
      plan_id: randomRunId("path-a-review"),
      approved_ids: auto.approved_ids,
      declined: [],
      created_at: new Date().toISOString(),
    };
    await writeJsonFile(decisionPath, record);
    // Re-emit the leftovers as a standard, re-consumable audit deliverable pair
    // so the next nightly run picks them up via defaultInputCandidates. Always
    // on disk regardless of whether a git remote / PR is available.
    const leftovers = survivors.filter((f) => !approvedSet.has(f.id));
    await emitAutonomousLeftoverDeliverable(root, artifactsDir, leftovers);
    return {
      kind: "proceed",
      approved: survivors.filter((f) => approvedSet.has(f.id)),
      declined: [],
    };
  }

  if (gateOpen) {
    const resolutionPath = reviewResolutionPath(artifactsDir);
    const requestPath = reviewRequestPath(artifactsDir);
    if (!existsSync(resolutionPath)) {
      // Halt: present the tiered survivors and wait for the user's decision.
      // The request's plan id is minted RUN-UNIQUE so a stale resolution from
      // another run can never correlate against it (COR-0b906e37).
      const request = buildReviewRequest(survivors, randomRunId("path-a-review"));
      await writeJsonFile(requestPath, request);
      return {
        kind: "halt",
        step: await handleWaitingForReviewApproval(root, artifactsDir, request),
      };
    }
    // Consume the resolution into a durable, reasoned decision record.
    // Regenerable: a stale-schema request is treated as absent and rebuilt below.
    const request =
      discardOnSchemaVersionMismatch(
        await readOptionalJsonFile<ReviewRequest>(requestPath),
        REVIEW_REQUEST_SCHEMA_VERSION,
      ) ?? buildReviewRequest(survivors, randomRunId("path-a-review"));
    const resolution = await readOptionalJsonFile<ReviewResolution>(resolutionPath);
    if (!isResolutionForRequest(request, resolution)) {
      // Stale cross-run resolution (plan_id mismatch): archive it and RE-HALT
      // with the live request rather than applying another run's answer.
      await withFsRetry(() =>
        rename(resolutionPath, `${resolutionPath}.stale-${Date.now()}`),
      );
      await writeJsonFile(requestPath, request);
      return {
        kind: "halt",
        step: await handleWaitingForReviewApproval(root, artifactsDir, request),
      };
    }
    const refusalStep = await refuseUnknownIdResolution(
      root, artifactsDir, request, resolution, resolutionPath, requestPath,
    );
    if (refusalStep) return { kind: "halt", step: refusalStep };
    const decision = applyReviewResolution(request, resolution);
    const record: ReviewDecisionRecord = {
      schema_version: REVIEW_DECISION_SCHEMA_VERSION,
      plan_id: request.plan_id,
      approved_ids: decision.approved_ids,
      declined: decision.declined,
      created_at: new Date().toISOString(),
    };
    await writeJsonFile(decisionPath, record);
    // Archive the consumed inputs so the gate cannot re-halt.
    for (const p of [resolutionPath, requestPath]) {
      if (existsSync(p)) {
        await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
      }
    }
  }

  // Decision recorded (now or on a prior call): split the survivors. The
  // replay honours the recorded approved_ids (COR-227a02ae) — an autonomous
  // decision approves a SUBSET with declined EMPTY (leftovers live but not
  // approved), so keying the replay on the declined set alone would silently
  // re-approve every leftover on the next call.
  // Discarded on mismatch — see the note at the sibling read: a stale-schema
  // decision record re-asks rather than replaying stale operator intent.
  const decision = discardOnSchemaVersionMismatch(
    await readOptionalJsonFile<ReviewDecisionRecord>(decisionPath),
    REVIEW_DECISION_SCHEMA_VERSION,
  );
  const declined = decision?.declined ?? [];
  const declinedIds = new Set(declined.map((d) => d.finding_id));
  const approvedIds = decision ? new Set(decision.approved_ids ?? []) : undefined;
  return {
    kind: "proceed",
    approved:
      approvedIds !== undefined
        ? survivors.filter((f) => approvedIds.has(f.id))
        : survivors.filter((f) => !declinedIds.has(f.id)),
    declined,
  };
}

/**
 * Re-emit the autonomous-run leftovers (findings left LIVE, neither auto-fixed
 * nor durably rejected) as a standard, re-consumable audit deliverable pair:
 * `audit-findings.json` (machine contract, source of truth) + `audit-report.md`
 * (human render), built by the SHARED emitter. Written to `<repo>/.audit-tools/`
 * — exactly where the remediator's `defaultInputCandidates` looks first — so the
 * next nightly run round-trips them straight back through intake and re-evaluates
 * the allowlist FRESH. Always on disk regardless of any git remote / PR.
 *
 * Empty leftovers still emit an (empty) pair so a downstream "is there work?"
 * probe sees a deterministic deliverable rather than a stale one.
 */
async function emitAutonomousLeftoverDeliverable(
  root: string,
  artifactsDir: string,
  leftovers: Finding[],
): Promise<void> {
  const pair = buildAuditDeliverablePair(leftovers, {
    title: "Audit Report — Autonomous Leftovers",
    intro:
      "Findings left LIVE by an unattended (autonomous) remediation run: not on the " +
      "fail-closed non-destructiveness allowlist (or not tier-safe), so not auto-fixed. " +
      "They carry NO declined disposition — re-run remediation to re-evaluate them.",
  });
  // REMEDIATION-OWNED PATH. This used to write the canonical
  // `.audit-tools/audit-findings.json` + `audit-report.md` pair directly, with
  // no archive: the audit source that `defaultInputCandidates` resolves first
  // was silently replaced by a remediation-authored render, and the original
  // contract was unrecoverable. The canonical pair is
  // audit-artifact-promotion-lifecycle's; anything that must replace it goes
  // through its exported write-with-archive
  // (artifact:canonical-audit-deliverable-write-path), never a raw write here.
  const findingsPath = autonomousLeftoverFindingsPath(root);
  const reportPath = autonomousLeftoverReportPath(root);
  await mkdir(dirname(findingsPath), { recursive: true });
  await Promise.all([
    writeJsonFile(findingsPath, pair.findings_report),
    writeTextFile(reportPath, pair.report_markdown),
  ]);
  // NAMED IN THE DURABLE LOG. A leftover emit that left no event was invisible
  // after the fact: an operator could not tell an emit from a silent no-op.
  // The run log is opened here rather than threaded down: the two frames above
  // this one carry no logger, and widening both signatures to pass one through
  // would touch call paths this change has no other business in.
  new RunLogger(join(artifactsDir, "run.log.jsonl"), { enabled: true }).event({
    phase: "next-step",
    kind: "outcome",
    obligation: "autonomous_leftovers",
    note:
      `autonomous_leftover_deliverable findings=${String(leftovers.length)} ` +
      `path=${findingsPath}`,
  });
}

// ── Path-A filter dispositions (persisted for the coverage ledger) ──────────────
// The single filter pass runs at intake over the ORIGINAL findings; its
// dispositions are persisted here so handlePendingExtractedPlan can build the
// coverage ledger over the originals (every audit finding → exactly one
// disposition), even though it runs after the pipeline has collapsed the approved
// survivors into DAG nodes. Maps are serialized as entry arrays for JSON.

const REVIEW_FILTER_DISPOSITIONS_FILENAME = "review_filter_dispositions.json";

interface PersistedReviewFilterDispositions {
  originals: Finding[];
  mergeMap: [string, string][];
  droppedNoEvidence: string[];
  droppedPhantomPaths: [string, string[]][];
  phantomPathsRemoved: [string, string[]][];
  droppedByCheckpoint: string[];
}

function reviewFilterDispositionsPath(artifactsDir: string): string {
  return join(artifactsDir, REVIEW_FILTER_DISPOSITIONS_FILENAME);
}

async function persistReviewFilterDispositions(
  artifactsDir: string,
  originals: Finding[],
  filter: FindingFilterResult,
): Promise<void> {
  const payload: PersistedReviewFilterDispositions = {
    originals,
    mergeMap: [...filter.mergeMap.entries()],
    droppedNoEvidence: filter.droppedNoEvidence,
    droppedPhantomPaths: [...filter.droppedPhantomPaths.entries()],
    phantomPathsRemoved: [...filter.phantomPathsRemoved.entries()],
    droppedByCheckpoint: filter.droppedByCheckpoint,
  };
  await writeJsonFile(reviewFilterDispositionsPath(artifactsDir), payload);
}

async function handleReadyIntakeContractPipeline(
  root: string,
  artifactsDir: string,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep | RemediationState | null> {
  // Fast path: if an extracted-plan.json already exists (pipeline complete or
  // promoted from a previous contract pipeline run), consume it directly without
  // requiring intake artifacts. This handles both "plan promoted, ready to
  // ground+plan" and the grounding tests that write extracted-plan.json directly.
  const earlyExtractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (earlyExtractedPlan) {
    return handlePendingExtractedPlan(
      root,
      artifactsDir,
      { status: "pending" },
      earlyExtractedPlan,
      runLogger,
    );
  }

  const intake = await readIntakeArtifacts(artifactsDir);
  if (!intake.summary || !isIntakeReady(intake.summary)) {
    return null;
  }

  // Resolve the manifest sources ONCE for the whole step (risk signal, Path A,
  // and the pipeline source inputs all consume the same snapshot), and read the
  // structured-audit source file at most once via a memoized reader (an
  // unreadable source memoizes `undefined`; extractAuditFindings on undefined
  // yields the empty set, so consumers degrade exactly as before).
  const manifestSources = intake.manifest
    ? resolveManifestSources(root, intake.manifest).resolved
    : [];
  const auditSource =
    intake.summary.source_type === "structured_audit"
      ? manifestSources.find((s) => s.type === "structured_audit")
      : undefined;
  let auditFindingsCache: { value: unknown } | undefined;
  const readAuditFindingsOnce = async (): Promise<unknown> => {
    if (!auditSource) {
      return undefined;
    }
    if (!auditFindingsCache) {
      let value: unknown;
      try {
        value = JSON.parse(await readFile(auditSource.path, "utf8")) as unknown;
      } catch {
        value = undefined;
      }
      auditFindingsCache = { value };
    }
    return auditFindingsCache.value;
  };

  // Slice 2 — compute & persist the shared intake risk/complexity signal the
  // self-scaling dials (Slices 3/4) will read. Idempotent: recorded once from
  // intake-available data only (affected_files + goals + path-risk patterns), so
  // a later escalate-on-evidence raise is never clobbered. The audit-source read
  // happens only on the run that actually computes (memoized above), and for
  // structured_audit — where the top-level summary.affected_files is
  // legitimately empty (paths live per-finding) — it unions the per-finding
  // affected files so the path-risk patterns actually fire (fail-closed: a
  // risky-subsystem audit must not land `low`). No behavior keys on it yet —
  // this establishes the source of truth.
  await ensureIntakeRiskSignal(artifactsDir, async () => {
    const summary = intake.summary!;
    const affectedFiles = summary.affected_files.map((f) => f.path);
    const parsed = await readAuditFindingsOnce();
    affectedFiles.push(...distinctAffectedFiles(extractAuditFindings(parsed)));
    return { affectedFiles, goals: summary.goals };
  });

  const pipeline = shouldEnterContractPipeline(
    artifactsDir,
    intake.summary.source_type,
  );
  if (!pipeline.shouldHandleContractPipeline) {
    return null;
  }

  const canonicalIntent = sessionIntentResult(options).intent;

  // Path A: run the single filter pass over the ORIGINAL findings, present the
  // SURVIVORS at the review gate (deduped / evidence-bearing / path-grounded /
  // checkpoint-kept, tiered by review-necessity), then seed the pipeline with the
  // approved survivors. The filter dispositions are persisted so the coverage
  // ledger is built over the originals (every audit finding → exactly one
  // disposition). The gate may halt to collect the user's decision.
  let reviewSourceSwap: { from: string; to: string } | undefined;
  if (auditSource) {
    const auditFindings = await readAuditFindingsOnce();
    const originals = extractAuditFindings(auditFindings);
    if (originals.length > 0) {
      const checkpoint = await readOptionalJsonFile<IntentCheckpoint>(
        join(artifactsDir, "intent_checkpoint.json"),
      );
      const filter = await runFindingFilterPass(originals, {
        root,
        checkpoint: checkpoint ?? undefined,
        evidenceGrounding: true,
      });
      const gate = await runReviewApprovalGate(
        root,
        artifactsDir,
        filter.survivors,
        // Autonomous review changes the approval policy only; it never grants
        // implementation or process-execution authority.
        canonicalIntent.review_mode === "autonomous",
      );
      if (gate.kind === "halt") {
        return gate.step;
      }
      // Persist the filter dispositions so coverage is built over the originals.
      await persistReviewFilterDispositions(artifactsDir, originals, filter);

      // Fold the APPROVED set's finding-level risk (grounding / confidence /
      // coupling / systemic / architecture / count — the finding-QUALITY dimension the
      // intake path/breadth/intent signal doesn't see) INTO the shared risk signal as
      // escalate-on-evidence. The tier is the SINGLE classifier and the ONLY thing it
      // selects is DEPTH: every run enters the contract pipeline, and a `low` tier
      // traverses it shallowly (collapsed round-trips, light adversarial depth). There
      // is no second plan producer and no bypass — see COLLAPSE_GROUPS.
      const findingEvidence = findingRiskEvidence(gate.approved);
      let riskSignal = await readIntakeRiskSignal(artifactsDir);
      if (findingEvidence && riskSignal) {
        const raised = escalateRiskSignal(riskSignal, findingEvidence);
        // escalateRiskSignal returns the SAME reference when the evidence does not
        // raise the tier — only persist on an actual change (no byte-identical rewrite).
        if (raised !== riskSignal) {
          riskSignal = raised;
          await writeIntakeRiskSignal(artifactsDir, riskSignal);
        }
      }
      // Seed the pipeline with the approved survivors only. When that set is
      // narrower than the originals (anything filtered or declined), route the
      // seed AND the pipeline's source inputs at a filtered file so a removed
      // finding can never re-enter via the raw audit-findings.json (tool-enforced).
      const approvedPayload = projectAuditFindingsReportSubset(
        auditFindings,
        gate.approved,
      );
      let seedSourcePath = auditSource.path;
      if (gate.approved.length < originals.length) {
        await mkdir(contractPipelineDir(artifactsDir), { recursive: true });
        seedSourcePath = join(contractPipelineDir(artifactsDir), "approved-findings.json");
        await writeJsonFile(seedSourcePath, approvedPayload);
        reviewSourceSwap = { from: auditSource.path, to: seedSourcePath };
      }
      await writePathASeedFromFindings(
        artifactsDir,
        seedSourcePath,
        approvedPayload,
      );
    }
  }

  const paths = intakePaths(artifactsDir);
  const sourcePaths = new Set<string>();
  if (existsSync(paths.brief)) {
    sourcePaths.add(paths.brief);
  }
  for (const source of manifestSources) {
    // Swap the raw audit-findings.json for the approved-only filtered file so a
    // declined finding can never re-enter the pipeline as a source input.
    sourcePaths.add(
      reviewSourceSwap && source.path === reviewSourceSwap.from
        ? reviewSourceSwap.to
        : source.path,
    );
  }

  // The adversarial 'critique' / 'critic' / 'judge' prompts carry the
  // LANE-CLASS-conditional independence mandate (shared
  // `renderIndependentReviewMandate`) — capability-neutral by design resolution
  // 2, so no dispatch-capability resolution is threaded into the pipeline here.

  const step = await buildNextContractPipelineStep({
    root,
    artifactsDir,
    runId: randomRunId("CONTRACT"),
    sourcePaths: [...sourcePaths],
  });
  if (step) {
    return step;
  }

  const extractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (!extractedPlan) {
    return null;
  }
  return handlePendingExtractedPlan(
    root,
    artifactsDir,
    { status: "pending" },
    extractedPlan,
    runLogger,
  );
}

async function handlePendingIntake(
  root: string,
  artifactsDir: string,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep | RemediationState | null> {
  // Short-circuit: if an extracted-plan.json already exists (promoted from the
  // contract pipeline), consume it directly without requiring intake artifacts.
  // This allows decideNextStep to resume a plan-grounding pass even when the
  // full intake artifact set is no longer present.
  const earlyExtractedPlan = await readExtractedPlanIfPresent(artifactsDir);
  if (earlyExtractedPlan) {
    return handleReadyIntakeContractPipeline(
      root,
      artifactsDir,
      options,
      runLogger,
    );
  }

  const inputResolution = resolveInputPaths(root, options.input);
  const intakeResult = await resolveIntakeStep({
    root,
    artifactsDir,
    input: options.input,
    inputResolution,
    loaderCommand,
    randomRunId,
    collectStartingPointPrompt,
    synthesizeIntakePrompt,
    collectIntakeClarificationsPrompt,
  });
  if (intakeResult.kind === "step") {
    return intakeResult.step;
  }
  // Intake is complete — route both paths through the contract pipeline.
  return handleReadyIntakeContractPipeline(
    root,
    artifactsDir,
    options,
    runLogger,
  );
}

async function handleNoState(
  root: string,
  artifactsDir: string,
): Promise<RemediationStep> {
  const paths = intakePaths(artifactsDir);
  return writeCurrentStep({
    stepKind: "collect_starting_point",
    status: "blocked",
    runId: randomRunId("INPUT"),
    repoRoot: root,
    artifactsDir,
    prompt: collectStartingPointPrompt(
      root,
      defaultInputCandidates(root),
      [],
      paths,
    ),
    allowedCommands: [loaderCommand("next-step"), loaderCommand("next-step --input <path>")],
    stopCondition:
      "Stop after collecting a remediation starting point and rerunning next-step.",
    artifactPaths: {
      source_manifest: paths.sourceManifest,
      conversation_start: paths.conversationStart,
    },
  });
}

async function handleInputConflict(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  inputResolution: InputResolution,
): Promise<RemediationStep> {
  const planId = state.plan?.plan_id ?? "(none)";
  const itemCount = state.items ? Object.keys(state.items).length : 0;
  const suppliedInline =
    inputResolution.checked.length > 0
      ? inputResolution.checked.map((p) => `\`${p}\``).join(", ")
      : "(new intake source via `--guidance-file`)";
  return writeCurrentStep({
    stepKind: "input_conflict",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# New intake source given, but a remediation run is already in progress

A remediation run already exists in \`${artifactsDir}\` and has advanced past intake,
so the new intake source you passed (\`--input\` or \`--guidance-file\`) will **not**
replace it — it would be ignored and the existing plan resumed and executed.

- **Current state**: \`${state.status}\`
- **Plan**: \`${planId}\` (${itemCount} item(s))
- **Supplied input**: ${suppliedInline}

Choose one explicitly and report the choice to the user:

1. **Resume the existing run** — re-run WITHOUT any \`--input\`/\`--guidance-file\`: \`${loaderCommand("next-step")}\`
2. **Start fresh from the new source** — first move aside or delete the existing
   \`${artifactsDir}\` directory (and the stale \`remediation-report.md\` /
   \`remediation-outcomes.json\` in \`.audit-tools/\`, which would otherwise be overwritten on completion),
   then re-run with your new source (\`${loaderCommand("next-step --input <path>")}\` or \`--guidance-file <path>\`).

Stop after presenting this choice. Do not advance the run until the user decides.
`,
    allowedCommands: [
      loaderCommand("next-step"),
      loaderCommand("next-step --input <path>"),
    ],
    stopCondition:
      "Stop after presenting the resume-vs-restart choice to the user.",
    artifactPaths: {
      state_file: join(artifactsDir, "state.json"),
    },
  });
}

// Action tokens are deliberately unambiguous so a host CANNOT lose an
// approved finding by a natural word choice at the ambiguity gate: "this
// candidate ambiguity isn't genuine" reads as a comment on the AMBIGUITY, so it
// must map to `clarified` (proceed with the finding), never to a drop. The
// finding-dropping token is named `reject_finding` — it speaks about the
// FINDING, not the ambiguity, and so can't be confused with "no ambiguity here."
type PlanClarificationAction = "clarified" | "reject_finding" | "defer";

const PLAN_CLARIFICATION_ACTIONS: readonly PlanClarificationAction[] = [
  "clarified",
  "reject_finding",
  "defer",
];

function isPlanClarificationAction(value: unknown): value is PlanClarificationAction {
  return (
    typeof value === "string" &&
    (PLAN_CLARIFICATION_ACTIONS as readonly string[]).includes(value)
  );
}

interface PlanClarificationResolution {
  finding_id: string;
  action: PlanClarificationAction;
  rationale?: string;
}

function normalizePlanClarificationResolutions(value: unknown): PlanClarificationResolution[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord).flatMap((entry) => {
      if (typeof entry.finding_id === "string" && isPlanClarificationAction(entry.action)) {
        return [
          {
            finding_id: entry.finding_id,
            action: entry.action,
            rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
          },
        ];
      }
      return [];
    });
  }
  if (!isRecord(value)) return [];
  if (Array.isArray((value as Record<string, unknown>).resolutions)) {
    return normalizePlanClarificationResolutions((value as Record<string, unknown>).resolutions);
  }
  if (Array.isArray((value as Record<string, unknown>).items)) {
    return normalizePlanClarificationResolutions((value as Record<string, unknown>).items);
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([findingId, entry]) => {
    if (!isRecord(entry)) return [];
    if (!isPlanClarificationAction(entry.action)) return [];
    return [{
      finding_id: typeof entry.finding_id === "string" ? entry.finding_id : findingId,
      action: entry.action,
      rationale: typeof entry.rationale === "string" ? entry.rationale : undefined,
    }];
  });
}

/**
 * Apply one clarification resolution to its item. Single-sourced so the up-front
 * ambiguity gate (part A) and the mid-run clarification round (part B) settle an
 * item identically: `clarified` re-opens it (pending) with the answer as context,
 * `reject_finding` closes it as not-a-real-issue (terminal `deemed_inappropriate`
 * disposition), and `defer` closes it as an explicit user deferral for this run.
 * Never resurrects a terminal item.
 */
function applyClarificationActionToItem(
  item: RemediationItemState,
  res: PlanClarificationResolution,
  now: string,
): void {
  if (res.action === "reject_finding") {
    item.status = "deemed_inappropriate";
    item.failure_reason = res.rationale;
    item.started_at ??= now;
    item.completed_at = now;
  } else if (res.action === "defer") {
    item.status = "ignored";
    item.failure_reason = res.rationale
      ? `User-deferred for this run: ${res.rationale}`
      : "User-deferred for this run.";
    item.started_at ??= now;
    item.completed_at = now;
  } else {
    item.status = "pending";
    item.clarification_context = res.rationale;
  }
}

/**
 * Consume clarification_resolution.json for plan-phase clarifications.
 * Mirrors the triage resolution consume: reject_finding → terminal,
 * clarified → re-open (pending) for implement dispatch. Archives the file.
 */
async function applyPlanClarificationResolution(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<{ kind: "applied"; state: RemediationState } | { kind: "refused"; step: RemediationStep }> {
  if (!state.plan || !state.items) return { kind: "applied", state };
  const resolutionPath = join(artifactsDir, "clarification_resolution.json");
  const resolutions = normalizePlanClarificationResolutions(
    await readOptionalJsonFile<unknown>(resolutionPath),
  );
  // Uniform id-join contract: an unknown finding_id refuses the WHOLE
  // resolution (archived, nothing applied) and re-halts with the unknown ids
  // named — the silent-continue alternative drops the user's answer on a typo'd
  // id and force-closes its item as abandoned at the fall-through below.
  const unknownIds = resolutions
    .map((r) => r.finding_id)
    .filter((id) => !state.items?.[id]);
  if (unknownIds.length > 0) {
    await withFsRetry(() =>
      rename(resolutionPath, `${resolutionPath}.refused-${Date.now()}`),
    );
    return {
      kind: "refused",
      step: await handleWaitingForClarification(
        root,
        artifactsDir,
        state,
        `finding id(s) not in the plan: ${unknownIds.map((i) => `\`${i}\``).join(", ")}`,
      ),
    };
  }
  const now = new Date().toISOString();
  let appliedCount = 0;
  for (const res of resolutions) {
    const item = state.items[res.finding_id];
    if (!item || isTerminalStatus(item.status)) continue;
    applyClarificationActionToItem(item, res, now);
    appliedCount += 1;
  }
  // An applied answer mutates item state that is baked into the dispatch
  // prompt, so the persisted workload binding is stale the moment a resolution
  // lands — a surviving record makes the next handoff prepare refuse its own
  // regenerated workload (and a non-implementing status refuses the save
  // outright). Mirrors the saveStateForPlan strip.
  if (appliedCount > 0) delete state.host_handoff;
  if (existsSync(resolutionPath)) {
    await withFsRetry(() => rename(resolutionPath, `${resolutionPath}.consumed-${Date.now()}`));
  }
  const remainingPending = state.plan.findings.some(
    (f) => state.items?.[f.id]?.status === "pending",
  );
  // Undecided-remainder guard, mirroring triage's still-blocked guard: a
  // resolution covering only SOME of the paused items must not fall through to
  // closing, which would force-close the undecided ones as `abandoned` and drop
  // their questions unanswered. Load-bearing now that the round runs at the
  // DRAINED end of the implement phase, where `remainingPending` is normally
  // false — the fall-through it guards is the common case, not a corner.
  // INV-RS-10 / OBL-seam-prep-remediate-core-inv-1: a resolution that disposes
  // of every remaining item does NOT write `closing` here. Writing it directly
  // satisfied the all_terminal derive (`status !== "closing"`) on the very next
  // scan, so the tool-owned final gate never ran for this arrival at close.
  // Landing in `implementing` lets the single all-terminal → closing funnel
  // (handleAllTerminalTransition) run the gate, exactly as every other closing
  // transition does; `closing_plan` is stamped by that funnel's successor, not
  // pre-stamped here (the gate-red pause must not leave a half-prepared close).
  state.status = remainingPending
    ? "implementing"
    : hasUnansweredClarification(state)
      ? "waiting_for_clarification"
      : "implementing";
  state.clarifications = [];
  await store.saveState(state);
  return { kind: "applied", state };
}

async function handleWaitingForClarification(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  refusal?: string,
): Promise<RemediationStep> {
  const clarifications =
    state.clarifications ??
    (await readOptionalJsonFile<ClarificationRequest[]>(
      join(artifactsDir, "clarification_request.json"),
    )) ??
    [];
  const resolutionPath = join(artifactsDir, "clarification_resolution.json");
  return writeCurrentStep({
    stepKind: "collect_clarifications",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: clarificationPrompt(clarifications, resolutionPath, refusal),
    allowedCommands: [loaderCommand("next-step")],
    stopCondition:
      "Stop after asking the user for clarification answers, unless the answers are already available and the prompt told you to continue.",
    artifactPaths: {
      clarification_request: join(artifactsDir, "clarification_request.json"),
      clarification_resolution: resolutionPath,
    },
  });
}

async function handleWaitingForTriage(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
  const resolutionPath = join(artifactsDir, "triage_resolution.json");
  return writeCurrentStep({
    stepKind: "collect_triage",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: triagePrompt(state, resolutionPath),
    allowedCommands: [loaderCommand("next-step")],
    stopCondition:
      "Stop after asking the user for triage decisions, unless the decisions are already available and the prompt told you to continue.",
    artifactPaths: {
      triage_batch: join(artifactsDir, "triage_batch.json"),
      triage_resolution: resolutionPath,
    },
  });
}

/**
 * Path-B (document / conversation) review-necessity gate, fired at the PLANNING
 * point over the deduped/grounded node findings. Path A records its review
 * decision at intake over the ORIGINAL findings — before the contract pipeline
 * collapses them into DAG nodes (`runReviewApprovalGate`). Path B has no
 * pre-pipeline finding set (its findings are DERIVED inside the pipeline), so it
 * is gated here instead. The decision is applied to the existing plan state:
 * declined nodes become a RECORDED terminal disposition (`ignored`) rather than
 * being silently bulk-dispositioned inside a quality-tail node — the 2026-06-15
 * failure this gate exists to prevent.
 *
 * The caller fires this only when `review_decision.json` is ABSENT, so Path A
 * (decision already written at intake) never reaches it — no double review.
 * Returns a halt step while awaiting the user's decision, or null to proceed
 * (decision recorded, any declined nodes marked terminal).
 */
async function runPlanningReviewGate(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<RemediationStep | null> {
  const findings = state.plan?.findings ?? [];
  if (findings.length === 0) return null;

  const requestPath = reviewRequestPath(artifactsDir);
  const resolutionPath = reviewResolutionPath(artifactsDir);
  const decisionPath = reviewDecisionPath(artifactsDir);

  // Path B correlates on the LIVE plan's own id (INV-RSM-RESOLUTION-CORRELATE):
  // the plan exists at the planning point, so its plan_id is the natural
  // run-unique key — a stale resolution from an earlier plan can never match.
  const reviewPlanId = state.plan?.plan_id ?? randomRunId("path-b-review");

  if (!existsSync(resolutionPath)) {
    // Halt: present the tiered node findings and wait for the user's decision.
    const request = buildReviewRequest(findings, reviewPlanId);
    await writeJsonFile(requestPath, request);
    return handleWaitingForReviewApproval(root, artifactsDir, request);
  }

  // Resolution present: consume it into a durable, reasoned decision record.
  // Regenerable: a stale-schema request is treated as absent and rebuilt below.
  const request =
    discardOnSchemaVersionMismatch(
      await readOptionalJsonFile<ReviewRequest>(requestPath),
      REVIEW_REQUEST_SCHEMA_VERSION,
    ) ?? buildReviewRequest(findings, reviewPlanId);
  const resolution = await readOptionalJsonFile<ReviewResolution>(resolutionPath);
  if (!isResolutionForRequest(request, resolution)) {
    // Stale cross-run resolution: archive it and re-halt with the live request.
    await withFsRetry(() =>
      rename(resolutionPath, `${resolutionPath}.stale-${Date.now()}`),
    );
    await writeJsonFile(requestPath, request);
    return handleWaitingForReviewApproval(root, artifactsDir, request);
  }
  const refusalStep = await refuseUnknownIdResolution(
    root, artifactsDir, request, resolution, resolutionPath, requestPath,
  );
  if (refusalStep) return refusalStep;
  const decision = applyReviewResolution(request, resolution);
  const record: ReviewDecisionRecord = {
    schema_version: REVIEW_DECISION_SCHEMA_VERSION,
    plan_id: request.plan_id,
    approved_ids: decision.approved_ids,
    declined: decision.declined,
    created_at: new Date().toISOString(),
  };
  await writeJsonFile(decisionPath, record);
  // Archive the consumed inputs so the gate cannot re-halt.
  for (const p of [resolutionPath, requestPath]) {
    if (existsSync(p)) {
      await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
    }
  }

  // Declined nodes → recorded terminal disposition (never a silent close).
  let changed = false;
  for (const { finding_id, reason } of decision.declined) {
    const it = state.items?.[finding_id];
    if (it && !isTerminalStatus(it.status)) {
      const now = new Date().toISOString();
      it.status = "ignored";
      it.failure_reason = reason;
      it.started_at ??= now;
      it.completed_at = now;
      changed = true;
    }
  }
  if (changed) await store.saveState(state);
  return null;
}

/**
 * Deterministic first pass (note 3, part A): scan the plan's non-terminal
 * findings for scoping/judgment ambiguity, classified into the canonical
 * clarification categories. These are CANDIDATES — the host reviews them against
 * the repo, dismisses false positives, and adds any it finds, before batching one
 * user round. Conservative by design: a candidate the host dismisses costs one
 * read; a real scoping question that falls silently to mid-run triage is the bug
 * this gate exists to prevent.
 */
function detectPlanAmbiguities(
  findings: Finding[],
  items: Record<string, RemediationItemState> | undefined,
): ClarificationRequest[] {
  const out: ClarificationRequest[] = [];
  for (const f of findings) {
    const item = items?.[f.id];
    if (item && isTerminalStatus(item.status)) continue;
    const lens = (f.lens ?? "").toLowerCase();
    const fileCount = f.affected_files?.length ?? 0;
    const broadScope =
      (lens === "architecture" || lens === "maintainability") &&
      (fileCount === 0 || fileCount >= 5);
    if (broadScope) {
      out.push({
        finding_id: f.id,
        category: "scope_of_fix",
        description:
          `"${f.title}" is a ${lens} finding with ${fileCount === 0 ? "no cited files" : `${fileCount} affected files`}; ` +
          "confirm how far the fix should reach (minimal local change vs. broader restructuring).",
      });
      continue;
    }
    if (f.confidence === "low") {
      out.push({
        finding_id: f.id,
        category: "issue_appropriateness",
        description:
          `"${f.title}" is a low-confidence finding; confirm it is a real issue worth fixing in this run.`,
      });
    }
  }
  return out;
}

/**
 * Up-front ambiguity gate (note 3, part A). Mirrors {@link runPlanningReviewGate}:
 * it fires once at planning, BEFORE any implement dispatch, so scoping/judgment
 * ambiguity is asked as a single batched question up front rather than falling
 * silently to triage mid-run. Deterministic heuristics seed CANDIDATES; the host
 * reviews them with repo access, dismisses/adds, and batches one user round. Each
 * item is resolved as `clarified` (answered → re-opened), `deemed_inappropriate`
 * (not a real issue), or `defer` (the user's explicit choice to skip this run).
 *
 * Idempotent: once `ambiguity_decision.json` exists the gate is done and never
 * re-halts. An empty resolution proceeds (the host found nothing to ask).
 */
async function runPlanAmbiguityGate(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<RemediationStep | null> {
  const findings = state.plan?.findings ?? [];
  if (findings.length === 0) return null;

  const requestPath = ambiguityRequestPath(artifactsDir);
  const resolutionPath = ambiguityResolutionPath(artifactsDir);
  const decisionPath = ambiguityDecisionPath(artifactsDir);

  if (!existsSync(resolutionPath)) {
    // Deterministic detection is the gate trigger: with zero candidates there is
    // nothing for the host to review, so the plan proceeds without a round. Any
    // ambiguity the heuristics miss is still caught by the mid-run escape hatch
    // (part B). When candidates exist, halt for the host's review + the user's
    // batched answers.
    const candidates = detectPlanAmbiguities(findings, state.items);
    if (candidates.length === 0) return null;
    await writeJsonFile(requestPath, candidates);
    return writeCurrentStep({
      stepKind: "collect_clarifications",
      status: "blocked",
      runId: stateRunId(state),
      repoRoot: root,
      artifactsDir,
      prompt: ambiguityReviewPrompt(candidates, resolutionPath, findings.map((f) => f.id)),
      allowedCommands: [loaderCommand("next-step")],
      stopCondition:
        "Stop after reviewing the candidate ambiguities (and asking the user any genuine ones), unless the resolution is already written and the prompt told you to continue.",
      artifactPaths: {
        ambiguity_request: requestPath,
        ambiguity_resolution: resolutionPath,
      },
    });
  }

  // Resolution present: apply it to items, mark the gate done, archive inputs so
  // it cannot re-halt.
  const resolutions = normalizePlanClarificationResolutions(
    await readOptionalJsonFile<unknown>(resolutionPath),
  );
  // Uniform id-join contract: a resolution naming a finding id outside the plan
  // is REFUSED whole (archived, nothing applied) and the gate re-halts with the
  // unknown ids named — the silent-continue alternative drops a host answer on a
  // typo'd id, leaving its item to fall to mid-run triage unexplained.
  const validIds = new Set(findings.map((f) => f.id));
  const unknownIds = resolutions
    .map((r) => r.finding_id)
    .filter((id) => !validIds.has(id));
  if (unknownIds.length > 0) {
    await withFsRetry(() =>
      rename(resolutionPath, `${resolutionPath}.refused-${Date.now()}`),
    );
    const candidates =
      (await readOptionalJsonFile<ClarificationRequest[]>(requestPath)) ??
      detectPlanAmbiguities(findings, state.items);
    return writeCurrentStep({
      stepKind: "collect_clarifications",
      status: "blocked",
      runId: stateRunId(state),
      repoRoot: root,
      artifactsDir,
      prompt: ambiguityReviewPrompt(
        candidates,
        resolutionPath,
        findings.map((f) => f.id),
        `finding id(s) not in the plan: ${unknownIds.map((i) => `\`${i}\``).join(", ")}`,
      ),
      allowedCommands: [loaderCommand("next-step")],
      stopCondition:
        "Stop after re-submitting a corrected ambiguity resolution, unless it is already written and the prompt told you to continue.",
      artifactPaths: {
        ambiguity_request: requestPath,
        ambiguity_resolution: resolutionPath,
      },
    });
  }
  const now = new Date().toISOString();
  let changed = false;
  for (const res of resolutions) {
    const item = state.items?.[res.finding_id];
    if (!item || isTerminalStatus(item.status)) continue;
    applyClarificationActionToItem(item, res, now);
    changed = true;
  }
  await writeJsonFile(decisionPath, { resolved_at: now, resolution_count: resolutions.length });
  for (const p of [resolutionPath, requestPath]) {
    if (existsSync(p)) {
      await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
    }
  }
  if (changed) await store.saveState(state);
  return null;
}

async function handlePlanning(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
): Promise<RemediateOutcome> {
  // Review-necessity gate (Path B). Path A records its review decision at intake,
  // over the ORIGINAL findings, before the contract pipeline collapses them into
  // DAG nodes; Path B (document / conversation) derives findings INSIDE the
  // pipeline, so it is gated here, at the planning point, over the deduped/
  // grounded node findings. Fires only when no decision exists yet, so Path A
  // (decision already written) never double-reviews. Declined nodes get a
  // recorded terminal disposition.
  if (state.plan && !existsSync(reviewDecisionPath(artifactsDir))) {
    const halt = await runPlanningReviewGate(root, artifactsDir, state, store);
    if (halt) return { kind: "emit", step: halt };
  }

  // Up-front ambiguity gate (note 3, part A): resolve every scoping/judgment
  // ambiguity in ONE batched round here, before any implement dispatch, so a
  // question never falls silently to mid-run triage. Fires at most once per run.
  if (state.plan && !existsSync(ambiguityDecisionPath(artifactsDir))) {
    const halt = await runPlanAmbiguityGate(root, artifactsDir, state, store);
    if (halt) return { kind: "emit", step: halt };
  }

  // Document phase dissolved (N-R13): planning transitions directly to
  // implementing, and the host workload reads finding context directly.
  const implementBlocks = implementableBlocks(state);
  if (implementBlocks.length > 0) {
    if (state.plan) {
      const integrity = await checkAffectedFileIntegrity(root, state.plan.findings);
      if (!integrity.is_clean) {
        const details = [
          ...integrity.changed.map((p) => `changed: ${p}`),
          ...integrity.missing.map((p) => `missing: ${p}`),
          ...integrity.io_errors.map((p) => `io-error: ${p}`),
        ];
        const replanCommand = loaderCommand("next-step --force-replan");
        return { kind: "emit", step: await writeCurrentStep({
          stepKind: "collect_starting_point",
          status: "blocked",
          runId: stateRunId(state),
          repoRoot: root,
          artifactsDir,
          prompt: [
            "## File integrity check failed",
            "",
            "The following files have changed since the remediation plan was created:",
            ...details.map((d) => `- ${d}`),
            "",
            "Re-run planning to pick up the current file state before implementation begins.",
            "Run:",
            "",
            `\`${replanCommand}\``,
          ].join("\n"),
          allowedCommands: [replanCommand],
          stopCondition: "Stop after re-planning completes.",
        }) };
      }
    }
  }

  // Transition directly to implementing — no separate document round.
  // Any pending item outside every attainable host dependency frontier is
  // dead-ended (INV-RS-01): a prerequisite was skipped/blocked, so its
  // verified-complete edge can never be satisfied — never dispatch a dependent
  // against an upstream surface that did not land. Mark it blocked so the run
  // advances to close rather than looping forever. A node that is merely
  // waiting on a still-running prerequisite is NOT here (it would appear in a
  // later eligible pass); only nodes with a permanently-unsatisfiable edge are.
  if (implementBlocks.length === 0) {
    for (const block of blockedByUnsatisfiedDependency(state)) {
      for (const findingId of block.items) {
        const it = state.items?.[findingId];
        if (!it || it.status !== "pending") continue;
        it.status = "blocked";
        it.failure_reason =
          it.failure_reason ??
          "A dependency node did not reach a verified-complete disposition " +
          "(a prerequisite was skipped, blocked, or the dependencies are cyclic); " +
          "the host handoff will not expose this node against an upstream " +
          "surface that never landed (INV-RS-01).";
      }
    }
  }

  state.status = "implementing";
  await store.saveState(state);
  return { kind: "transition", state };
}

async function handleImplementing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
  options: NextStepOptions,
): Promise<RemediateOutcome> {
  const triageStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "triage" });
  const triaged = await runTriagePhase(state, { root, artifactsDir });
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "triage", duration_ms: Date.now() - triageStart });
  // INV-RS-10 / OBL-seam-prep-remediate-core-inv-1..4 (the CP-NODE-3 review
  // finding): this is the ONE caller of runTriagePhase, shared by the
  // `implementing` and `triage` obligations, so it is also THE single seam
  // where a triage closing-intent crosses into close. Persisting
  // `status: "closing"` directly would satisfy the closing obligation on the
  // next scan and preempt the all-terminal → closing funnel's tool-owned final
  // gate — exactly the defect class the finding named. So the intent is
  // persisted under the NON-closing `triage` status first (keeping every
  // preparation runTriagePhase made — halted items already converted to
  // `abandoned`, `closing_context` stamped — so a gate-RED pause, which persists
  // nothing itself, cannot lose them: re-entering triage with zero blocked items
  // re-derives this exact intent instead of auto-retrying halted work), and only
  // then handed to the funnel, which runs the gate and owns the closing stamp.
  if (triaged.status === "closing") {
    const prepared = { ...triaged, status: "triage" as const };
    await store.saveState(prepared);
    return handleAllTerminalTransition(
      root,
      artifactsDir,
      prepared,
      store,
      options,
      runLogger,
    );
  }
  await store.saveState(triaged);
  return { kind: "transition", state: triaged };
}

function hasResolvedItems(state: RemediationState): boolean {
  return Object.values(state.items ?? {}).some((it) =>
    isVerifiedCompleteStatus(it.status),
  );
}

/**
 * WHICH suppression disabled the tool-owned final gate (INV-RS-10) for this run —
 * `skipFinalGate` (test hermeticity) or `REMEDIATE_SKIP_FINAL_GATE` — or null when
 * it is live. Single-sourced so the all-terminal gate and the per-phase boundary
 * gate agree, and so both RECORD the same reason.
 *
 * The reason is carried into the outcome record rather than collapsed to a
 * boolean: the environment skip is the quietest not-run in the system (it needs
 * no option, no argument and no code change to fire), so a record that says only
 * "disabled" would leave an operator unable to tell a deliberate test-hermeticity
 * run from a stray exported variable.
 */
function finalGateDisabledReason(options: NextStepOptions): string | null {
  if (options.skipFinalGate === true) return "skipFinalGate option";
  if (
    process.env.REMEDIATE_SKIP_FINAL_GATE === "1" ||
    process.env.REMEDIATE_SKIP_FINAL_GATE === "true"
  ) {
    return "REMEDIATE_SKIP_FINAL_GATE environment variable";
  }
  return null;
}

/**
 * The ONE way a gate evaluation is recorded, shared by BOTH gate families (the
 * phase-boundary gate and the all-terminal funnel), so neither can grow a second
 * executed/scoped-out/disabled vocabulary of its own.
 *
 * Writes the durable {@link writeFinalGateOutcomeRecord} artifact AND the run-log
 * event from the same values, so the two can never disagree about which of the
 * three happened.
 *
 * This is the affirmation the gate lacked. The floor's control flow was already
 * right — a scoped-out gate is deliberately NON-BLOCKING, a declared scope rather
 * than a vacuous pass — but the only thing either consumer wrote was
 * `passed=<bool>`, which is `true` for an executed green floor, for a scoped-out
 * target that ran nothing, and for a suppressed gate that was never reached. All
 * three produced byte-identical records, so "the suite passed" and "no suite ran"
 * were indistinguishable after the fact.
 */
async function recordFinalGateOutcome(ctx: {
  artifactsDir: string;
  state: RemediationState;
  scope: string;
  gateKey: string;
  runLogger: RunLogger;
  outcome: FinalGateOutcomeKind;
  passed: boolean;
  commandsRun: number;
  reason?: string;
  durationMs?: number;
}): Promise<void> {
  const ran = ctx.outcome === "executed";
  await writeFinalGateOutcomeRecord(ctx.artifactsDir, {
    scope: ctx.scope,
    outcome: ctx.outcome,
    passed: ctx.passed,
    commands_run: ctx.commandsRun,
    ...(ctx.reason === undefined ? {} : { reason: ctx.reason }),
  });
  ctx.runLogger.event({
    phase: "next-step",
    kind: "executor_end",
    obligation: ctx.state.status,
    note:
      `${ctx.gateKey} outcome=${ctx.outcome} ` +
      // "n/a", never "true": a gate that ran nothing has no verdict, and the
      // durable record it is written beside carries `passed: null` for the
      // same reason.
      `passed=${ran ? String(ctx.passed) : "n/a"} ` +
      `commands=${ran ? String(ctx.commandsRun) : "0"}` +
      (ctx.reason === undefined ? "" : ` reason=${ctx.reason}`),
    ...(ctx.durationMs === undefined ? {} : { duration_ms: ctx.durationMs }),
  });
}

/**
 * The ONE response to a red tool-owned gate, shared by both gates that run it.
 *
 * Records the failing command beneath the artifacts dir and emits a resumable
 * `final_gate_red` step. It MUTATES NOTHING — no item status, no `state.status`,
 * no persisted state write at all — because a whole-repo red is unattributable:
 * nothing in the gate computes which item or path caused it, so every response
 * that touches items is guessing. The predecessor guessed by re-opening all of
 * them, and on 2026-08-20 that erased 21 accepted resolutions over a red from an
 * unrelated landed commit.
 *
 * Resumable BY CONSTRUCTION rather than by stored progress: the next next-step
 * re-runs the gate, and a green one proceeds exactly as if the red never
 * happened. There is nothing to reset and no counter that can strand the run.
 *
 * The prompt carries the failing command line and the PATH to the record — never
 * the captured output, which stays in the artifact where a multi-KB suite log
 * costs nothing.
 *
 * COST OF THE PAUSE, stated in the prompt rather than discovered: there is no
 * cached verdict, so EVERY next-step taken while the suite is red re-runs the
 * whole gate — a full build plus the whole suite, minutes, holding the phase
 * lock throughout. That is the deliberate price of having no counter to strand
 * the run on, and it makes polling expensive: the host should re-run once it has
 * actually fixed something, not on a timer.
 */
async function emitFinalGateRedStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  scope: string;
  gate: ToolOwnedFinalGateResult;
  runLogger: RunLogger;
}): Promise<RemediateOutcome> {
  const { root, artifactsDir, state, scope, gate, runLogger } = ctx;
  const failed = gate.results.find((r) => !r.passed);
  const recordPath = await writeFinalGateRedRecord(artifactsDir, scope, failed);
  const failingCommand = failed
    ? `${failed.argv.join(" ")} (exit ${String(failed.exit_code)})`
    : "(the gate reported no failing command)";
  runLogger.event({
    phase: "next-step",
    kind: "outcome",
    obligation: state.status,
    note: `final_gate_red scope=${scope} command=${failed ? failed.argv.join(" ") : "unknown"}`,
  });
  const nextCommand = loaderCommand("next-step");
  return {
    kind: "emit",
    step: await writeCurrentStep({
      stepKind: "final_gate_red",
      status: "blocked",
      runId: stateRunId(state),
      repoRoot: root,
      artifactsDir,
      prompt: `
# Remediation paused — the repository suite is red

The tool-owned gate (${scope}) ran the repository's own build/typecheck/test
floor and it FAILED. Nothing about this run has been changed: every item keeps
the status it had, the run stays in the same phase, and no work was discarded.

Failing command:

\`${failingCommand}\`

The captured output tail is recorded at:

\`${recordPath}\`

A red here is whole-repo and says nothing about which remediation item caused
it — it may not be this run's doing at all (a commit landed alongside the run is
enough). So this is a PAUSE, not a verdict on the work.

Fix the failing command — or confirm it was already broken independently of this
run — then run:

\`${nextCommand}\`

The gate re-runs from scratch. The moment it is green the run continues exactly
where it left off.

Re-run it DELIBERATELY, not on a timer: there is no cached verdict, so every
next-step taken while the suite is red re-runs the entire gate — a full build
plus the whole suite, minutes, holding the run's phase lock the whole time.
Fix something first, then re-run.
`,
      allowedCommands: [nextCommand],
      stopCondition:
        "Stop. Make the repository suite green, then re-run next-step to resume the run.",
      artifactPaths: { final_gate_record: recordPath },
    }),
  };
}

/**
 * Whole-repo test-suite gate at a foundations→consumers PHASE BOUNDARY (T3). Runs
 * the tool-owned final gate (INV-RS-10) INLINE before the next phase dispatches,
 * so an integration break introduced by a just-completed foundations phase is
 * caught — and attributed to that phase — before consumers are built on top of it
 * (strictly earlier + more attributable than the all-terminal gate, whose red is
 * unattributable across every phase).
 *
 * A red RECORDS and PAUSES — see {@link emitFinalGateRedStep}. It mutates no item,
 * moves no phase, and writes no state. (It used to re-open every item and, at a
 * bound, abandon the run; that backstop is gone, along with the counter sidecar
 * that drove it.)
 *
 * Returns the pause step when the gate is RED, or null when no gate is due this
 * pass OR the gate is GREEN — in which case the caller proceeds to dispatch the
 * phase.
 */
async function runPhaseBoundaryGate(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  options: NextStepOptions;
  runLogger: RunLogger;
}): Promise<RemediateOutcome | null> {
  const { root, artifactsDir, state, options, runLogger } = ctx;
  // Whether a gate is DUE is decided BEFORE whether it is suppressed. The old
  // order asked the suppression first and returned, so a disabled run could not
  // tell "no gate was due this pass" from "a gate was due and skipped" — and the
  // second is the one worth recording.
  const phase = phaseBoundaryToGate(state);
  if (phase == null) return null;
  const scope = `phase ${phase} boundary`;
  const disabledReason = finalGateDisabledReason(options);
  if (disabledReason !== null) {
    await recordFinalGateOutcome({
      artifactsDir,
      state,
      scope,
      gateKey: `phase_boundary_gate phase=${phase}`,
      runLogger,
      outcome: "disabled",
      passed: false,
      commandsRun: 0,
      reason: disabledReason,
    });
    return null;
  }

  const gateStart = Date.now();
  runLogger.event({
    phase: "next-step",
    kind: "executor_start",
    obligation: state.status,
    note: `phase_boundary_gate phase=${phase}`,
  });
  const gate = await runToolOwnedFinalGate(root, { runner: options.finalGateRunner });
  await recordFinalGateOutcome({
    artifactsDir,
    state,
    scope,
    gateKey: `phase_boundary_gate phase=${phase}`,
    runLogger,
    outcome: gate.outcome,
    passed: gate.passed,
    commandsRun: gate.results.length,
    ...(gate.outcome === "scoped_out"
      ? { reason: "target is not the audit-tools monorepo" }
      : {}),
    durationMs: Date.now() - gateStart,
  });
  if (gate.passed) return null; // green (or declared-out-of-scope) → dispatch

  // RED at the boundary. The next phase does NOT dispatch — but nothing is
  // re-opened or closed either; the run pauses exactly where it stands.
  return emitFinalGateRedStep({
    root,
    artifactsDir,
    state,
    scope,
    gate,
    runLogger,
  });
}

async function handleAllTerminalTransition(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  store: StateStore,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediateOutcome> {
  const disabledReason = finalGateDisabledReason(options);
  const gateDisabled = disabledReason !== null;
  const scope = "all-terminal final gate";

  // The tool-owned final gate (INV-RS-10) runs at the single all-terminal →
  // closing funnel, on EVERY arrival here. It is skipped only when:
  //  - there is nothing resolved to validate (everything blocked/skipped), or
  //  - it is explicitly disabled for test hermeticity.
  // There is deliberately no third "already gave up" skip: the flag that used to
  // provide one made a run that hit the old backstop's bound skip the suite check
  // permanently, so the gate it exists to enforce stopped running exactly when it
  // mattered most. The gate is INDEPENDENT of plan.test_command and runs through
  // the env-scrubbing runTracked path.
  if (!gateDisabled && hasResolvedItems(state)) {
    const gateStart = Date.now();
    runLogger.event({
      phase: "next-step",
      kind: "executor_start",
      obligation: state.status,
      note: "tool_owned_final_gate",
    });
    const gate = await runToolOwnedFinalGate(root, { runner: options.finalGateRunner });
    await recordFinalGateOutcome({
      artifactsDir,
      state,
      scope,
      gateKey: "tool_owned_final_gate",
      runLogger,
      outcome: gate.outcome,
      passed: gate.passed,
      commandsRun: gate.results.length,
      ...(gate.outcome === "scoped_out"
        ? { reason: "target is not the audit-tools monorepo" }
        : {}),
      durationMs: Date.now() - gateStart,
    });

    if (!gate.passed) {
      // A whole-repo red at the closing funnel is exactly as unattributable as
      // one at a phase boundary, so it gets the same answer: record and pause.
      // The run does NOT advance to `closing` — closing on a red would write a
      // report claiming an outcome the suite never corroborated.
      return emitFinalGateRedStep({
        root,
        artifactsDir,
        state,
        scope,
        gate,
        runLogger,
      });
    }
  } else {
    // The gate was DUE at the closing funnel and did not run. Recorded, with
    // WHICH suppression did it — the run is about to transition to `closing`
    // and write a completion report, and without this the report would be
    // byte-identical to one produced after a green floor.
    await recordFinalGateOutcome({
      artifactsDir,
      state,
      scope,
      gateKey: "tool_owned_final_gate",
      runLogger,
      outcome: "disabled",
      passed: false,
      commandsRun: 0,
      reason:
        disabledReason ??
        "no verified-complete items to validate (nothing resolved)",
    });
  }

  state.status = "closing";
  await store.saveState(state);
  return { kind: "transition", state };
}

async function handleClosing(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  runLogger: RunLogger,
  store: StateStore,
): Promise<RemediateOutcome> {
  const closeStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "close" });
  const closed = await runClosePhase(state, { root, artifactsDir }, runLogger);
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "close", duration_ms: Date.now() - closeStart });
  if (closed.status !== "complete") {
    // Not done (preview / re-blocked to triage): persist and re-scan.
    await store.saveState(closed);
    return { kind: "transition", state: closed };
  }
  // Close-complete CROSSES the engine boundary: `complete` is a pre-intake
  // obligation, unreachable from a main-engine transition. Emit the durable
  // report directly, passing exactly what the original recursion reloaded — the
  // artifact dir is DELETED on a fully-green close (reload → null → stateRunId
  // falls back to "run") and PRESERVED on a not-green complete (reload → the
  // saved complete state → its plan_id). `store.loadState()` reproduces both, so
  // present_report is identical to the cascade.
  // (Regression-locked in next-step-implement-dispatch.)
  return {
    kind: "emit",
    step: await handleComplete(root, artifactsDir, await store.loadState()),
  };
}

async function handleZeroDocumentableFindings(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
  const nextStepCommand = loaderCommand("next-step");
  const nextStepInputCommand = loaderCommand("next-step --input <path>");
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  return writeCurrentStep({
    stepKind: "zero_documentable_findings",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# No Documentable Findings

The remediation plan is in the \`planning\` state but there are no findings with
status \`pending\` — every finding has already been documented, ignored, or
deemed inappropriate.

Choose one of the following options:

1. **Adjust or remove the intent checkpoint** — edit or delete
   \`${checkpointPath}\`, then re-run:

   \`${nextStepCommand}\`

2. **Supply a different input file** — provide a new audit report or feedback
   file as the remediation source, then re-run with:

   \`${nextStepInputCommand}\`

3. **Stop** — no further remediation work is needed. You may stop now.

Report this situation to the user and let them choose.
`,
    allowedCommands: [nextStepCommand, nextStepInputCommand],
    stopCondition:
      "Stop after presenting the three choices to the user and waiting for their decision.",
  });
}

/**
 * The terminal for a fold that stopped WITHOUT converging.
 *
 * Distinct from `unhandled_state` on purpose. That kind means "the state machine
 * has no transition for this state" — a gap in the registry. This one means an
 * obligation kept transitioning without ever clearing its own actionable state,
 * so the fold spun until the engine's backstop fired. Conflating them would send
 * an operator to inspect a state that is perfectly well-formed, and the repo's
 * own step types forbid conflating distinct causes.
 *
 * The description comes from the engine's `describeStoppedFold`, so the cause
 * phrasing and the spinning obligation are read from the outcome's structured
 * fields rather than rebuilt here — the same single source the audit draw uses.
 */
async function handleStoppedFold(
  root: string,
  artifactsDir: string,
  state: RemediationState | null,
  stalled: StoppedFoldDescription,
): Promise<RemediationStep> {
  return writeCurrentStep({
    stepKind: "fold_did_not_converge",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# Fold Did Not Converge

The deterministic fold ${stalled.cause}.

- **Spinning obligation**: \`${stalled.spinning}\`
- **Backstop that fired**: \`${stalled.stopped}\`
- **State file**: \`${join(artifactsDir, "state.json")}\`

An obligation is re-selecting without clearing its own actionable state, so the
engine stopped the fold rather than looping forever. This is a blocking
diagnostic, not a resumable pause: re-running \`next-step\` will reproduce it.

Inspect the obligation named above. Either its \`derive\` never goes
non-actionable after its \`execute\` runs, or its executor is persisting a state
its own guard still matches.
`.trim(),
    stopCondition: "Stop after reporting the diagnostic to the user.",
  });
}

async function handleUnhandledState(
  root: string,
  artifactsDir: string,
  state: RemediationState,
): Promise<RemediationStep> {
  const itemsByStatus: Record<string, string[]> = {};
  for (const item of Object.values(state.items ?? {})) {
    (itemsByStatus[item.status] ??= []).push(item.finding_id);
  }
  const statusBreakdown = Object.entries(itemsByStatus)
    .map(([status, ids]) => `- **${status}**: ${ids.join(", ")}`)
    .join("\n");

  return writeCurrentStep({
    stepKind: "unhandled_state",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: `
# Unhandled State

The remediation workflow reached a state it has no transition for.

- **State status**: \`${state.status}\`
- **State file**: \`${join(artifactsDir, "state.json")}\`

## Item Breakdown

${statusBreakdown || "No items in state."}

Report this diagnostic to the user and stop. Do not attempt to advance the run.
`,
    allowedCommands: [],
    stopCondition: "Stop after reporting the diagnostic to the user.",
  });
}

export async function decideNextStep(
  options: NextStepOptions | string = {},
): Promise<RemediationStep> {
  const normalizedOptions = coerceJsonObjectArg<Record<string, unknown>>(
    options as Record<string, unknown> | string | undefined,
    "decideNextStep options",
  ) as NextStepOptions;
  const root = resolveRoot(normalizedOptions.root);
  const artifactsDir = resolveArtifactsDir(root, normalizedOptions.artifactsDir);
  const sessionIntent = await loadRemediateSessionConfig({ root });
  const internalOptions: InternalNextStepOptions = {
    ...normalizedOptions,
    [SESSION_INTENT_RESULT]: sessionIntent,
  };
  const runLogger = new RunLogger(join(artifactsDir, "run.log.jsonl"), {
    enabled: true,
  });
  const startedAt = Date.now();
  try {
    const step = await decideNextStepLoop(internalOptions, runLogger);
    runLogger.event({
      phase: "next-step",
      kind: "step",
      obligation: step.step_kind,
      note: step.status,
      duration_ms: Date.now() - startedAt,
    });
    return step;
  } catch (error) {
    runLogger.event({
      phase: "next-step",
      kind: "error",
      duration_ms: Date.now() - startedAt,
      note: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function buildConfirmResumeOrRestartStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  ackPath: string;
}): Promise<RemediationStep> {
  const { root, artifactsDir, state, ackPath } = ctx;
  const runId = stateRunId(state);
  const nextCommand = loaderCommand("next-step");

  const itemsByStatus: Record<string, number> = {};
  for (const item of Object.values(state.items ?? {})) {
    itemsByStatus[item.status] = (itemsByStatus[item.status] ?? 0) + 1;
  }
  const statusLines = Object.entries(itemsByStatus)
    .map(([status, count]) => `- **${status}**: ${count}`)
    .join("\n");

  return writeCurrentStep({
    stepKind: "confirm_resume_or_restart",
    status: "blocked",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt: [
      "# Remediation Run Already In Progress",
      "",
      "A remediation run is already in progress. Choose what to do:",
      "",
      `- **Current state**: \`${state.status}\``,
      `- **Plan**: \`${state.plan?.plan_id ?? "(none)"}\``,
      `- **Started**: ${state.started_at ?? "(unknown)"}`,
      "",
      "## Item Counts",
      "",
      statusLines || "No items in state.",
      "",
      "## Choices",
      "",
      "1. **Resume** — continue the existing run. Write to the ack file:",
      "   ```json",
      '   { "choice": "resume" }',
      "   ```",
      "   Then re-run without `--input`:",
      `   \`${nextCommand}\``,
      "",
      "2. **Restart from new input** — delete the existing run and start fresh.",
      "   Write to the ack file:",
      "   ```json",
      '   { "choice": "restart" }',
      "   ```",
      `   Then delete \`${artifactsDir}\` and re-run with \`--input <path>\`.`,
      "",
      "3. **Merge new recommendations into existing plan** — carry the current plan",
      "   forward with additional findings merged in. Write to the ack file:",
      "   ```json",
      '   { "choice": "merge" }',
      "   ```",
      `   Then re-run with \`--input <path>\` pointing at your new recommendations.`,
      "",
      `Write your choice to: \`${ackPath}\``,
    ].join("\n"),
    allowedCommands: [nextCommand, loaderCommand("next-step --input <path>")],
    stopCondition:
      "Stop after presenting the resume/restart/merge choice to the user and writing the ack.",
    artifactPaths: {
      state_file: join(artifactsDir, "state.json"),
      confirm_resume_ack: ackPath,
    },
  });
}

async function buildConfirmIntentStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState | null;
}): Promise<RemediationStep> {
  const { root, artifactsDir, state } = ctx;
  const runId = stateRunId(state);
  const nextCommand = loaderCommand("next-step");
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");

  // Read the pre-drafted checkpoint if one exists (confirmed_by: "draft").
  const draft = await readOptionalJsonFile<IntentCheckpoint>(checkpointPath);
  const isDraft = draft?.confirmed_by === "draft";

  let prompt: string;
  if (isDraft && draft) {
    // Build a consolidated single-stop proposal from the draft.
    const draftRaw = draft as unknown as Record<string, unknown>;
    const preDraftQuestions: Array<{ id: string; question: string; blocking?: boolean }> =
      Array.isArray(draftRaw.pre_draft_questions)
        ? (draftRaw.pre_draft_questions as Array<{ id: string; question: string; blocking?: boolean }>)
        : [];
    // INV-remediate-state-06: only explicit blocking===true is blocking.
    const blockingQs = preDraftQuestions.filter((q) => q.blocking === true);
    const nonBlockingQs = preDraftQuestions.filter((q) => q.blocking !== true);
    const intentInterpretation = typeof draftRaw.intent_interpretation === "string" ? draftRaw.intent_interpretation : undefined;
    const suggestedClosingAction = typeof draftRaw.closing_action === "string" ? draftRaw.closing_action : undefined;

    const questionLines = [
      ...blockingQs.map((q) => `- **[blocking] ${q.id}**: ${q.question}`),
      ...nonBlockingQs.map((q) => `- **[FYI] ${q.id}**: ${q.question}`),
    ].join("\n") || "- None";

    const filtersBlock = draft.filters && Object.keys(draft.filters).length > 0
      ? `\`\`\`json\n${JSON.stringify(draft.filters, null, 2)}\n\`\`\``
      : "(none — remediating all findings)";

    const closingOptions = "`commit` or `none`";

    prompt = `
# Confirm Remediation Scope and Intent

The intake worker has pre-populated the following proposal. Review each section
and adjust where needed, then confirm by writing the final \`intent_checkpoint.json\`.

## Proposed Scope

${draft.scope_summary ?? "(not set)"}

## Proposed Intent

${draft.intent_summary ?? "(not set)"}
${intentInterpretation ? `\n**How free-form intent was interpreted:** ${intentInterpretation}\n` : ""}
## Proposed Filters

${filtersBlock}

## Open Questions

${questionLines}

## Suggested Closing Action

${suggestedClosingAction ?? "commit"} (valid options: ${closingOptions})

---

To confirm, write the final checkpoint to:

\`${checkpointPath}\`

\`\`\`json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp>",
  "confirmed_by": "host",
  "scope_summary": "${draft.scope_summary ?? "<the files/areas in scope>"}",
  "intent_summary": "${draft.intent_summary ?? "<the goal>"}",
  "free_form_intent": "<optional: additional guidance>",
  "filters": ${JSON.stringify(draft.filters ?? {}, null, 2)},
  "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],
  "must_not_touch": []
}
\`\`\`

Adjust \`filters\`, \`excluded_scope\`, \`must_not_touch\`, or \`free_form_intent\` to
narrow scope. Valid severities: ${VALID_SEVERITIES_PROSE}.
Valid lenses: ${VALID_LENSES_PROSE}.

Once written with \`"confirmed_by": "host"\`, run:

\`${nextCommand}\`
`;
  } else {
    // Fallback for when there is no pre-drafted checkpoint.
    prompt = `
# Confirm Remediation Scope and Intent

Please review the intake summary at \`.audit-tools/remediation/intake/intake-summary.json\` (and the audit report, if this run consumes one).

Confirm or refine the remediation scope and intent by writing a valid \`intent_checkpoint.json\` artifact under \`.audit-tools/remediation/\`.

Only \`scope_summary\` and \`intent_summary\` are required; add the optional fields to narrow what gets remediated:

\`\`\`json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp>",
  "confirmed_by": "host",
  "scope_summary": "<the files/areas in scope>",
  "intent_summary": "<the goal, e.g. full-remediation / security-only>",
  "free_form_intent": "<optional: interpreted into lens/priority ordering at planning; never threaded verbatim into worker prompts>",
  "filters": {
    "severity": ["critical", "high"],
    "lenses": ["security", "reliability"],
    "packages": ["<package or path prefix>"],
    "themes": ["<theme id>"]
  },
  "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],
  "must_not_touch": ["<glob>"]
}
\`\`\`

- \`filters\` drop findings that don't match BEFORE planning, so only the work you want is remediated. Valid severities: ${VALID_SEVERITIES_PROSE}. Valid lenses: ${VALID_LENSES_PROSE}. Draw \`packages\`/\`themes\` from the findings in the audit report.
- \`excluded_scope\` drops findings whose files match a path or directory prefix; \`must_not_touch\` globs are never written.
- Skipped findings are listed in the final remediation report under "Skipped by Intent Checkpoint".
- Leave the optional fields out to remediate everything in the report.

Once the file is written, run:

\`${nextCommand}\`
`;
  }

  return writeCurrentStep({
    stepKind: "confirm_intent",
    status: "ready",
    runId,
    repoRoot: root,
    artifactsDir,
    prompt,
    allowedCommands: [nextCommand],
    stopCondition: "Stop after writing intent_checkpoint.json and running next-step.",
    artifactPaths: {
      intent_checkpoint: checkpointPath,
    },
  });
}

// ---------------------------------------------------------------------------
// Deterministic free_form_intent interpretation at the call site (INV-S04)
// ---------------------------------------------------------------------------
//
// The IntentCheckpoint contract states `free_form_intent` is "interpreted into
// priority/lens/scope signals at planning time via freeFormIntentInterpreter.
// Never threaded verbatim into worker or dispatch prompts (INV-S04)." This is
// the call site that honours that: when a CONFIRMED checkpoint carries a
// free_form_intent, we run the shared deterministic interpreter HERE — never
// pass the raw string downstream — and persist the structured signals so
// planning consumes the encoded lens-weights/priority/scope, and so the
// unencodable clauses are surfaced (never silently dropped) rather than relying
// on an LLM-authored free-text `intent_interpretation`.

/** Sidecar artifact recording the deterministic interpretation of free_form_intent. */
export const INTENT_INTERPRETATION_FILENAME = "intent-interpretation.json";
// v1alpha2: unencodable_clauses carries identity-keyed records (clause_id +
// checkpoint_question), not bare strings — the shape the blocking consumer
// reads. A v1alpha1 sidecar (string[]) is stale and is repaired by
// re-derivation; it had no readers, so no migration path is owed.
export const INTENT_INTERPRETATION_SCHEMA_VERSION =
  "remediate-code-intent-interpretation/v1alpha2";

export interface PersistedIntentInterpretation {
  schema_version: typeof INTENT_INTERPRETATION_SCHEMA_VERSION;
  /** The interpreter's structured output (lens weights / priority / scope). */
  interpreted: InterpretedIntent;
  /**
   * Clauses the clause pipeline could not encode as a lens weight, priority
   * signal, or scope emphasis — with their stable identity and blocking
   * question. CONSUMED by the interpret_intent obligation: an unanswered
   * record blocks the decide loop until the host resolves it via a
   * `constraint_clauses` entry on the checkpoint (CE-004, identity-keyed).
   */
  unencodable_clauses: ConstraintClauseRecord[];
  created_at: string;
}

/**
 * Interpret a confirmed checkpoint's `free_form_intent` via the shared
 * deterministic interpreter and persist the structured signals to a sidecar
 * artifact. Idempotent and best-effort: returns the persisted interpretation (or
 * null when there is nothing to interpret / no confirmed checkpoint) and never
 * throws into the decide loop. The raw `free_form_intent` string is NOT returned
 * or threaded anywhere — only the structured `InterpretedIntent` is (INV-S04).
 */
export async function interpretConfirmedCheckpointIntent(
  artifactsDir: string,
  checkpoint: IntentCheckpoint | undefined,
  // Optional so the exported helper stays callable standalone; the decide loop
  // always supplies it, because an unencodable clause is an operator-visible
  // loss of intent and belongs in the durable log, not only on stderr.
  runLogger?: RunLogger,
): Promise<PersistedIntentInterpretation | null> {
  if (!checkpoint || checkpoint.confirmed_by !== "host") return null;
  const raw = checkpoint.free_form_intent;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const interpreted = interpretFreeFormIntent(raw);
  // The clause pipeline (interpretIntent) owns identity + blocking questions;
  // the hint interpreter above owns lens/priority/scope signals. Both are
  // deterministic draws over the same input.
  const clauseResult = interpretIntent(raw);
  const unencodable_clauses: ConstraintClauseRecord[] = [];
  for (const clause of clauseResult.clauses) {
    if (clause.encodable || !clause.checkpoint_question) continue;
    unencodable_clauses.push({
      clause_id: clause.clause_id,
      text: clause.text,
      checkpoint_question: clause.checkpoint_question,
    });
  }
  const persisted: PersistedIntentInterpretation = {
    schema_version: INTENT_INTERPRETATION_SCHEMA_VERSION,
    interpreted,
    unencodable_clauses,
    created_at: new Date().toISOString(),
  };
  try {
    await writeJsonFile(
      join(artifactsDir, INTENT_INTERPRETATION_FILENAME),
      persisted,
    );
  } catch {
    // Best-effort WRITE: a write failure must never crash the decide loop.
    // Enforcement does not depend on it — the consumer re-derives when the
    // sidecar is missing (readOrRepairIntentInterpretation).
  }
  if (unencodable_clauses.length > 0) {
    const clauseTexts = unencodable_clauses.map((c) => c.text);
    runLogger?.event({
      phase: "next-step",
      kind: "outcome",
      obligation: "interpret_intent",
      note:
        `intent_unencodable_clauses count=${String(unencodable_clauses.length)} ` +
        `clauses=${clauseTexts.join("; ")}`,
    });
    process.stderr.write(
      `[remediate-code] free_form_intent: ${unencodable_clauses.length} ` +
        `clause(s) could not be encoded as lens/priority/scope signals and ` +
        `block planning until answered via constraint_clauses: ` +
        `${clauseTexts.join("; ")}\n`,
    );
  }
  return persisted;
}

/**
 * Read the persisted intent interpretation — the LOAD-BEARING input to the
 * constraint-clause gate — repairing it by re-derivation when it is missing,
 * unparseable, or carries a stale schema_version. Returns null only when
 * there is nothing to interpret (no confirmed checkpoint / empty intent).
 */
export async function readOrRepairIntentInterpretation(
  artifactsDir: string,
  checkpoint: IntentCheckpoint | undefined,
  runLogger?: RunLogger,
): Promise<PersistedIntentInterpretation | null> {
  if (!checkpoint || checkpoint.confirmed_by !== "host") return null;
  const raw = checkpoint.free_form_intent;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const sidecarPath = join(artifactsDir, INTENT_INTERPRETATION_FILENAME);
  try {
    const parsed = parsePersistedIntentInterpretation(
      JSON.parse(await readFile(sidecarPath, "utf8")),
    );
    if (parsed) return parsed;
  } catch {
    // Missing or unreadable — fall through to repair.
  }
  return interpretConfirmedCheckpointIntent(artifactsDir, checkpoint, runLogger);
}

/** Pure shape gate for the sidecar: current version + record-shaped clauses, else null. */
function parsePersistedIntentInterpretation(
  parsed: unknown,
): PersistedIntentInterpretation | null {
  if (
    isRecord(parsed) &&
    parsed.schema_version === INTENT_INTERPRETATION_SCHEMA_VERSION &&
    Array.isArray(parsed.unencodable_clauses) &&
    parsed.unencodable_clauses.every(
      (c): c is ConstraintClauseRecord =>
        isRecord(c) &&
        typeof c.clause_id === "string" &&
        typeof c.text === "string" &&
        typeof c.checkpoint_question === "string",
    )
  ) {
    return parsed as unknown as PersistedIntentInterpretation;
  }
  return null;
}

/**
 * Sync sidecar read for the obligation's derive scan. Returns the persisted
 * interpretation, or null when the sidecar is missing, unreadable, or stale —
 * the execute path repairs via {@link readOrRepairIntentInterpretation}.
 */
function readPersistedIntentInterpretationSync(
  sidecarPath: string,
): PersistedIntentInterpretation | null {
  try {
    return parsePersistedIntentInterpretation(
      JSON.parse(readFileSync(sidecarPath, "utf8")),
    );
  } catch {
    return null;
  }
}

/** Execution dependencies threaded to every remediate obligation executor. */
export interface RemediateCtx {
  root: string;
  artifactsDir: string;
  options: NextStepOptions;
  runLogger: RunLogger;
  store: StateStore;
  inputResolution: InputResolution;
  /** Increment step_count once per host call (guarded; no-ops on re-entry). */
  countStep: (state: RemediationState | null) => Promise<void>;
}

/** The once-async-read signals the pre-intake derive()s consume synchronously. */
export interface PreIntakeSnapshot {
  existingCheckpoint: IntentCheckpoint | undefined;
  resumeAck: { choice?: string } | undefined;
  /**
   * The state as loaded at advance-entry (post-forceReplan, pre-intake). The
   * resume/conflict/leftover-report gates are about a *pre-existing* run, so they
   * derive from this frozen value — never from a state that `pending_intake`
   * creates mid-call (the original cascade evaluated them before intake and never
   * re-checked, so a re-scan must not resurrect them against an intake-built state).
   */
  entryState: RemediationState | null;
  /**
   * True when the supplied `--input` is identical to the input the existing run
   * was built from — so the conflict gate treats it as a resume, not a conflict.
   */
  suppliedInputUnchanged: boolean;
  /**
   * True when `--guidance-file` was supplied this invocation — a fresh intake
   * source, so it trips the input_conflict gate against an already-advanced run.
   */
  guidanceFileSupplied: boolean;
}

type RemediateObligation = ObligationDef<
  RemediationState | null,
  RemediateCtx,
  RemediationStep
>;

/**
 * What a remediate phase handler / dispatch builder returns to the engine: a
 * `transition` (state advanced; `advance` re-scans within the same call) or an
 * `emit` (a host-actionable step; `advance` returns it). Replaces the handlers'
 * former internal `return decideNextStepLoop(...true)` recursion (A3 slice 2b) so
 * the engine drives every fold with zero recursion.
 */
type RemediateOutcome = ObligationOutcome<RemediationState | null, RemediationStep>;

/**
 * Narrow a nullable engine state to non-null inside an executor whose `derive`
 * only marks it actionable when the state is present — a violation is an engine
 * contract bug, not a runtime condition.
 */
function requireState(state: RemediationState | null): RemediationState {
  if (!state) {
    throw new Error(
      "remediate obligation executor reached with a null state — derive() contract violated",
    );
  }
  return state;
}

/**
 * Priority order for the pre-intake obligations — mirrors the original cascade's
 * top-down guard order exactly so selection cannot drift.
 */
export const PRE_INTAKE_PRIORITY: readonly string[] = [
  "input_conflict",
  "confirm_resume",
  "confirm_intent",
  "interpret_intent",
  "complete_redelivery",
  "complete",
  "pending_intake",
];

/**
 * The linear pre-intake gates as declarative obligations (A3 slice 1). Built per
 * call so each `derive` can close over `ctx` paths + the pre-read `snapshot` and
 * read the remaining signals (existsSync, status, inputResolution) synchronously.
 * The matching executors are the original cascade handlers, classified emit vs
 * transition; the host-facing behaviour is unchanged.
 */
export function buildPreIntakeObligations(
  ctx: RemediateCtx,
  snapshot: PreIntakeSnapshot,
): RemediateObligation[] {
  const { artifactsDir, inputResolution } = ctx;
  const { existingCheckpoint, resumeAck, entryState, suppliedInputUnchanged, guidanceFileSupplied } = snapshot;
  const ip = intakePaths(artifactsDir);
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  const ackPath = join(artifactsDir, "confirm_resume_ack.json");
  const interpretationPath = join(artifactsDir, INTENT_INTERPRETATION_FILENAME);
  const reportPath = join(dirname(artifactsDir), "remediation-report.md");

  return [
    {
      // A new, DIFFERENT intake source against a run already past intake must not
      // silently resume (and re-execute) the old plan; require an explicit
      // resume-vs-restart choice. Two ways a fresh source arrives: a new `--input`
      // (the SAME --input re-passed by the loader every next-step is an unchanged
      // input → a resume, not a conflict), OR a `--guidance-file` (a one-shot
      // bootstrap that lands as conversation-start.md — it has no
      // "unchanged" notion, so any guidance file against an advanced run conflicts;
      // bare follow-ups don't set the flag). Derives from the frozen entry state.
      id: "input_conflict",
      derive: () =>
        ((inputResolution.supplied && !suppliedInputUnchanged) ||
          guidanceFileSupplied) &&
        entryState != null &&
        entryState.status !== "pending"
          ? "missing"
          : "satisfied",
      execute: async (_state, c) => {
        const s = requireState(entryState);
        await c.countStep(s);
        return {
          kind: "emit",
          step: await handleInputConflict(c.root, c.artifactsDir, s, c.inputResolution),
        };
      },
    },
    {
      // Bare re-invocation of an in-progress run: present resume/restart/merge
      // once (gated on the ack file) rather than silently resuming. An ack of
      // choice==='resume' is satisfied — fall through to normal dispatch. Derives
      // from the frozen entry state (a resume is of a *pre-existing* run).
      id: "confirm_resume",
      derive: () => {
        if (
          inputResolution.supplied ||
          entryState == null ||
          entryState.status === "complete" ||
          entryState.status === "pending"
        ) {
          return "satisfied";
        }
        return !resumeAck || resumeAck.choice !== "resume" ? "missing" : "satisfied";
      },
      execute: async (_state, c) => {
        const s = requireState(entryState);
        await c.countStep(s);
        return {
          kind: "emit",
          step: await buildConfirmResumeOrRestartStep({
            root: c.root,
            artifactsDir: c.artifactsDir,
            state: s,
            ackPath,
          }),
        };
      },
    },
    {
      // Intent gate: fire when no confirmed checkpoint exists (no checkpoint + any
      // intake artifact or an active run, or a draft checkpoint). Never for
      // complete/closing — those already confirmed their checkpoint.
      id: "confirm_intent",
      derive: (state) => {
        const checkpointIsDraft = existingCheckpoint?.confirmed_by === "draft";
        const activeRunState =
          state != null &&
          state.status !== "pending" &&
          state.status !== "complete" &&
          state.status !== "closing";
        const fires =
          checkpointIsDraft ||
          (!existsSync(checkpointPath) &&
            (existsSync(ip.summary) ||
              existsSync(ip.extractedPlan) ||
              activeRunState));
        return fires ? "missing" : "satisfied";
      },
      execute: async (state, c) => {
        await c.countStep(state);
        return {
          kind: "emit",
          step: await buildConfirmIntentStep({
            root: c.root,
            artifactsDir: c.artifactsDir,
            state,
          }),
        };
      },
    },
    {
      // Past the intent gate: interpret the confirmed checkpoint's
      // free_form_intent once (INV-S04), persist the structured signals, and
      // ENFORCE the unencodable-clause contract: an unanswered clause blocks
      // the decide loop until the host resolves it via a `constraint_clauses`
      // entry on the checkpoint (CE-004, identity-keyed — the shared matcher
      // in audit-tools/shared intent/constraintClauses.ts, the same core the
      // audit gate uses). The PERSISTED sidecar is the consumed input; a
      // missing or stale sidecar is repaired by re-derivation, never skipped.
      id: "interpret_intent",
      derive: () => {
        if (
          existingCheckpoint?.confirmed_by !== "host" ||
          typeof existingCheckpoint.free_form_intent !== "string" ||
          existingCheckpoint.free_form_intent.trim().length === 0
        ) {
          return "satisfied";
        }
        const sidecar = readPersistedIntentInterpretationSync(interpretationPath);
        if (sidecar === null) return "missing";
        return unresolvedFromClauses(sidecar.unencodable_clauses, existingCheckpoint)
          .length > 0
          ? "missing"
          : "satisfied";
      },
      execute: async (state, c) => {
        const persisted = await readOrRepairIntentInterpretation(
          artifactsDir,
          existingCheckpoint,
          c.runLogger,
        );
        const unresolved = persisted
          ? unresolvedFromClauses(persisted.unencodable_clauses, existingCheckpoint)
          : [];
        if (unresolved.length === 0) return { kind: "transition", state };

        const nextCommand = loaderCommand("next-step");
        const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
        const clauseLines = unresolved
          .map(
            (clause) =>
              `- **${clause.clause_id}** — "${clause.text}"\n  Question: ${clause.checkpoint_question}`,
          )
          .join("\n");
        const prompt = `
# Resolve Free-Form Intent Constraints

${unresolved.length} clause(s) of the confirmed checkpoint's \`free_form_intent\` could
not be encoded as lens/priority/scope signals. Each needs an explicit answer
before planning proceeds — an unanswered clause would otherwise be silently
dropped.

${clauseLines}

Answer each clause by adding a \`constraint_clauses\` entry to
\`intent_checkpoint.json\` (keep the exact \`clause_id\` — answers are keyed on
clause identity, not on the question text):

\`\`\`json
"constraint_clauses": [
  { "clause_id": "<the clause_id above>", "text": "<the clause text>", "checkpoint_question": "<the question above>", "host_answer": "<how to apply this constraint>" }
]
\`\`\`

Then run:

\`${nextCommand}\`
`;
        return {
          kind: "emit",
          step: await writeCurrentStep({
            stepKind: "confirm_intent",
            status: "blocked",
            runId: stateRunId(state),
            repoRoot: c.root,
            artifactsDir,
            prompt,
            allowedCommands: [nextCommand],
            stopCondition:
              "Stop after adding constraint_clauses answers to intent_checkpoint.json and running next-step.",
            artifactPaths: {
              intent_checkpoint: checkpointPath,
              intent_interpretation: interpretationPath,
            },
          }),
        };
      },
    },
    {
      // Finished runs delete the artifact dir but leave the root report. A bare
      // re-invocation with no fresh intent re-presents that report instead of
      // asking for a new starting point.
      id: "complete_redelivery",
      derive: (state) => {
        if (state != null || inputResolution.supplied || !existsSync(reportPath)) {
          return "satisfied";
        }
        // A ready intake-summary + host-confirmed checkpoint with no state.json is
        // the signal a NEW run carries right after confirm_intent (plan not yet
        // built) — an active run, not a finished one. A fully-green close deletes
        // the whole artifact dir (close.ts), so the summary + checkpoint can only
        // co-exist for a live run; never re-deliver the leftover root report over it.
        //
        // A freshly-regenerated default-discovered audit doc (audit-findings.json /
        // audit-report.md newer than the leftover report) is the same "don't
        // redeliver" signal — a fresh audit run just landed and a bare next-step
        // must fall through to pending_intake (which re-presents the discovered
        // file for confirmation via confirm_auto_discovered_input, mtime + type +
        // finding count included) rather than silently re-showing the stale report.
        const freshIntent =
          existsSync(ip.conversationStart) ||
          existsSync(ip.extractedPlan) ||
          (existsSync(ip.summary) && existingCheckpoint?.confirmed_by === "host") ||
          isDefaultCandidateFresherThanReport(inputResolution.existing[0], reportPath);
        return freshIntent ? "satisfied" : "missing";
      },
      execute: async (state, c) => ({
        kind: "emit",
        step: await handleComplete(c.root, c.artifactsDir, state),
      }),
    },
    {
      id: "complete",
      derive: (state) => (state?.status === "complete" ? "missing" : "satisfied"),
      execute: async (state, c) => {
        await c.countStep(state);
        return {
          kind: "emit",
          step: await handleComplete(c.root, c.artifactsDir, state),
        };
      },
    },
    {
      // No state yet: resolve intake. A produced step is emitted; a produced state
      // transitions (the re-scan falls through to the inline tail); a null result
      // emits the collect-starting-point step (the folded old no-state branch).
      id: "pending_intake",
      derive: (state) => (state == null ? "missing" : "satisfied"),
      execute: async (_state, c) => {
        const outcome = await handlePendingIntake(
          c.root,
          c.artifactsDir,
          c.options,
          c.runLogger,
        );
        if (outcome && "step_kind" in outcome) {
          return { kind: "emit", step: outcome };
        }
        if (outcome) {
          return { kind: "transition", state: outcome };
        }
        return { kind: "emit", step: await handleNoState(c.root, c.artifactsDir) };
      },
    },
  ];
}

/**
 * Priority order for the main (post-intake) obligations — mirrors the original
 * cascade tail's guard order exactly so selection cannot drift.
 */
export const MAIN_PRIORITY: readonly string[] = [
  "waiting_for_clarification",
  "waiting_for_triage",
  "planning_documentable",
  "deferred_clarification",
  "implementing",
  "triage",
  "planning_zero",
  "all_terminal",
  "closing",
  "unhandled",
];

/**
 * The post-intake cascade tail as declarative obligations (A3 slice 2). Runs on a
 * non-null state (pre-intake resolved it). Every phase handler returns a
 * `RemediateOutcome` — a `transition` (planning→implementing, triage, the
 * re-block/close funnel, the dispatch merge-then-reenter folds) or an `emit` (a
 * host-actionable step). `advance` drives the whole fold with ZERO recursion
 * (slice 2b). The one cross-engine case — `handleClosing` reaching `complete`,
 * which lives in the pre-intake engine — emits the report directly rather than
 * transitioning (a main transition could never select it).
 */
export function buildMainObligations(ctx: RemediateCtx): RemediateObligation[] {
  const { root, artifactsDir, options, runLogger, store } = ctx;
  const clarificationResolutionPath = join(
    artifactsDir,
    "clarification_resolution.json",
  );
  const triageResolutionPath = join(artifactsDir, "triage_resolution.json");

  return [
    {
      // Plan-phase clarification wait: apply a resolution if present (transition →
      // re-scan), else surface the wait step.
      id: "waiting_for_clarification",
      derive: (state) =>
        state?.status === "waiting_for_clarification" ? "missing" : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        if (existsSync(clarificationResolutionPath)) {
          const outcome = await applyPlanClarificationResolution(root, artifactsDir, s, store);
          if (outcome.kind === "refused") return { kind: "emit", step: outcome.step };
          return { kind: "transition", state: outcome.state };
        }
        return {
          kind: "emit",
          step: await handleWaitingForClarification(root, artifactsDir, s),
        };
      },
    },
    {
      // Triage wait: apply a resolution (→ triage, transition) if present, else
      // surface the wait step.
      id: "waiting_for_triage",
      derive: (state) =>
        state?.status === "waiting_for_triage" ? "missing" : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        if (existsSync(triageResolutionPath)) {
          s.status = "triage";
          await store.saveState(s);
          return { kind: "transition", state: s };
        }
        return {
          kind: "emit",
          step: await handleWaitingForTriage(root, artifactsDir, s),
        };
      },
    },
    {
      id: "planning_documentable",
      derive: (state) =>
        state != null &&
        state.status === "planning" &&
        documentableFindings(state).length > 0
          ? "missing"
          : "satisfied",
      execute: async (state) =>
        handlePlanning(root, artifactsDir, requireState(state), store),
    },
    {
      // Deferred clarification round. A worker question no longer freezes the run
      // at merge time; it waits HERE — at the END of the implement phase, once the
      // eligible dispatch frontier has drained — so every sibling's remaining work
      // lands first and the questions are asked in one batched window (the goals
      // doc's bounded-window promise).
      //
      // Ordered ABOVE `implementing` only because the derive already requires an
      // empty frontier: while any node is dispatchable this obligation is
      // satisfied and `implementing` dispatches it. Ordered above `triage` /
      // `all_terminal` / `closing` so an unanswered question can never be swept
      // past into close (triage with no blocked items routes straight to closing,
      // which would force-close the paused item as `abandoned` and lose the
      // question).
      id: "deferred_clarification",
      derive: (state) =>
        state != null &&
        (state.status === "implementing" || state.status === "triage") &&
        hasUnansweredClarification(state) &&
        implementableBlocks(state).length === 0
          ? "missing"
          : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        s.status = "waiting_for_clarification";
        await store.saveState(s);
        return { kind: "transition", state: s };
      },
    },
    {
      id: "implementing",
      derive: (state) =>
        state?.status === "implementing" ? "missing" : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        // Pending implementable blocks dispatch; triage only runs once every item
        // has left "pending".
        const pendingBlocks = implementableBlocks(s);
        if (pendingBlocks.length > 0) {
          // Per-phase boundary gate (T3): before opening a phase P > 0, run the
          // whole-repo suite once over the just-landed foundations. A red PAUSES
          // here (an emitted step, no state written); green / no-boundary falls
          // through to dispatch.
          const gated = await runPhaseBoundaryGate({
            root,
            artifactsDir,
            state: s,
            options,
            runLogger,
          });
          if (gated) return gated;
          return buildImplementDispatchStep({
            root,
            artifactsDir,
            state: s,
            options,
            store,
            runLogger,
          });
        }
        // Dead-end pending nodes whose dependency never reached verified-complete
        // (INV-RS-01) so the implementing→triage loop can't livelock; transition
        // so the engine re-scans on the updated state.
        const deadEnded = blockedByUnsatisfiedDependency(s);
        if (deadEnded.length > 0) {
          const now = new Date().toISOString();
          let changed = false;
          for (const block of deadEnded) {
            for (const findingId of block.items) {
              const it = s.items?.[findingId];
              if (!it || it.status !== "pending") continue;
              it.status = "blocked";
              it.started_at ??= now;
              it.completed_at = now;
              it.failure_reason =
                it.failure_reason ??
                "A dependency node did not reach a verified-complete disposition " +
                "(a prerequisite was skipped, blocked, or the dependencies are cyclic); " +
                "the host handoff will not expose this node (INV-RS-01).";
              changed = true;
            }
          }
          if (changed) {
            await store.saveState(s);
            return { kind: "transition", state: s };
          }
        }
        return handleImplementing(root, artifactsDir, s, runLogger, store, options);
      },
    },
    {
      id: "triage",
      derive: (state) => (state?.status === "triage" ? "missing" : "satisfied"),
      execute: async (state) =>
        handleImplementing(
          root,
          artifactsDir,
          requireState(state),
          runLogger,
          store,
          options,
        ),
    },
    {
      // planning with zero documentable findings is a user question, not a
      // dead-end — must fire BEFORE all_terminal so an all-resolved planning state
      // doesn't silently advance to close.
      id: "planning_zero",
      derive: (state) =>
        state != null &&
        state.status === "planning" &&
        documentableFindings(state).length === 0
          ? "missing"
          : "satisfied",
      execute: async (state) => ({
        kind: "emit",
        step: await handleZeroDocumentableFindings(
          root,
          artifactsDir,
          requireState(state),
        ),
      }),
    },
    {
      id: "all_terminal",
      derive: (state) =>
        state != null && allItemsTerminal(state) && state.status !== "closing"
          ? "missing"
          : "satisfied",
      execute: async (state) =>
        handleAllTerminalTransition(
          root,
          artifactsDir,
          requireState(state),
          store,
          options,
          runLogger,
        ),
    },
    {
      id: "closing",
      derive: (state) => (state?.status === "closing" ? "missing" : "satisfied"),
      execute: async (state) =>
        handleClosing(root, artifactsDir, requireState(state), runLogger, store),
    },
    {
      // Catch-all: reached only when no specific obligation matched. Always
      // actionable on a non-null state (the lowest-priority slot), so `advance`
      // surfaces the diagnostic rather than returning a null step.
      id: "unhandled",
      derive: (state) => (state != null ? "missing" : "satisfied"),
      execute: async (state) => ({
        kind: "emit",
        step: await handleUnhandledState(root, artifactsDir, requireState(state)),
      }),
    },
  ];
}

/**
 * ONE mutex for the WHOLE advance.
 *
 * The pre-intake segment used to run OUTSIDE the lock, with only the main
 * advance inside it — and the pre-intake segment is where the review-approval
 * gate and the autonomous leftover emit live, so two concurrent next-step calls
 * could both take the autonomous branch. Serializing only the second half made
 * the mutex a statement about which code was easy to wrap, not about which work
 * is serial: the entire state-machine advance is serial, so the entire advance
 * is guarded.
 *
 * The state is loaded once here (outside) purely to name the run in the
 * `phase_busy` step; the advance re-loads under the lock, so a peer that
 * persisted between the two is never clobbered.
 */
async function decideNextStepLoop(
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep> {
  const root = resolveRoot(options.root);
  const artifactsDir = resolveArtifactsDir(root, options.artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  const store = new StateStore(artifactsDir);
  const entryState = await store.loadState();
  runLogger.event({
    phase: "next-step",
    kind: "state",
    obligation: entryState?.status ?? "pending",
  });
  try {
    return await withFileLock(
      join(artifactsDir, "phase.lock"),
      () => advanceUnderPhaseLock({ root, artifactsDir, store, options, runLogger }),
      PHASE_LOCK_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof FileLockTimeoutError) {
      return buildPhaseBusyStep({
        root,
        artifactsDir,
        runId: stateRunId(entryState),
      });
    }
    throw error;
  }
}

/**
 * The serial state-machine advance itself — pre-intake gates, then the main
 * obligation fold. Runs with `<artifactsDir>/phase.lock` HELD for its whole
 * duration; never call it without that lock.
 */
async function advanceUnderPhaseLock(deps: {
  root: string;
  artifactsDir: string;
  store: StateStore;
  options: NextStepOptions;
  runLogger: RunLogger;
}): Promise<RemediationStep> {
  const { root, artifactsDir, store, options, runLogger } = deps;
  // Loaded FRESH under the mutex: a peer may have advanced and persisted state
  // between the entry read and this process winning the lock.
  let state = await store.loadState();
  // step_count is incremented once per host invocation. The `counted` flag guards
  // the shared `countStep` closure so the forceReplan preamble, the pre-intake
  // obligation executors, and the post-intake count point can never double-count
  // within a call. step_count is not embedded in the emitted step, so the
  // count-vs-build ordering is unobservable. (Every phase handler now returns a
  // transition/emit outcome, so `advance` drives the whole fold in ONE call —
  // there is no recursive re-entry to guard against.)
  const counted = { value: false };
  const countStep = async (current: RemediationState | null): Promise<void> => {
    if (!current || counted.value) return;
    if (!current.started_at) current.started_at = new Date().toISOString();
    current.step_count = (current.step_count ?? 0) + 1;
    counted.value = true;
    await store.saveState(current);
  };

  const inputResolution = resolveInputPaths(root, options.input);

  // Preamble — forceReplan re-grounds from existing intake. The whole decide loop
  // runs once per host call (the engine folds planning → implementing → … through
  // transitions, never a recursive decideNextStepLoop), so this fires at most once.
  if (options.forceReplan && state != null) {
    await countStep(state);
    state = await forceReplanFromExistingIntake(
      root,
      artifactsDir,
      state,
      store,
      runLogger,
    );
  }

  // Pre-read the once-async signals the pre-intake derive()s consume
  // synchronously (no transition inside this advance call rewrites either file).
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  const existingCheckpoint = existsSync(checkpointPath)
    ? await readOptionalJsonFile<IntentCheckpoint>(checkpointPath)
    : undefined;
  const resumeAck = await readOptionalJsonFile<{ choice?: string }>(
    join(artifactsDir, "confirm_resume_ack.json"),
  );
  // Whether a supplied `--input` matches the input the existing run was built
  // from — so re-passing the same `--input` (the loader does this each next-step)
  // resumes rather than tripping the input_conflict gate.
  const suppliedInputUnchanged = suppliedInputMatchesRun(
    inputResolution,
    await readOptionalJsonFile<IntakeSourceManifest>(
      intakePaths(artifactsDir).sourceManifest,
    ),
  );

  // The linear pre-intake gates run as obligations through the shared advance
  // loop. An emit returns to the host; a transition re-scans within this call;
  // exhausting them (step === null) means the run is past intake and falls
  // through to the post-intake `advance` (MAIN_PRIORITY) below.
  const ctx: RemediateCtx = {
    root,
    artifactsDir,
    options,
    runLogger,
    store,
    inputResolution,
    countStep,
  };
  const preIntake = await advance(
    {
      priority: PRE_INTAKE_PRIORITY,
      obligations: buildPreIntakeObligations(ctx, {
        existingCheckpoint,
        resumeAck,
        entryState: state,
        suppliedInputUnchanged,
        guidanceFileSupplied: Boolean(options.guidanceFileSupplied),
      }),
    },
    state,
    ctx,
  );
  if (preIntake.step) return preIntake.step;
  // `stopped` ABSENT is what means "complete" — branching on `.step` alone
  // cannot tell a finished fold from a wedged one, so this fold used to fall
  // straight through into the main fold and report a spin as ordinary progress.
  // `describeStoppedFold` returns null on a converged outcome, which makes the
  // null-check itself the branch. `stopped: "cycle"` is unreachable here (the
  // engine allocates its visited set only when a `stateSignature` is supplied,
  // and this draw supplies none, per the 670a6148 revert) — the describer still
  // covers it so the union stays exhaustive.
  const preIntakeStalled = describeStoppedFold(preIntake);
  if (preIntakeStalled) {
    return handleStoppedFold(root, artifactsDir, preIntake.state, preIntakeStalled);
  }
  state = preIntake.state;

  // pending_intake folds the old no-state branch (it emits handleNoState on a
  // null intake), so advance only falls through here with a non-null state; keep
  // the guard as the type narrowing + a defensive fallback.
  if (!state) {
    return handleNoState(root, artifactsDir);
  }

  await countStep(state);

  // Re-read between the two folds: a pre-intake executor may persist through the
  // store without returning the persisted value, so the main fold reads from disk
  // exactly as it did when it owned its own lock acquisition.
  const advanceState = (await store.loadState()) ?? state;
  const main = await advance(
    { priority: MAIN_PRIORITY, obligations: buildMainObligations(ctx) },
    advanceState,
    ctx,
  );
  if (main.step) return main.step;
  // Same contract as the pre-intake fold above: a non-convergent stop must not
  // reach `handleUnhandledState`, which would report a spinning obligation as a
  // state the machine has no transition for — a different defect entirely.
  const mainStalled = describeStoppedFold(main);
  if (mainStalled) {
    return handleStoppedFold(root, artifactsDir, main.state, mainStalled);
  }
  // The unhandled catch-all always emits on a non-null state, so a null step
  // here is unreachable; keep an explicit fallback rather than a non-null assert.
  return handleUnhandledState(root, artifactsDir, advanceState);
}
