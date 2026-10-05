import { readDecisionSnapshot, decisionContextDigest } from "../state/decisionConsumption.js";
import { RemediationPlanAuthorityError } from "../contractPipeline/runtimePlanAuthority.js";
import { reopenStaleTriageSuccesses } from "../phases/triageConformance.js";
import { stateRunId, requireStateRunId, currentHostBoundaryState } from "../state/runIdentity.js";
import { presentReportStep } from "./frictionCloseout.js";
import { reviewFilterDispositionsPath, persistReviewFilterDispositions, type PersistedReviewFilterDispositions } from "../review/filterDispositions.js";
import { INTENT_INTERPRETATION_FILENAME, readPersistedIntentInterpretationSync, readOrRepairIntentInterpretation } from "../intent/intentPersistence.js";
import { requestedFindingSelection, renderFindingSelection, type FindingSelectionOptions } from "../intakeSelection.js";
import { parseCommandString } from "../../shared/tooling/commandShape.js";
// sites-pinned: tests/remediate/path-a-source-provenance.test.ts, tests/remediate/path-a-phantom-source.test.ts, tests/remediate/next-step-replan-safety.test.ts, tests/remediate/close-plan-authority.test.ts, tests/remediate/friction-capture-closeout.test.ts, tests/remediate/next-step-lifecycle.test.ts, tests/remediate/next-step-pipeline-dispatch.test.ts, tests/remediate/next-step-outcomes-contract.test.ts, tests/remediate/integration-pipeline.test.ts, tests/remediate/outcomes-roundtrip.test.ts, tests/remediate/phase-close.test.ts, tests/remediate/grounding.test.ts, tests/remediate/clarification-round-contract.test.ts, tests/remediate/next-step-review-gate.test.ts, tests/remediate/n-r04-intent-checkpoint.test.ts, tests/remediate/final-gate-red-pause.test.ts, tests/remediate/deferred-clarification.test.ts
// (the free-form branch's write
// scope is normalized — a backslash-spelled citation no longer wedges prepare)
import { AUDIT_TOOLS_DIRNAME } from "../../shared/io/auditToolsPaths.js";
import { loadRemediateSessionConfig } from "./sessionConfigLoad.js";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StateStore, OPERATOR_LIFECYCLE_FILENAME, type OperatorLifecycle, type OperatorLifecycleAction, type RemediationState } from "../state/store.js";
import type {
  ClarificationRequest,
  Finding,
  RemediationItemState,
  RemediationPlan,
} from "../state/types.js";
// IO / validation / rendering helpers
import {
  discardOnSchemaVersionMismatch,
  applyGuidanceFile,
  applyGuidanceText,
  readOptionalJsonFile,
  stagedAndUntracked,
  writeJsonFile,
  stableStringify,
  writeTextFile,
  buildAuditDeliverablePair,
  auditReadOf,
  type AuditRead,
  isRecord,
  renderIngestReportLines,
  withFsRetry,
  RunLogger,
  coerceJsonObjectArg,
  renderPromptCommand,
  headCommit,
  hashContent,
  projectAuditFindingsReportSubset,
  // obligation engine + intent
  interpretFreeFormIntent,
  unresolvedFromClauses,
  advance,
  describeStoppedFold,
  linkFrictionRunIds,
  // domain constants
  LENSES,
  SEVERITIES,
  // types
  type ObligationDef,
  type ObligationOutcome,
  type StoppedFoldDescription,
  type SessionIntentLoadResult,
  CLOSING_ACTIONS,
  detectProjectFacts,
  isClosingAction,
  neutralProjectFacts,
} from "audit-tools/shared";
import type { CoverageLedger } from "../state/types.js";
import { buildCoverageLedger } from "../phases/plan.js";
import { runTriagePhase } from "../phases/triage.js";
import { runClosePhase } from "../phases/close.js";
import { ingestRemediationHostResults, hostDependencyLevels, permanentlyDeadPendingUnits, prepareRemediationHostHandoff, RemediationHostPreparationError, remediationIssueRemedy } from "./dispatch/hostHandoff.js";
import { type RemediationHostIngestSummary } from "./dispatch/hostContracts.js";
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
  remediationRequiredTestLogsDir,
} from "../../shared/io/auditToolsPaths.js";
import {
  callerWorkingDirectory,
  discoverRepoRoot,
  resolveRepoRoot,
} from "../../shared/io/repoRoot.js";
import { writeCurrentStep } from "./stepWriter.js";
import type { InputResolution, RemediationStep } from "./types.js";
import {
  isTerminalStatus,
  isVerifiedCompleteStatus,
} from "../state/itemStatus.js";
import { applyIntentOrdering } from "../intent/intentOrdering.js";
import { resolveIntakeStep } from "./intakeResolver.js";
import {
  RUNTIME_RESIDUAL_DECLARATION,
  finalGateDisabledReason,
  finalGateRecordPath,
  readFinalGateVerdict,
  runToolOwnedFinalGate,
  writeFinalGateRedRecord,
  recordFinalGateOutcome,
  writeFinalGateVerdict,
  type GateRunner,
  type ToolOwnedFinalGateResult,
} from "./finalGate.js";
import {
  renderGateAttribution,
  worktreeContentId,
  type GateRedAttribution,
  finalGateBinding,
} from "./gateCommands.js";
import {
  buildNextContractPipelineStep,
  readApprovedExecutionPlan,
  writePathASeedFromFindings,
} from "./contractPipeline.js";
import { compareCodeUnits } from "../../shared/compareCodeUnits.js";
import { executionPlanPaths, readCanonicalPlan, readPlanSource, readPlanReviewHistory } from "../contractPipeline/executionPlan.js";
import type { ExecutionUnit } from "../../shared/types/executionPlan.js";
import {
  buildReviewRequest,
  applyReviewResolution,
  parseReviewResolution,
  REVIEW_REQUEST_SCHEMA_VERSION,
  type ReviewRequest,
  type ReviewResolution,
} from "../review/reviewGate.js";
import { buildAutonomousReviewDecision } from "../review/autonomousGate.js";
import { runFindingFilterPass } from "../findingFilter.js";
import {
  intakePaths,
  isIntakeReady,
  manifestIsInputBound,
  readIntakeArtifacts,
  readProjectFacts,
  readSourceManifest,
  writeProjectFacts,
  resolveManifestSources,
  writeRemediationBrief,
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
import {
  isLegacyDraftCheckpoint,
  readIntentCheckpoint,
  readIntentCheckpointLenient,
} from "audit-tools/shared";
import type {
  ClosingAction,
  IntentCheckpoint,
  ProjectFacts,
  RejectedCheckpointField,
} from "audit-tools/shared";
import {
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

export interface NextStepOptions extends FindingSelectionOptions {
  root?: string;
  artifactsDir?: string;
  input?: string | string[];
  finalizeClosing?: boolean;
  /** Explicit operator-supplied test role; retained in the current plan. */
  verificationCommand?: string;
  forceReplan?: boolean;
  /** Persist a stop after successful planning, before implementation. */
  planOnly?: boolean;
  /** CLI guidance is applied only after the operator-control guard under phase.lock. */
  guidanceFile?: string;
  guidanceText?: string;
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
  boundSourcePaths: readonly string[] = [],
): boolean {
  if (!inputResolution.supplied) return false;
  if (manifest && !manifestIsInputBound(manifest)) return false;
  const supplied = new Set(inputResolution.checked.map((p) => resolve(p)));
  const recorded = new Set(
    (manifest ? manifest.sources.filter((s) => s.type !== "conversation").map((s) => s.path) : boundSourcePaths)
      .map((path) => resolve(path)),
  );
  if (supplied.size === 0 || supplied.size !== recorded.size) return false;
  for (const p of supplied) if (!recorded.has(p)) return false;
  return true;
}

export type {
  FindingRiskTier,
  FindingClassification,
} from "./stepUtils.js";
export { classifyFindingRisk } from "./stepUtils.js";
export { isTerminalStatus, isVerifiedCompleteStatus };
export { hostDependencyLevels };

function documentableFindings(state: RemediationState): ExecutionUnit[] {
  return state.plan?.units.filter(unit => state.items?.[unit.id]?.status === "pending") ?? [];
}

/**
 * The dispatch frontier: the level-0 draw of the SAME dependency/phase
 * partition the host workload builder emits from ({@link hostDependencyLevels}).
 * The guard and the builder reading ONE computation is what keeps the
 * "Cannot prepare an empty remediation host workload" throw unreachable from
 * the scheduler: whenever this is non-empty, the builder derives the identical
 * non-empty set (the 2026-08-23 empty-frontier incident — the retired
 * edge-only predicate ignored the phase barrier and dependency existence, so
 * the guard dispatched frontiers the builder refused, and next-step died
 * instead of pausing).
 */
function dispatchFrontier(state: RemediationState): ExecutionUnit[] {
  return hostDependencyLevels(state)[0] ?? [];
}

/**
 * The ONE dead-end sweep, shared by the planning→implementing transition and
 * the implementing obligation: marks the pending items of every permanently
 * dead block `blocked` with the INV-RS-01 reason, and reports whether anything
 * changed. Deadness is the workload boundary's own liveness analysis
 * ({@link permanentlyDeadPendingUnits}), so a node held by an unanswered
 * clarification — or by a lower phase that is merely still working — is NEVER
 * mis-reported as an upstream failure (the 175cfb89 pin).
 */
function sweepPermanentlyDeadBlocks(state: RemediationState): boolean {
  let changed = false;
  const now = new Date().toISOString();
  for (const block of permanentlyDeadPendingUnits(state)) {
    for (const findingId of [block.id]) {
      const it = state.items?.[findingId];
      if (!it || it.status !== "pending") continue;
      it.status = "blocked";
      it.started_at ??= now;
      it.completed_at = now;
      it.failure_reason =
        it.failure_reason ??
        "A prerequisite can never reach a verified-complete disposition " +
        "(a dependency or lower-phase block was skipped, blocked, or abandoned; " +
        "a declared dependency resolves to no block; or the dependencies are " +
        "cyclic); the host handoff will not expose this node against an " +
        "upstream surface that never landed (INV-RS-01).";
      changed = true;
    }
  }
  return changed;
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
  const phaseOf = (b: ExecutionUnit): number => b.phase_ordinal ?? 0;
  const dispatchPhase = Math.min(...frontier.map(phaseOf));
  if (dispatchPhase <= 0) return null;
  const pristine = plan.units
    .filter((b) => phaseOf(b) === dispatchPhase)
    .every((b) => items[b.id]?.status === "pending");
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
  return state.plan !== undefined && resolvedOrTerminalItems(state).length === items.length;
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
  // Ordering is an ADVISORY pass: it reorders the plan and nothing depends on
  // it, so an unreadable checkpoint degrades to "no intent" here rather than
  // failing the planning step. (Every other read site is a GATE and lets the
  // throw out — see `readIntentCheckpoint`.)
  const checkpoint = await readIntentCheckpoint(
    join(artifactsDir, "intent_checkpoint.json"),
  ).catch(() => undefined);
  const freeForm = checkpoint?.free_form_intent;
  if (typeof freeForm !== "string" || freeForm.trim().length === 0) return plan;
  const ordered = applyIntentOrdering(
    plan.findings,
    plan.units,
    interpretFreeFormIntent(freeForm),
  );
  return { ...plan, findings: ordered.findings, units: ordered.units };
}

/**
 * The write scope a free-form finding's `affected_files` implies, in the ONE
 * form the block contract accepts.
 *
 * The paths arriving here have been GROUNDED but never normalized: grounding
 * asks whether a path resolves to a real file (`existsSync`), and on Windows
 * `src\a.ts` does — so a Windows-spelled citation survives grounding and, copied
 * verbatim, becomes a `touched_files` entry `assertBlockContract` refuses. The
 * run then wedges at handoff preparation and every retry reproduces the refusal.
 *
 * It normalizes through the SAME shared `repoRelativePath` the handoff boundary
 * resolves declared entries with, so this producer's output is in the form its
 * consumer demands by construction rather than by a second, drifting rule. A
 * path that cannot be contained (`../outside.ts`) is DROPPED rather than
 * resolved: the block contract refuses it later anyway, and dropping it here
 * leaves the finding itself intact — grounding already decided which paths are
 * real, and this decides only how they are SPELLED.
 */
/**
 * The closing plan the HOST chose on the confirmed checkpoint: its action, or
 * `none` when the field is absent, plus the argv a `custom` choice carries.
 * Never a detected candidate: detection presents, the host chooses (owner
 * decision 92b0e2dd7cfdc06d). An invalid action, or a `custom` with no
 * command, cannot reach here — the confirm_intent obligation refuses both —
 * so membership is the whole check.
 */
async function confirmedClosingPlan(
  artifactsDir: string,
): Promise<{ action: ClosingAction; custom_command?: string[] }> {
  // LENIENT, for the same reason the gate is: this runs on the state the gate
  // just handled, and its own contract below says an out-of-vocabulary action
  // "cannot reach here". A strict read would turn a case this function already
  // handles by falling back to `none` into a thrown load error instead.
  //
  // This function only USES validated fields, so it takes the plain lenient read
  // and never touches `readIntentCheckpointLenient`'s raw rejections: the value
  // returned is one the schema accepts, and `isClosingAction` / `customCommandOf`
  // are the point-of-use checks on top of it.
  const checkpoint = await readIntentCheckpoint(
    join(artifactsDir, "intent_checkpoint.json"),
    { lenient: true },
  );
  if (!checkpoint || checkpoint.confirmed_by !== "host") return { action: "none" };
  const chosen: unknown = checkpoint.closing_action;
  if (!isClosingAction(chosen)) return { action: "none" };
  const command = customCommandOf(checkpoint);
  return chosen === "custom" && command ? { action: chosen, custom_command: command } : { action: chosen };
}

/** The checkpoint's `closing_custom_command` when it is a non-empty argv of non-empty strings. */
function customCommandOf(checkpoint: unknown): string[] | null {
  const raw = (checkpoint as { closing_custom_command?: unknown }).closing_custom_command;
  return Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((part) => typeof part === "string" && part.length > 0)
    ? (raw as string[])
    : null;
}

async function saveStateForPlan(
  artifactsDir: string,
  existing: RemediationState,
  plan: RemediationPlan,
  planCoverage?: CoverageLedger,
): Promise<RemediationState> {
  const { host_handoff: _staleHostHandoff, conformance_review: priorConformance, ...carryForwardState } = existing;
  const items: Record<string, RemediationItemState> = {};
  const owner = await readOptionalJsonFile<{revision_sha256:string;declined_units:Array<{id:string;reason:string}>}>(join(executionPlanPaths(artifactsDir).directory,"owner-decision.json"));
  for (const unit of plan.units) {
    const prior = existing.plan?.units.find(entry => entry.id === unit.id);
    items[unit.id] = prior && stableStringify(prior) === stableStringify(unit) && existing.items?.[unit.id]
      ? existing.items[unit.id]! : { unit_id: unit.id, status: "pending" };
    const declined = owner?.revision_sha256 === plan.review_revision_sha256 ? owner.declined_units.find(entry => entry.id === unit.id) : undefined;
    if (declined && !isVerifiedCompleteStatus(items[unit.id]!.status)) items[unit.id] = { unit_id: unit.id, status: "ignored", failure_reason: declined.reason, completed_at: new Date().toISOString() };

  }
  const state: RemediationState = {
    ...carryForwardState,
    ...(priorConformance ? { conformance_review: { ...priorConformance, run_id: plan.plan_id } } : {}),
    status: "planning",
    plan,
    items,
    closing_plan: await confirmedClosingPlan(artifactsDir),
    ...(planCoverage ? { plan_coverage: planCoverage } : {}),
  };
  await new StateStore(artifactsDir).saveState(state);
  await writeJsonFile(join(artifactsDir, "remediation_plan.json"), plan);
  return state;
}

async function forceReplanFromExistingIntake(
  root: string, artifactsDir: string, previous: RemediationState,
  runLogger: RunLogger,
): Promise<RemediationState | { kind: "blocked"; reason: string; archivePath?: string } | {kind:"planning_step";step:RemediationStep} | null> {
  const step=await buildNextContractPipelineStep({root,artifactsDir,runId:requireStateRunId(previous),forceRevision:false});
  if(step)return {kind:"planning_step",step};
  const approved = await readApprovedExecutionPlan(artifactsDir);
  if (!approved) return { kind: "blocked", reason: "Revise and independently approve the current executable plan before replanning. Accepted execution history is preserved." };
  const activated = await activateApprovedPlan(root, artifactsDir, previous, approved, runLogger);
  if (activated.kind === "blocked") return activated;
  // Activation already carries unchanged history and applies CURRENT owner
  // decisions. Reapplying old items here would undo a newly declined unit.
  return activated.state;
}

/**
 * The ingest report for the implement-dispatch prompt, as prompt lines.
 *
 * Takes the whole summary rather than just its issues, because the report needs
 * BOTH halves: the classified issues, and the items that landed without a
 * result (from `work_item_outcomes`, where the run's corroborated commit for
 * the item is what separates that case from plain unfinished work). The
 * sections are the shared renderer's; only the remedy map is this draw's.
 */
function remediationIngestReportLines(
  ingested: RemediationHostIngestSummary,
): string[] {
  return renderIngestReportLines({
    issues: ingested.issues,
    remedy: remediationIssueRemedy,
    workload: "named_above",
    landedWithoutResult: [...ingested.work_item_outcomes]
      .filter(([, outcome]) => outcome === "missing_result_with_commit")
      .map(([id]) => id)
      .sort(compareCodeUnits),
  });
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
  const runId = requireStateRunId(state);
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
  // DURABLY RECORD EVERY CLASSIFIED ISSUE BEFORE ANY EXIT PATH.
  //
  // This loop used to sit below the `state_changed` early return, next to the
  // prompt that renders the same issues — so it only ran when NOTHING was
  // accepted. On a partial batch (some results accepted, some rejected)
  // `state_changed` is true, the call transitions here, and every rejection was
  // lost: not logged, not rendered, not carried. The one path where a host most
  // needs to know that some of its work was refused was the path that said
  // nothing at all.
  //
  // The rendering half is separate and still only reached on the re-emit path;
  // this is the DURABLE half, and it must not depend on which exit is taken. The
  // ledger already records the rejection, but the run log is what a person reads
  // when reconstructing a run.
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
  if (ingested.state_changed) {
    // Same as the recovery verb above: the version is the store's to write,
    // not a boundary decoration to peel off before persisting.
    await store.saveState(ingested.state);
    return { kind: "transition", state: ingested.state };
  }

  const conformance = ingested.issues.filter(issue => issue.review_request_path !== undefined);
  if (conformance.length > 0) {
    const nextCommand = loaderCommand("next-step");
    const unavailable = conformance.some(issue => issue.code === "conformance_review_unavailable");
    const repair = conformance.some(issue => issue.code === "conformance_review_insufficient");
    return {
      kind: "emit",
      step: await writeCurrentStep({
        stepKind: "review_contract_conformance", status: unavailable ? "blocked" : "ready",
        runId, repoRoot: root, artifactsDir,
        prompt: [
          "# Independent contract conformance review",
          "",
          "The results named below passed mechanical validation. They are not accepted until their bound independent reviews pass.",
          "Read each request file and give it to a context that did not author the implementation and cannot see the author's reasoning. The request contains the exact result, obligations, contracts, response schema and response path.",
          "",
          ...conformance.flatMap(issue => [
            `- ${issue.work_item_id}: ${issue.message}`,
            `  Request: ${issue.review_request_path}`,
          ]),
          "",
          ...(repair ? ["Repair the implementation or its obligation evidence as explained by the review, then obtain a fresh review bound to the corrected result. Do not change contracts merely to make the review pass."] : []),
          ...(unavailable ? ["Stop until an independent context is available. Degraded/self review cannot replace the required review."] : []),
          "Independence is a host declaration; the tool validates the declaration and content binding, not the identity of the reviewer.",
          `When the responses are ready, run \`${nextCommand}\`.`,
        ].join("\n"),
        allowedCommands: [nextCommand],
        stopCondition: "Stop after the independent review responses are written and next-step is run; if independent review is unavailable, remain paused.",
        artifactPaths: Object.fromEntries(conformance.map(issue => [`review_${issue.work_item_id}`, issue.review_request_path!])),
      }),
    };
  }

  const baselineCommit = await headCommit(root);
  if (!baselineCommit) {
    throw new Error("Cannot prepare remediation host work without a repository HEAD commit.");
  }
  let handoff: Awaited<ReturnType<typeof prepareRemediationHostHandoff>>;
  try {
    handoff = await prepareRemediationHostHandoff({
      root, artifactsDir, runId, baselineCommit, state: boundaryState,
    });
  } catch (error) {
    if (!(error instanceof RemediationHostPreparationError)) throw error;
    const sourcePath = join(artifactsDir, "state.json");
    const diagnosticsPath = join(artifactsDir, "steps", "handoff-repair.json");
    await writeJsonFile(diagnosticsPath, { code: error.code, message: error.message, source: sourcePath });
    const excerpt = error.message.length <= 3_000 ? error.message : `${error.message.slice(0, 3_000)}… [excerpt truncated]`;
    return {
      kind: "emit",
      step: await writeCurrentStep({
        stepKind: "repair_handoff", status: "blocked", runId, repoRoot: root, artifactsDir,
        prompt: `# Repair the planning output before dispatch\n\n${excerpt}\n\nFull validation details: ${diagnosticsPath}\n\n` +
          `Owning source: ${sourcePath} (plan.units and its generated handoff binding).\n` +
          `Upstream planning input: ${join(artifactsDir, "extracted-plan.json")}.\n\n` +
          "The current run and completed work are preserved. This dispatch cannot safely repair its upstream producer. " +
          "Return the named validation errors to the planning producer; do not edit generated state, discard accepted work, or submit results under invalid bindings. " +
          "After the upstream producer has corrected the plan, run next-step again.\n",
        allowedCommands: [],
        stopCondition: "Stop and report the named upstream planning defect; do not execute or reset this handoff.",
        artifactPaths: { source_plan: sourcePath, repair_diagnostics: diagnosticsPath },
        access: { read_paths: [sourcePath, diagnosticsPath], write_paths: [] },
      }),
    };
  }
  if (handoff === "unsupported_retired_state") {
    throw new Error(
      "Remediation state uses a retired dispatch shape and cannot cross the host handoff boundary.",
    );
  }
  if (
    !state.conformance_review || state.host_handoff?.workload_sha256 !==
    handoff.handoff_record.workload_sha256
  ) {
    await store.saveState({
      ...state,
      host_handoff: handoff.handoff_record,
      conformance_review: handoff.conformance_review,
    });
  }

  // Name the runs this dispatch round relates to on the friction record (semantics:
  // `FrictionRunLinks`). Each reference is sourced from the envelope that owns it — the
  // persisted handoff record for the dispatch run, the step contract's own run id for
  // the step — never synthesized from the other.
  await linkFrictionRunIds(
    artifactsDir,
    requireStateRunId(state),
    { step_run_id: runId, dispatch_run_id: handoff.handoff_record.run_id },
    "remediate-code",
  );

  // The issues were logged above, before any exit path. What follows is the
  // RENDER — a channel that survives exactly as long as the host reads this one
  // step, and that is reached only when nothing was accepted.
  //
  // Each issue lands under the section its CODE's remedy names, never under one
  // its message text suggests, so rewording a message cannot move an item
  // between sections (the measured friction: a host parser special-casing "no
  // result file exists").
  const report = remediationIngestReportLines(ingested);

  const nextCommand = loaderCommand("next-step");
  const promptLines = [
    "# Implement the remediation work items",
    "",
    "Read the workload file:",
    "",
    `\`${handoff.workload_path}\``,
    "",
    "The file lists every work item that is ready now. Give each item's prompt to a worker. You choose the order, the groups, and how many run at the same time.",
    "",
    ...report,
    ...(report.length > 0 ? ["Change only the result files named above.", ""] : []),
    "Do not edit the workload file.",
    "",
    "When each item has its commit on HEAD and its result file, run:",
    "",
    `\`${nextCommand}\``,
  ];
  return {
    kind: "emit",
    step: await writeCurrentStep({
      stepKind: "dispatch_implement",
      status: "ready",
      runId,
      repoRoot: root,
      artifactsDir,
      prompt: `\n${promptLines.join("\n")}\n`,
      allowedCommands: [
        ...new Set(
          handoff.workload.work_items.flatMap((item) => item.required_tests),
        ),
        nextCommand,
      ],
      stopCondition:
        "Stop after every emitted work item has a complete result and next-step has been run.",
      artifactPaths: { host_workload: handoff.workload_path, required_test_logs: remediationRequiredTestLogsDir(root) },
      access: {
        read_paths: [root, handoff.workload_path, remediationRequiredTestLogsDir(root)],
        write_paths: [...new Set(handoff.workload.work_items.flatMap((item) => [
          ...item.allowed_files.map((path) => resolve(root, path)), resolve(root, item.result_path),
        ]))],
      },
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
  runId: string | null;
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
 * Copy an unusable extracted plan somewhere recoverable and PROVE the copy
 * landed, returning the archive path. Read back and compared byte-for-byte:
 * "the write did not throw" is not evidence a file exists, and this is the last
 * moment the plan is recoverable at all.
 *
 * THROWS rather than returning when the copy cannot be made or verified, so the
 * caller's unlink is unreachable on that path — an irreversible delete never
 * runs before its archive is written and verified.
 */
type PlanActivationOutcome =
  | { kind: "planned"; state: RemediationState }
  | { kind: "blocked"; reason: string; archivePath?: string };

/** Render the step that STATES a discard, rather than asking for an input again. */
async function emitPlanRevisionBlockedStep(root:string,artifactsDir:string,blocked:{reason:string}):Promise<RemediationStep>{
  return writeCurrentStep({stepKind:"contract_pipeline",status:"blocked",runId:null,repoRoot:root,artifactsDir,
    prompt:`# Executable plan requires attention\n\n${blocked.reason}\nThe current plan and accepted execution history are preserved. Revise the plan through its tool-issued submission and obtain fresh review before continuing.`,
    allowedCommands:[loaderCommand("next-step")],stopCondition:"Resolve the named plan/review issue before implementation.",artifactPaths:{execution_plan:executionPlanPaths(artifactsDir).canonical}});
}

async function activateApprovedPlan(
  root: string, artifactsDir: string, existing: RemediationState,
  _input: unknown, _runLogger: RunLogger,
): Promise<PlanActivationOutcome> {
  const approved = await readApprovedExecutionPlan(artifactsDir);
  if (!approved) return { kind: "blocked", reason: "No current independently approved executable plan exists. Re-run planning; unreviewed projections cannot dispatch." };
  const facts = (await readProjectFacts(artifactsDir)) ?? neutralProjectFacts();
  const { canonical, source } = approved;
  let plan: RemediationPlan = {
    ...canonical.plan,
    source: "execution_plan",
    findings: source.findings,
    ...(source.request ? { request: source.request } : {}),
    review_revision_sha256: canonical.revision_sha256,
    review_counterexamples: (await readPlanReviewHistory(artifactsDir)).counterexamples.filter(example => canonical.plan.units.some(unit => unit.addresses_counterexample_ids.includes(example.id))),
    project_type: facts.project_type,
    candidate_closing_actions: facts.candidate_closing_actions,
    audit_read: source.audit_read,
    ...(facts.commands.test ? { test_command: renderPromptCommand(facts.commands.test), test_command_source: "project_facts" as const } : {}),
    ...(facts.commands.e2e ? { e2e_command: renderPromptCommand(facts.commands.e2e), e2e_command_source: "project_facts" as const } : {}),
  };
  plan = await applyCheckpointIntentOrdering(artifactsDir, plan);
  if (!existing.run_start_dirty) existing = { ...existing, run_start_dirty: [...await stagedAndUntracked(root)].sort() };
  const filter = await readOptionalJsonFile<PersistedReviewFilterDispositions>(reviewFilterDispositionsPath(artifactsDir));
  // Through the schema-checked reader: with zero survivors the review gate never
  // rewrites a stale-schema record, so a raw read let its declines into the
  // ledger as declined-by-review although the current run never decided them.
  const decision = await readReviewDecision(artifactsDir);
  const coverage = buildCoverageLedger({
    planId: plan.plan_id, sourceFindings: filter?.originals ?? source.findings,
    droppedNoEvidence: filter?.droppedNoEvidence ?? [], droppedByCheckpoint: filter?.droppedByCheckpoint ?? [],
    declinedByReview: decision?.declined ?? [], droppedPhantomPaths: new Map(filter?.droppedPhantomPaths ?? []),
    phantomPathsRemoved: new Map(filter?.phantomPathsRemoved ?? []), mergeMap: new Map(filter?.mergeMap ?? []), units: plan.units,
  });
  const state = await saveStateForPlan(artifactsDir, existing, plan, coverage);
  return { kind: "planned", state };
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

/**
 * The gate's read of the review decision record. Owner decision: a record under
 * a stale schema is discarded and RE-ASKED, never replayed — its keep/decline
 * meant something under the old semantics. The gate opens on THIS value, not on
 * the file's existence, so a discarded record re-opens the gate instead of
 * replaying as "no declines".
 */
async function readReviewDecision(
  artifactsDir: string,
): Promise<ReviewDecisionRecord | undefined> {
  return discardOnSchemaVersionMismatch(
    await readOptionalJsonFile<ReviewDecisionRecord>(reviewDecisionPath(artifactsDir)),
    REVIEW_DECISION_SCHEMA_VERSION,
  );
}

/**
 * Stamp and persist one review decision. Three sites built this literal — the
 * autonomous and interactive arms of the approval gate, and the planning gate —
 * and a schema stamp that lives in three places is one edit away from meaning
 * two different things on disk.
 *
 * Persistence only. WHICH ids are approved, where the plan id comes from, and
 * what the caller does next are all decided by the caller and stay there: the
 * autonomous arm mints a run id and declines nothing, the two resolution arms
 * carry the live plan's id and the operator's declines.
 */
async function writeReviewDecisionRecord(
  decisionPath: string,
  fields: {
    planId: string;
    approvedIds: string[];
    declined: Array<{ finding_id: string; reason: string }>;
  },
): Promise<void> {
  const record: ReviewDecisionRecord = {
    schema_version: REVIEW_DECISION_SCHEMA_VERSION,
    plan_id: fields.planId,
    approved_ids: fields.approvedIds,
    declined: fields.declined,
    created_at: new Date().toISOString(),
  };
  await writeJsonFile(decisionPath, record);
}

/**
 * Archive the inputs a gate has just consumed, so it cannot re-halt on them.
 *
 * Renaming rather than deleting keeps the operator's own answer recoverable;
 * the timestamp suffix keeps a second consumption from colliding with the
 * first. An absent path is not an error — a gate reached through the autonomous
 * arm never wrote one.
 */
async function archiveConsumedInputs(paths: readonly string[]): Promise<void> {
  for (const p of paths) {
    if (existsSync(p)) {
      await withFsRetry(() => rename(p, `${p}.consumed-${Date.now()}`));
    }
  }
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
      "Stop after presenting the findings for approval and collecting the user's approve/decline decision, unless the decision is already recorded and the prompt told you to continue.",
    artifactPaths: {
      review_request: reviewRequestPath(artifactsDir),
      review_resolution: reviewResolutionPath(artifactsDir),
    },
  });
}

/**
 * Read the review resolution for both gate paths, through the one strict
 * parser ({@link parseReviewResolution}). A refused file (bad JSON, an unknown
 * field, a wrong type, an id or tier outside the request) is archived as
 * `.refused-<ts>` — never applied — and the gate re-halts with each problem
 * named. The gate's default is approve, so reading past a bad file would turn
 * the user's decline into an approval. A stale file from another run is
 * archived as `.stale-<ts>` and the gate re-halts with no refusal. Returns the
 * re-halt step, or the resolution to apply.
 */
async function readReviewResolution(
  root: string,
  artifactsDir: string,
  request: ReviewRequest,
  resolutionPath: string,
  requestPath: string,
): Promise<{ halt: RemediationStep } | { resolution: ReviewResolution }> {
  const parsed = parseReviewResolution(await readFile(resolutionPath, "utf8"), request);
  if (parsed.kind === "ok") return { resolution: parsed.resolution };
  const suffix = parsed.kind === "stale" ? "stale" : "refused";
  await withFsRetry(() =>
    rename(resolutionPath, `${resolutionPath}.${suffix}-${Date.now()}`),
  );
  await writeJsonFile(requestPath, request);
  return {
    halt: await handleWaitingForReviewApproval(
      root,
      artifactsDir,
      request,
      parsed.kind === "refused" ? parsed.reason : undefined,
    ),
  };
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
  /** The source report's `audit_read`, carried onto any leftover re-emit. */
  sourceAuditRead: AuditRead | null,
  autonomous = false,
): Promise<ReviewGateProceed | ReviewGateHalt> {
  const decisionPath = reviewDecisionPath(artifactsDir);

  // First crossing only: no READABLE decision yet AND the pipeline has not
  // started. A stale-schema record counts as no decision, so it is re-asked
  // here rather than replayed below as "no declines".
  const gateOpen =
    survivors.length > 0 &&
    (await readReviewDecision(artifactsDir)) === undefined &&
    !existsSync(executionPlanPaths(artifactsDir).canonical);

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
    await writeReviewDecisionRecord(decisionPath, {
      planId: randomRunId("path-a-review"),
      approvedIds: auto.approved_ids,
      declined: [],
    });
    // Re-emit the leftovers as a standard, re-consumable audit deliverable pair
    // so the next nightly run picks them up via defaultInputCandidates. Always
    // on disk regardless of whether a git remote / PR is available.
    const leftovers = survivors.filter((f) => !approvedSet.has(f.id));
    await emitAutonomousLeftoverDeliverable(root, artifactsDir, leftovers, sourceAuditRead);
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
    const read = await readReviewResolution(
      root, artifactsDir, request, resolutionPath, requestPath,
    );
    if ("halt" in read) return { kind: "halt", step: read.halt };
    const decision = applyReviewResolution(request, read.resolution);
    await writeReviewDecisionRecord(decisionPath, {
      planId: request.plan_id,
      approvedIds: decision.approved_ids,
      declined: decision.declined,
    });
    await archiveConsumedInputs([resolutionPath, requestPath]);
  }

  // Decision recorded (now or on a prior call): split the survivors. The
  // replay honours the recorded approved_ids (COR-227a02ae) — an autonomous
  // decision approves a SUBSET with declined EMPTY (leftovers live but not
  // approved), so keying the replay on the declined set alone would silently
  // re-approve every leftover on the next call.
  // Re-read: the gate above may have just written the record. A stale record
  // never reaches here — it re-opened the gate, which halted or replaced it.
  const decision = await readReviewDecision(artifactsDir);
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
  // The leftovers were read by the ORIGINAL audit, so the pair re-states its
  // `audit_read`. The commit current now is a remediation-side commit — exactly
  // what the next run's evidence leg must never be handed as `B`.
  sourceAuditRead: AuditRead | null,
): Promise<void> {
  const pair = buildAuditDeliverablePair(leftovers, sourceAuditRead, {
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

async function handleReadyIntakeContractPipeline(
  root: string,
  artifactsDir: string,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep | RemediationState | null> {
  // Resume the tool-owned plan without reconstructing completed intake.
  const earlyExtractedPlan = await readApprovedExecutionPlan(artifactsDir);
  if (earlyExtractedPlan && !existsSync(executionPlanPaths(artifactsDir).submission)) {
    const outcome = await activateApprovedPlan(
      root,
      artifactsDir,
      { status: "pending" },
      earlyExtractedPlan,
      runLogger,
    );
    return outcome.kind === "blocked"
      ? emitPlanRevisionBlockedStep(root, artifactsDir, outcome)
      : outcome.state;
  }

  if (await readPlanSource(artifactsDir)) {
    const step = await buildNextContractPipelineStep({
      root, artifactsDir, runId: randomRunId("CONTRACT"),
    });
    if (step) return step;
    const approved = await readApprovedExecutionPlan(artifactsDir);
    if (!approved) return null;
    const outcome = await activateApprovedPlan(root, artifactsDir, { status: "pending" }, approved, runLogger);
    return outcome.kind === "blocked"
      ? emitPlanRevisionBlockedStep(root, artifactsDir, outcome)
      : outcome.state;
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
      const checkpoint = await readIntentCheckpoint(join(artifactsDir, "intent_checkpoint.json"));
      const filter = await runFindingFilterPass(structuredClone(originals), {
        root,
        checkpoint: checkpoint ?? undefined,
        evidenceGrounding: true,
      });
      const gate = await runReviewApprovalGate(
        root,
        artifactsDir,
        filter.survivors,
        auditReadOf(auditFindings),
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
      // receives light adversarial depth. There is no second plan producer or
      // bypass that could disagree with this risk authority.
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
      // Filtering annotates its working copies; source provenance stays byte-faithful.
      // Selection and risk use the filter's facts, while the plan owns original claims.
      const originalsById = new Map(originals.map(finding => [finding.id, finding]));
      const approvedOriginals = gate.approved.map(finding => {
        const original = originalsById.get(finding.id);
        if (!original) throw new Error(`Approved finding ${finding.id} has no original source payload.`);
        return original;
      });
      const approvedPayload = projectAuditFindingsReportSubset(
        auditFindings,
        approvedOriginals,
      );
      let seedSourcePath = auditSource.path;
      if (gate.approved.length < originals.length) {
        await mkdir(executionPlanPaths(artifactsDir).directory, { recursive: true });
        seedSourcePath = join(executionPlanPaths(artifactsDir).directory, "approved-findings.json");
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

  if (auditSource && !await readPlanSource(artifactsDir)) await writePathASeedFromFindings(artifactsDir, auditSource.path, await readAuditFindingsOnce());

  const paths = intakePaths(artifactsDir);
  const sourcePaths = new Set<string>();
  // The brief is the tool's render of the ready summary; write it before it
  // becomes a pipeline source, so the source is never absent or stale.
  await writeRemediationBrief(artifactsDir, intake.summary);
  sourcePaths.add(paths.brief);
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

  const extractedPlan = await readApprovedExecutionPlan(artifactsDir);
  if (!extractedPlan) {
    return null;
  }
  const outcome = await activateApprovedPlan(
    root,
    artifactsDir,
    { status: "pending" },
    extractedPlan,
    runLogger,
  );
  return outcome.kind === "blocked"
    ? emitPlanRevisionBlockedStep(root, artifactsDir, outcome)
    : outcome.state;
}

async function handlePendingIntake(
  root: string,
  artifactsDir: string,
  options: NextStepOptions,
  runLogger: RunLogger,
): Promise<RemediationStep | RemediationState | null> {
  // Existing source ownership survives pending review and approval invalidation.
  // The earlier confirm_intent obligation still guards this continuation.
  if (await readPlanSource(artifactsDir)) {
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
    findingSelection: options,
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
  selectionConflict?: { sourceChanged: boolean },
): Promise<RemediationStep> {
  const planId = state.plan?.plan_id ?? "(none)";
  const itemCount = state.items ? Object.keys(state.items).length : 0;
  const suppliedInline =
    inputResolution.checked.length > 0
      ? inputResolution.checked.map((p) => `\`${p}\``).join(", ")
      : "(new intake source via `--guidance-file`)";
  const selectionPrompt = selectionConflict ? [
    "# Finding selection changed during an existing intake", "",
    "The earlier selected report and its scope have been preserved. No new selection has been published.",
    selectionConflict.sourceChanged
      ? "The original audit report changed. Restore the original source bytes to resume the existing intake, or explicitly start a fresh run from the changed report. A bare resume cannot accept changed source evidence."
      : "The requested severity/ID selectors differ from this intake's selection. Drop the new selector flags to resume the existing selection, or explicitly start a fresh run with the new selectors.",
    `To start fresh, first move aside the existing ${artifactsDir} directory, then rerun next-step with --input and the intended --severity/--finding-id flags.`,
    "Stop and present this choice to the user before continuing.",
  ].join("\n") : undefined;
  return writeCurrentStep({
    stepKind: "input_conflict",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: selectionPrompt ?? `
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
const PLAN_CLARIFICATION_ACTIONS = ["clarified", "reject_finding", "defer"] as const;

/**
 * One entry of a clarification resolution file. Strict: an unknown field is
 * refused, not ignored.
 *
 * - `rationale` is REQUIRED and non-empty on `clarified`: it becomes the item's
 *   `clarification_context`, the answer the next worker reads. A `clarified`
 *   entry without it re-opened the item with no answer attached.
 * - There is no write-scope field: new write scope needs a revised, freshly
 *   reviewed plan, so an answer cannot widen a unit (owner decision 2026-10-01;
 *   the ignored `scope_additions` field was removed in two releases, and is now
 *   refused as an unknown field).
 */
const PlanClarificationResolutionSchema = z
  .object({
    unit_id: z.string().min(1, "must be a non-empty finding id"),
    action: z.enum(PLAN_CLARIFICATION_ACTIONS),
    rationale: z.string().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.action === "clarified" && (entry.rationale ?? "").trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rationale"],
        message:
          'is required and must be non-empty when action is "clarified" — it carries the answer to the next worker',
      });
    }
  });

type PlanClarificationResolution = z.infer<typeof PlanClarificationResolutionSchema>;

type ParsedPlanClarifications =
  | { ok: true; resolutions: PlanClarificationResolution[] }
  | { ok: false; reason: string };

/**
 * Read and validate the mid-run `clarification_resolution.json` file.
 *
 * ONE shape is accepted: a bare JSON array of entries. Every entry is checked
 * against {@link PlanClarificationResolutionSchema}, and a second entry for the
 * same finding is refused. Any bad entry refuses the WHOLE file, and the reason
 * names the entry's index and field. The parser this replaced accepted four
 * shapes and dropped a bad entry in silence: an `"action": "approve"` lost the
 * user's answer, and the item then waited forever for a question the round no
 * longer showed.
 */
async function readPlanClarificationResolutions(
  path: string,
  snapshotBytes?: string,
): Promise<ParsedPlanClarifications> {
  let value: unknown;
  try {
    value = JSON.parse(snapshotBytes ?? await readFile(path, "utf8"));
  } catch (error) {
    return {
      ok: false,
      reason: `the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason:
        "the file must be a JSON array of entries — an object wrapper such as " +
        '`{"resolutions": [...]}` is not accepted',
    };
  }
  const problems: string[] = [];
  const firstEntryFor = new Map<string, number>();
  const resolutions: PlanClarificationResolution[] = [];
  value.forEach((entry, index) => {
    const parsed = PlanClarificationResolutionSchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.length > 0 ? ` \`${issue.path.join(".")}\`` : "";
        problems.push(`entry [${index}]${field}: ${issue.message}`);
      }
      return;
    }
    const prior = firstEntryFor.get(parsed.data.unit_id);
    if (prior !== undefined) {
      problems.push(
        `entry [${index}] \`unit_id\`: \`${parsed.data.unit_id}\` is already answered by entry [${prior}]`,
      );
      return;
    }
    firstEntryFor.set(parsed.data.unit_id, index);
    resolutions.push(parsed.data);
  });
  return problems.length > 0
    ? { ok: false, reason: problems.join("; ") }
    : { ok: true, resolutions };
}

/**
 * Every whole-file refusal of a parsed resolution, in check order: the parse,
 * then the closed id set. Null means the file may be applied.
 */
function planClarificationRefusal(
  parsed: ParsedPlanClarifications,
  validIds: ReadonlySet<string>,
  outsideSetLabel: string,
): string | null {
  if (!parsed.ok) return parsed.reason;
  const unknownIds = parsed.resolutions
    .map((r) => r.unit_id)
    .filter((id) => !validIds.has(id));
  if (unknownIds.length > 0) {
    return `finding id(s) ${outsideSetLabel}: ${unknownIds.map((i) => `\`${i}\``).join(", ")}`;
  }
  return null;
}

/**
 * Apply one mid-run clarification resolution to its execution unit:
 * `clarified` re-opens it (pending) with the answer as context,
 * `reject_finding` closes it as not-a-real-issue (terminal `deemed_inappropriate`
 * disposition), and `defer` closes it as an explicit user deferral for this run.
 * Never resurrects a terminal item.
 */
function applyClarificationActionToItem(
  item: RemediationItemState,
  res: PlanClarificationResolution,
  now: string,
): void {
  // The question is answered (or the finding is closed): it leaves the item.
  delete item.clarification_question;
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
  const inputSnapshot = await readDecisionSnapshot(resolutionPath);
  const contextDigest = decisionContextDigest(state);
  const parsed = await readPlanClarificationResolutions(resolutionPath, inputSnapshot?.bytes);
  // Uniform whole-file fail-closed contract: a malformed entry or an id outside
  // the paused set refuses the WHOLE resolution (archived, nothing applied) and
  // re-halts with the reason named. The silent-continue alternative drops the
  // user's answer and leaves its item waiting on a question nobody is asked, so
  // a decision record never half-applies.
  const refusal = planClarificationRefusal(
    parsed,
    new Set(pausedClarifications(state).map((q) => q.unit_id)),
    "not waiting for a clarification",
  );
  if (refusal !== null || !parsed.ok) {
    await withFsRetry(() =>
      rename(resolutionPath, `${resolutionPath}.refused-${Date.now()}`),
    );
    return {
      kind: "refused",
      step: await handleWaitingForClarification(
        root,
        artifactsDir,
        state,
        refusal ?? "the resolution could not be read",
      ),
    };
  }
  const resolutions = parsed.resolutions;
  const now = new Date().toISOString();
  let appliedCount = 0;
  for (const res of resolutions) {
    const item = state.items[res.unit_id];
    if (!item || isTerminalStatus(item.status)) continue;
    // The reviewed plan is never rewritten here, and its revision (which hashes
    // author order) stays the approved one.
    applyClarificationActionToItem(item, res, now);
    appliedCount += 1;
  }
  // An applied answer mutates item state that is baked into the dispatch
  // prompt, so the persisted workload binding is stale the moment a resolution
  // lands — a surviving record makes the next handoff prepare refuse its own
  // regenerated workload (and a non-implementing status refuses the save
  // outright). Mirrors the saveStateForPlan strip.
  if (appliedCount > 0) delete state.host_handoff;
  if (!inputSnapshot) throw new Error("Clarification input changed during application; retry without accepting it.");
  (state.decision_applications ??= []).push({ input: "clarification_resolution.json", input_sha256: inputSnapshot.sha256, input_identity_sha256: inputSnapshot.identity_sha256,
    context_sha256: contextDigest, run_id: state.plan.plan_id, revision_sha256: state.plan.review_revision_sha256,
    applied_at: now, retry_results: [] });
  const remainingPending = state.plan.units.some(
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
  await store.saveState(state);
  return { kind: "applied", state };
}

/**
 * The open worker questions: one per item paused as `needs_clarification`,
 * read from the item itself (its `clarification_question`), in content-stable
 * finding-id order. The item is the question's one home, so this list cannot
 * disagree with the item statuses the round waits on.
 */
function pausedClarifications(state: RemediationState): ClarificationRequest[] {
  return Object.values(state.items ?? {})
    .filter((item) => item.status === "needs_clarification")
    .sort((left, right) => compareCodeUnits(left.unit_id, right.unit_id))
    .map((item) => ({
      unit_id: item.unit_id,
      // The state store refuses a paused item without a question, so the
      // fallback is unreachable from a stored state; it keeps the render total.
      ...(item.clarification_question ?? {
        category: "scope_of_fix" as const,
        description: item.failure_reason ?? "(no question recorded)",
      }),
    }));
}

async function handleWaitingForClarification(
  root: string,
  artifactsDir: string,
  state: RemediationState,
  refusal?: string,
): Promise<RemediationStep> {
  const resolutionPath = join(artifactsDir, "clarification_resolution.json");
  return writeCurrentStep({
    stepKind: "collect_clarifications",
    status: "blocked",
    runId: stateRunId(state),
    repoRoot: root,
    artifactsDir,
    prompt: clarificationPrompt(pausedClarifications(state), resolutionPath, refusal),
    allowedCommands: [loaderCommand("next-step")],
    stopCondition:
      "Stop after asking the user for clarification answers, unless the answers are already available and the prompt told you to continue.",
    artifactPaths: {
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
async function handlePlanning(root: string, artifactsDir: string, state: RemediationState, store: StateStore): Promise<RemediateOutcome> {
  const approved = await readApprovedExecutionPlan(artifactsDir);
  if (!approved || approved.canonical.revision_sha256 !== state.plan?.review_revision_sha256) {
    return { kind: "emit", step: await writeCurrentStep({ stepKind: "contract_pipeline", status: "blocked", runId: stateRunId(state), repoRoot: root, artifactsDir,
      prompt: "The executable plan has changed since approval. Re-run planning and obtain fresh bound review before implementation; accepted execution history remains intact.",
      stopCondition: "Approve the current executable revision before dispatch." }) };
  }
  if (!dispatchFrontier(state).length) sweepPermanentlyDeadBlocks(state);
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
): Promise<RemediateOutcome> {
  const triageStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "triage" });
  // sites-pinned: tests/remediate/host-handoff-corroboration-obligations.test.ts
  const conformanceIssues: import("./dispatch/contractConformanceReview.js").ConformanceReviewIssue[] = [];
  const triaged = await runTriagePhase(state, { root, artifactsDir }, issue => conformanceIssues.push(issue));
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "triage", duration_ms: Date.now() - triageStart });
  if (conformanceIssues.length) {
    await store.saveState(triaged);
    return { kind: "emit", step: await writeCurrentStep({
      stepKind: "review_contract_conformance", status: conformanceIssues.some(issue => issue.code === "conformance_review_unavailable") ? "blocked" : "ready",
      runId: stateRunId(triaged), repoRoot: root, artifactsDir,
      prompt: ["Independent contract conformance review is required before triage can accept these tool-owned working-tree observations.", ...conformanceIssues.map(issue => `${issue.work_item_id}: ${issue.message}\nRequest: ${issue.review_request_path}`), "Read each request in an independent context and write its bound response. Self-review cannot satisfy this requirement. Resume next-step after the responses are ready."].join("\n\n"),
      stopCondition: "Obtain independent conformance review or remain paused.",
      allowedCommands: [loaderCommand("next-step")],
    }) };
  }
  // Triage may enter closing directly: the close itself owns mandatory final
  // acceptance, so a status transition cannot bypass it.
  if (triaged.status === "closing") return handleAllTerminalTransition(triaged, store, root, artifactsDir);
  await store.saveState(triaged);
  return { kind: "transition", state: triaged };
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
 * COST OF THE PAUSE. The gate's verdict is cached against the TREE CONTENT, so
 * re-entering a boundary with the tree untouched serves the recorded verdict —
 * the pause re-emits from cache without spawning a builder or a suite. A green
 * on a fixed tree, and a re-run on a tree that MOVED, both go to the floor as
 * before: the cache is an equality check on content, never a counter and never a
 * reason to skip a tree nobody judged.
 */
async function emitFinalGateRedStep(ctx: {
  root: string;
  artifactsDir: string;
  state: RemediationState;
  scope: string;
  /**
   * Where the run stands, in the operator's words — the sentence opener of the
   * pause ("At the phase 2 boundary", "Before the close phase"). `scope` stays
   * the recorded identifier; this is only how the prompt names it.
   */
  where: string;
  gate: ToolOwnedFinalGateResult;
  runLogger: RunLogger;
  /**
   * The content id this red is bound to, as the CALLER measured it — the same
   * value the verdict record was written (or read) against, never a second
   * derivation taken here. `null` when no identity could be taken, and
   * `undefined` when this red is not cached at all (the all-terminal funnel
   * re-runs the floor on every arrival, so there is nothing to be bound to).
   */
  tree?: string | null;
  /** Close has already recorded its red before presentation. */
  recordedPath?: string;
}): Promise<RemediateOutcome> {
  const { root, artifactsDir, state, scope, gate, runLogger } = ctx;
  const failed = gate.results.find((r) => !r.passed);
  const recordPath = ctx.recordedPath ?? await writeFinalGateRedRecord(artifactsDir, scope, failed, {
    root,
    state,
  });
  const failingCommand = failed
    ? `${failed.argv.join(" ")} (exit ${String(failed.exit_code)})`
    : "(the gate reported no failing command)";
  // Read the attribution back OFF THE RECORD rather than recomputing it: the
  // record is the durable statement, and a prompt that derived its own answer
  // from a fresh git read could disagree with the artifact the same step points
  // at. Absent (the record was written by the no-state path, or attribution
  // chose not to run) means no verdict is asserted, which is exactly what the
  // prompt then says.
  const attribution = (
    await readOptionalJsonFile<{ attribution?: GateRedAttribution }>(recordPath)
  )?.attribution;
  const attributionBlock = renderGateAttribution(attribution);
  runLogger.event({
    phase: "next-step",
    kind: "outcome",
    obligation: state.status,
    note:
      `final_gate_red scope=${scope} command=${failed ? failed.argv.join(" ") : "unknown"}` +
      (attribution ? ` attribution=${attribution.verdict}` : ""),
  });
  // THE BINDING, named in the prompt. The verdict this pause repeats is cached
  // against the CONTENT of the tree, so an operator who reads "the suite is
  // still red" and fixes something the run cannot see — or, worse, who assumes
  // the message will change on its own — is left looping on a red that is being
  // SERVED, not observed. State the id and state exactly what moves it: any
  // edit to a non-ignored file outside the run's own artifacts. This is the
  // same carve-out `worktreeContentId` applies, said in the operator's terms.
  const bindingBlock =
    ctx.tree === undefined
      ? "The tool keeps no copy of this result. Each next-step runs the full build\n" +
        "and suite again, which takes minutes. So fix something before you run\n" +
        "next-step again."
      : ctx.tree === null
        ? "The tool could not take a tree id, so it keeps no copy of this result.\n" +
          "Each next-step runs the full build and suite again, which takes minutes.\n" +
          "So fix something before you run next-step again."
        : `The tool keeps this result for tree \`${ctx.tree}\`. An edit to any file\n` +
          `outside \`${AUDIT_TOOLS_DIRNAME}/\` and outside git-ignored paths changes that tree.\n` +
          "The next next-step then runs the full build and suite again, which takes\n" +
          "minutes. With no edit, next-step shows this same red at once and runs\n" +
          "nothing. So fix something before you run next-step again.";
  const nextCommand = loaderCommand("next-step");
  const recoveryCommand = `${nextCommand} --verification-command "<operator-approved command>"`;
  return {
    kind: "emit",
    step: await writeCurrentStep({
      stepKind: "final_gate_red",
      status: "blocked",
      runId: stateRunId(state),
      repoRoot: root,
      artifactsDir,
      prompt: gate.results.length === 0 ? `
# Verification command required

This repository declares no executable build, typecheck, lint, or test command.
No verification ran, and this run cannot advance or close as verified.

Ask the operator to supply a verification command, then run:

\`${recoveryCommand}\`

The command replaces only the test role for this run. Any declared build,
typecheck, and lint checks still run. Alternatively, stop here with work preserved.
Do not invent a passing command or waive the gate.
` : `
# Remediation paused — the repository suite is red

${ctx.where}, the tool ran the repository's declared verification commands.
One command failed:

\`${failingCommand}\`

The output tail is in \`${recordPath}\`.

This pause changes nothing. Every item keeps its status, the run stays in its
phase, and no work is lost. A red suite does not name the item that caused it.
A commit made outside this run can also cause it.

${attributionBlock}

Do these steps:

1. Fix the failing command, or confirm that it was already broken before this run.
2. Run \`${nextCommand}\`.

When the suite is green, the run continues from where it stopped.

${bindingBlock}
`,
      allowedCommands: gate.results.length === 0 ? [nextCommand, recoveryCommand] : [nextCommand],
      stopCondition:
        gate.results.length === 0
          ? "Stop. Obtain an explicit verification command from the operator or leave this run paused."
          : "Stop. Make the repository suite green, then re-run next-step to resume the run.",
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
function explicitFinalGateTestCommand(state: RemediationState): string[] | undefined {
  return state.plan?.test_command && state.plan.test_command_source !== "project_facts"
    ? parseCommandString(state.plan.test_command) : undefined;
}

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
  const where = `At the phase ${phase} boundary`;
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

  // The TREE this verdict will be about. Taken BEFORE the floor runs so the
  // cached verdict describes the state the floor actually saw; taken ONCE so
  // the identity written and the identity read back cannot be two derivations
  // that disagree.
  //
  // A boundary that re-dispatches work will get a different id on the next call
  // and the floor re-runs — which is correct: the tree it certified is gone.
  const tree = await worktreeContentId(root);
  const testCommand = explicitFinalGateTestCommand(state);
  const binding = finalGateBinding(root, testCommand);
  const gateKey = `phase_boundary_gate phase=${phase}`;

  // THE CACHE. The fold re-enters this boundary on every next-step taken before
  // the next phase dispatches, and the floor is build + typecheck + the whole
  // suite — minutes, holding the phase lock. Re-running it on a tree that cannot
  // have changed since the last verdict buys nothing: the answer is already
  // known and was already recorded. A HIT is therefore a full substitute,
  // including for a RED one (see {@link readFinalGateVerdict} — the pause is
  // rebuilt from the cached results rather than re-derived).
  const cached = await readFinalGateVerdict(artifactsDir, scope, tree, binding);
  if (cached !== undefined) {
    // Recorded as a distinct outcome from a real run: the judge is `history`,
    // not a spawned command, and `commands_run` counts what HISTORY held, never
    // what this call executed. `passed` is echoed unchanged, so a cached green
    // still reads green and a cached red still reads red.
    await recordFinalGateOutcome({
      artifactsDir,
      state,
      scope,
      gateKey,
      runLogger,
      outcome: "history",
      passed: cached.passed,
      commandsRun: cached.results.filter(result => result.ran !== false).length,
      reason:
        `a verdict for this exact tree content is already recorded (scope "${cached.scope}", ` +
        `recorded_at ${cached.recorded_at}); the floor was NOT re-run because the tree it ` +
        "would run against has not changed",
    });
    if (cached.passed) return null; // cached green (or scope-out) → dispatch
    // Cached RED. The run has not progressed since that verdict — the pause
    // mutates nothing — so re-entering it is the same pause, rebuilt from the
    // cached command results so the record keeps its failing command, exit code
    // and output tail.
    return emitFinalGateRedStep({
      root,
      artifactsDir,
      state,
      scope,
      where,
      gate: {
        passed: false,
        results: cached.results,
        outcome: cached.outcome,
        scoped_out: cached.scoped_out,
        runtime_residual: RUNTIME_RESIDUAL_DECLARATION,
      },
      // The RECORD's own tree, not the freshly-measured one: the prompt must
      // name the identity the cached verdict is actually bound to, which is the
      // one readFinalGateVerdict just matched on.
      tree: cached.tree,
      runLogger,
    });
  }

  const gateStart = Date.now();
  runLogger.event({
    phase: "next-step",
    kind: "executor_start",
    obligation: state.status,
    note: gateKey,
  });
  const gate = await runToolOwnedFinalGate(root, { runner: options.finalGateRunner, testCommand: explicitFinalGateTestCommand(state) });
  await writeFinalGateVerdict(artifactsDir, {
    scope,
    tree,
    binding,
    passed: gate.passed,
    scoped_out: gate.scoped_out,
    outcome: gate.outcome,
    results: gate.results,
  });
  await recordFinalGateOutcome({
    artifactsDir,
    state,
    scope,
    gateKey,
    runLogger,
    outcome: gate.outcome,
    passed: gate.passed,
    commandsRun: gate.results.filter(result => result.ran !== false).length,
    ...(gate.outcome === "scoped_out"
      ? { reason: "no executable verification command declared; operator command required" }
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
    where,
    gate,
    // The id taken BEFORE the floor ran, which is what writeFinalGateVerdict
    // just recorded — so the prompt names the binding the cache will match on.
    tree,
    runLogger,
  });
}

async function handleAllTerminalTransition(
  state: RemediationState,
  store: StateStore,
  root: string,
  artifactsDir: string,
): Promise<RemediateOutcome> {
  // sites-pinned: tests/remediate/host-handoff-corroboration-obligations.test.ts
  if (await reopenStaleTriageSuccesses(root, artifactsDir, state)) {
    await store.saveState(state);
    return { kind: "transition", state };
  }
  // Final acceptance belongs to the actual close execution, after preview
  // pauses. A transition carries no executable verification verdict.
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
  options: NextStepOptions,
): Promise<RemediateOutcome> {
  // sites-pinned: tests/remediate/host-handoff-corroboration-obligations.test.ts
  if (await reopenStaleTriageSuccesses(root, artifactsDir, state)) {
    await store.saveState(state);
    return { kind: "transition", state };
  }
  const closeStart = Date.now();
  runLogger.event({ phase: "next-step", kind: "executor_start", obligation: state.status, note: "close" });

  // Target verification and closing are product obligations. Development
  // reflection is owned by this repository's sprint closeout; captured run
  // diagnostics are still archived by runClosePhase before cleanup.
  let paused: RemediateOutcome | undefined;
  let closed: RemediationState;
  try {
    closed = await runClosePhase(state, {
      root, artifactsDir,
      skipFinalGate: options.skipFinalGate,
      finalGateRunner: options.finalGateRunner,
      finalizeClosing: options.finalizeClosing,
      onFinalGateRed: async (gate) => {
        paused = await emitFinalGateRedStep({
          root, artifactsDir, state, scope: "all-terminal final gate",
          where: "Before completing the close phase", gate, runLogger,
          recordedPath: finalGateRecordPath(artifactsDir),
        });
      },
    }, runLogger);
  } catch (error) {
    if (!(error instanceof RemediationPlanAuthorityError)) throw error;
    return { kind: "emit", step: await emitPlanRevisionBlockedStep(root, artifactsDir, {
      reason: `Closing is paused before any closing action. ${error.message}`,
    }) };
  }
  if (paused) return paused;
  runLogger.event({ phase: "next-step", kind: "executor_end", obligation: state.status, note: "close", duration_ms: Date.now() - closeStart });
  if (closed.status !== "complete") {
    await store.saveState(closed);
    const preview = closed.closing_plan?.closing_action_preview;
    if (closed.status === "closing" && preview && !closed.closing_plan?.pre_authorized) {
      const approveCommand = loaderCommand("next-step --finalize-closing");
      return {
        kind: "emit",
        step: await writeCurrentStep({
          stepKind: "close_run", status: "ready", runId: stateRunId(closed),
          repoRoot: root, artifactsDir,
          prompt: [
            "# Approve closing action",
            `Ask the user to approve the closing action: ${closed.closing_plan?.action}.`,
            `Commit message: ${preview.commit_message}`,
            "Files:", ...preview.files.map(file => `- ${file}`),
            ...(preview.leftover_files?.length ? ["Files left untouched:", ...preview.leftover_files.map(file => `- ${file}`)] : []),
            `Only after the user approves, run: ${approveCommand}`,
            "If the preview changes, approval is requested again. Final verification runs after approval.",
          ].join("\n"),
          allowedCommands: [approveCommand],
          stopCondition: "Stop after presenting the closing preview and wait for user approval.",
        }),
      };
    }
    // Re-blocked to triage: persist and re-scan.
    return { kind: "transition", state: closed };
  }
  // Close-complete CROSSES the engine boundary: `complete` is a pre-intake
  // obligation, unreachable from a main-engine transition. Emit the durable
  // report directly, passing exactly what the original recursion reloaded — the
  // artifact dir is DELETED on a fully-green close (reload → null, and a null
  // state renders no friction block) and PRESERVED on a not-green complete
  // (reload → the saved complete state → its plan_id). `store.loadState()`
  // reproduces both, so present_report is identical to the cascade.
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
    (itemsByStatus[item.status] ??= []).push(item.unit_id);
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

function isPlanOnlyBoundary(state: RemediationState | null): boolean {
  return state?.status === "implementing" || state?.status === "closing";
}

async function buildOperatorControlStep(
  root: string, artifactsDir: string, state: RemediationState | null, control: OperatorLifecycle,
): Promise<RemediationStep> {
  const cancelled = control.mode === "cancelled";
  const active = control.mode === "active";
  const next = loaderCommand(["next-step", "--root", root, "--artifacts-dir", artifactsDir]);
  const resume = loaderCommand(["resume", "--root", root, "--artifacts-dir", artifactsDir]);
  return writeCurrentStep({
    stepKind: cancelled ? "operator_cancelled" : active ? "operator_resumed" : "operator_paused",
    status: cancelled ? "complete" : active ? "ready" : "blocked",
    runId: stateRunId(state), repoRoot: root, artifactsDir,
    prompt: active
      ? `# Remediation resumed\n\nAccepted work and the live workload binding are unchanged. Run \`${next}\` to derive the next continuation.`
      : cancelled
      ? "# Remediation cancelled\n\nThe operator cancelled this run. No further work will be accepted or dispatched. All run artifacts and accepted work are preserved."
      : `# Remediation paused\n\n${control.reason === "plan-only" ? "Planning finished; implementation has not been dispatched by this plan-only continuation." : "The operator paused this run."} The live phase, accepted items and workload binding are preserved.\n\nRun \`${resume}\`, then next-step, to continue from the live state.`,
    allowedCommands: cancelled ? [] : [active ? next : resume],
    stopCondition: cancelled ? "This run is terminally cancelled. Stop." : active ? "Run next-step to continue from the live state." : "Stop until the operator explicitly resumes this run.",
    artifactPaths: { operator_lifecycle: join(artifactsDir, OPERATOR_LIFECYCLE_FILENAME) },
  });
}

/** Operator commands serialize with every advancing or recovery writer. */
export async function changeOperatorLifecycle(options: {
  root?: string; artifactsDir?: string; action: Exclude<OperatorLifecycleAction, "plan-only">;
  hostReport?: OperatorLifecycle["host_report"];
}): Promise<RemediationStep> {
  const root = resolveRoot(options.root);
  const artifactsDir = resolveArtifactsDir(root, options.artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  const store = new StateStore(artifactsDir);
  return withFileLock(join(artifactsDir, "phase.lock"), async () => {
    const control = await store.setOperatorLifecycleUnderPhaseLock(options.action, options.hostReport);
    return buildOperatorControlStep(root, artifactsDir, await store.loadState(), control);
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

/**
 * The closing-action choice, rendered from DETECTED facts. Lists only the
 * candidates the repository's shape makes appropriate, each with the fact
 * behind it, and says outright that the tool selects nothing: an omitted
 * `closing_action` is `none`.
 */
function renderClosingActionSection(facts: ProjectFacts): string {
  const candidateLines = facts.candidate_closing_actions
    .map((action) => `- \`${action}\` — ${facts.candidate_rationale[action] ?? ""}`)
    .join("\n");
  const vocabulary = CLOSING_ACTIONS.map((action) => `\`${action}\``).join(", ");
  return [
    "## Closing Action — you choose",
    "",
    `Detected project type: \`${facts.project_type}\`. The repository's shape makes these closing actions appropriate. The tool never selects one: set \`closing_action\` in the checkpoint, or omit it to choose \`none\`.`,
    "",
    candidateLines,
    "",
    `Any other value from ${vocabulary} is accepted as an explicit alternative. \`custom\` runs the argv you write beside it as \`closing_custom_command\` (for example ["npm", "run", "release"]); a \`custom\` without one is refused.`,
  ].join("\n");
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

  // Read a checkpoint the host already wrote, if one exists.
  //
  // This is the GATE, and it reads LENIENTLY on purpose: a checkpoint whose
  // `closing_action` is outside the vocabulary must reach the refusal below,
  // where the prompt names the offending value and the legal set. A strict read
  // would replace that affordance with a zod error. Every field consumed here as
  // a VALUE is still checked by name (`isClosingAction`, `customCommandOf`).
  //
  // The REFUSED values come from `rejected`, never from `existing`: the returned
  // checkpoint is schema-valid, so an out-of-vocabulary key is ABSENT from it
  // (see `parseIntentCheckpointLenient`). The value the refusal quotes is the one
  // the host WROTE, which is exactly what `rejected` carries.
  const existingRead = await readIntentCheckpointLenient(checkpointPath);
  const existing = existingRead.checkpoint;
  const rejectedClosingAction = existingRead.rejected.find(
    (field) => field.key === "closing_action",
  );
  // The proposal comes from the intake summary — the one file the host wrote at
  // synthesis. There is no draft checkpoint: the facts live in one place.
  const summary = (await readIntakeArtifacts(artifactsDir)).summary;
  const selection = (await readSourceManifest(intakePaths(artifactsDir).sourceManifest))?.finding_selection;

  // Closing action: DETECTED candidates, presented for the host to choose
  // from; the tool never selects one (owner decision 92b0e2dd7cfdc06d).
  const facts = await detectProjectFacts(root);
  // Persisted for planning, which spawns nothing by contract and reads this
  // artifact instead of detecting again.
  await writeProjectFacts(artifactsDir, facts);
  const closingSection = renderClosingActionSection(facts);
  // A confirmed checkpoint whose closing_action is not in the vocabulary
  // re-enters this step by name — a refusal, never a silent default.
  const rawChoice: unknown =
    existing?.confirmed_by === "host"
      ? (existing.closing_action ?? rejectedClosingAction?.value)
      : undefined;
  const refusal =
    rawChoice !== undefined && !isClosingAction(rawChoice)
      ? `> **Refused:** \`closing_action\` ${JSON.stringify(rawChoice)} is not one of ${CLOSING_ACTIONS.map((a) => `\`${a}\``).join(", ")}. Rewrite the checkpoint with a valid value, or omit the field for \`none\`.\n`
      : rawChoice === "custom" && customCommandOf(existing) === null
        ? "> **Refused:** `closing_action` \"custom\" needs `closing_custom_command`, a non-empty argv array such as [\"npm\", \"run\", \"release\"]. Add it, or choose another action.\n"
        : "";

  let prompt: string;
  if (summary) {
    // Build a consolidated single-stop proposal from the intake summary.
    const questions = summary.open_questions ?? [];
    // INV-remediate-state-06: only explicit blocking===true is blocking.
    const blockingQs = questions.filter((q) => q.blocking === true);
    const nonBlockingQs = questions.filter((q) => q.blocking !== true);

    const questionLines = [
      ...blockingQs.map((q) => `- **[blocking] ${q.id}**: ${q.question}`),
      ...nonBlockingQs.map((q) => `- **[FYI] ${q.id}**: ${q.question}`),
    ].join("\n") || "- None";

    const filtersBlock = Object.keys(summary.filters).length > 0
      ? `\`\`\`json\n${JSON.stringify(summary.filters, null, 2)}\n\`\`\``
      : selection ? "(none — keeping every finding in the selected source)" : "(none — remediating all findings)";

    prompt = `
${refusal}# Confirm Remediation Scope and Intent

The tool built the following proposal from the intake summary. Review each section
and adjust where needed, then confirm by writing the final \`intent_checkpoint.json\`.

## Proposed Scope

${summary.scope_summary}

## Proposed Intent

${summary.intent_summary}
${summary.intent_interpretation ? `\n**How free-form intent was interpreted:** ${summary.intent_interpretation}\n` : ""}
## Proposed Filters

${filtersBlock}

## Open Questions

${questionLines}

${closingSection}

---

To confirm, write the final checkpoint to:

\`${checkpointPath}\`

\`\`\`json
{
  "schema_version": "intent-checkpoint/v1",
  "confirmed_at": "<ISO-8601 timestamp>",
  "confirmed_by": "host",
  "scope_summary": ${JSON.stringify(summary.scope_summary)},
  "intent_summary": ${JSON.stringify(summary.intent_summary)},
  "free_form_intent": "<optional: additional guidance>",
  "filters": ${JSON.stringify(summary.filters, null, 2)},
  "excluded_scope": [{ "path": "<path or prefix>", "reason": "<why>" }],
  "must_not_touch": [],
  "closing_action": "<one of the candidates above, or omit the field for none>",
  "closing_custom_command": ["<only with custom: the argv to run>"]
}
\`\`\`

Adjust \`filters\`, \`excluded_scope\`, \`must_not_touch\`, or \`free_form_intent\` to
narrow scope. Valid severities: ${VALID_SEVERITIES_PROSE}.
Valid lenses: ${VALID_LENSES_PROSE}.

If the operator requests independent contract conformance review, add \`"conformance_review": true\` before the first implementation handoff. It is off by default and the tool keeps the confirmed choice for this run.

Once written with \`"confirmed_by": "host"\`, run:

\`${nextCommand}\`
`;
  } else {
    // Fallback for when no intake summary exists yet.
    prompt = `
${refusal}# Confirm Remediation Scope and Intent

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
  "must_not_touch": ["<glob>"],
  "closing_action": "<one of the candidates below, or omit the field for none>",
  "closing_custom_command": ["<only with custom: the argv to run>"]
}
\`\`\`

${closingSection}

- \`filters\` drop findings that don't match BEFORE planning, so only the work you want is remediated. Valid severities: ${VALID_SEVERITIES_PROSE}. Valid lenses: ${VALID_LENSES_PROSE}. Draw \`packages\`/\`themes\` from the findings in the audit report.
- \`excluded_scope\` drops findings whose files match a path or directory prefix; \`must_not_touch\` globs are never written.
- Skipped findings are listed in the final remediation report under "Skipped by Intent Checkpoint".
- Leave the optional fields out to remediate everything in the report.

Once the file is written, run:

\`${nextCommand}\`
`;
  }

  prompt += renderFindingSelection(selection);
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
  /**
   * The top-level fields the schema REFUSED on that checkpoint, as written.
   *
   * The validated `existingCheckpoint` cannot carry them (a key that failed
   * validation is absent from a schema-valid value — see
   * `parseIntentCheckpointLenient`), but the `confirm_intent` gate must still
   * FIRE on one: an out-of-vocabulary `closing_action` that the read dropped
   * would leave `existingCheckpoint.confirmed_by === "host"` intact, every
   * `fires` branch false, and the run advancing on a checkpoint whose
   * `closing_action` was never accepted. A dropped key must never read as "no
   * answer given, so no question".
   */
  rejectedCheckpointFields: readonly RejectedCheckpointField[];
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
  /** Canonical source ownership starts before a runtime state exists. */
  sourceAlreadyBound?: boolean;
  /** A selected source or its explicit selector changed, including on bare resume. */
  inputSelectionChanged?: boolean;
  selectionAlreadyBound?: boolean;
  selectedSourceChanged?: boolean;
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
  const { existingCheckpoint, rejectedCheckpointFields, resumeAck, entryState, suppliedInputUnchanged, sourceAlreadyBound, inputSelectionChanged, selectionAlreadyBound, selectedSourceChanged, guidanceFileSupplied } = snapshot;
  const ip = intakePaths(artifactsDir);
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  const ackPath = join(artifactsDir, "confirm_resume_ack.json");
  /** The refused `closing_action`, if the schema dropped one — see the `fires` note. */
  const rejectedClosingAction = rejectedCheckpointFields.find(
    (field) => field.key === "closing_action",
  );
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
        (selectionAlreadyBound && inputSelectionChanged) ||
        (((inputResolution.supplied && !suppliedInputUnchanged) ||
          inputSelectionChanged || guidanceFileSupplied) &&
        (sourceAlreadyBound || (entryState != null && entryState.status !== "pending")))
          ? "missing"
          : "satisfied",
      execute: async (_state, c) => {
        const s = entryState ?? { status: "pending" as const };
        await c.countStep(entryState);
        return {
          kind: "emit",
          step: await handleInputConflict(c.root, c.artifactsDir, s, c.inputResolution,
            selectionAlreadyBound && inputSelectionChanged ? { sourceChanged: selectedSourceChanged === true } : undefined),
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
      // intake artifact or an active run). A legacy draft checkpoint was archived
      // at the snapshot read, so it counts as no checkpoint. Never for
      // complete/closing — those already confirmed their checkpoint.
      id: "confirm_intent",
      derive: (state) => {
        // A host-confirmed checkpoint carrying a closing_action outside the
        // vocabulary is not a confirmation: the step re-emits naming the value
        // (owner decision 92b0e2dd7cfdc06d — never a silent default).
        //
        // The refused value comes from `rejectedCheckpointFields` as well as from
        // the parsed checkpoint, and it must: the lenient read DROPS a key the
        // schema refused, so an out-of-vocabulary `closing_action` is absent from
        // `existingCheckpoint` and the read of it alone would answer `undefined`
        // — "no answer given, so no question" — leaving every branch of `fires`
        // false and advancing on a checkpoint whose action was never accepted.
        // `confirmed_by` survives the drop, which is exactly what makes that
        // silent pass possible; reading the rejection back is what closes it.
        const chosenClosingAction: unknown =
          existingCheckpoint?.confirmed_by === "host"
            ? ((existingCheckpoint as { closing_action?: unknown }).closing_action ??
              rejectedClosingAction?.value)
            : undefined;
        const invalidClosingAction =
          (chosenClosingAction !== undefined && !isClosingAction(chosenClosingAction)) ||
          (chosenClosingAction === "custom" && customCommandOf(existingCheckpoint) === null);
        const activeRunState =
          state != null &&
          state.status !== "pending" &&
          state.status !== "complete" &&
          state.status !== "closing";
        const fires =
          invalidClosingAction ||
          (!existsSync(checkpointPath) &&
            (existsSync(ip.summary) ||
              existsSync(executionPlanPaths(artifactsDir).canonical) ||
              existsSync(executionPlanPaths(artifactsDir).source) ||
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
          existsSync(executionPlanPaths(artifactsDir).canonical) ||
          sourceAlreadyBound ||
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
  "operator_plan_only",
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
      id: "operator_plan_only",
      derive: (state) => options.planOnly === true && isPlanOnlyBoundary(state) ? "missing" : "satisfied",
      execute: async (state) => {
        const control = await store.setOperatorLifecycleUnderPhaseLock("pause", undefined, "plan-only");
        return { kind: "emit", step: await buildOperatorControlStep(root, artifactsDir, state, control) };
      },
    },
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
        // A wait with no paused item has no question to ask: a round rendered
        // from it lists nothing, and no answer can satisfy it. Return to
        // `implementing`, whose own obligations route the run onward.
        if (!hasUnansweredClarification(s)) {
          s.status = "implementing";
          await store.saveState(s);
          return { kind: "transition", state: s };
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
        dispatchFrontier(state).length === 0
          ? "missing"
          : "satisfied",
      execute: async (state) => {
        const s = requireState(state);
        s.status = "waiting_for_clarification";
        // The binding is scoped to `implementing` (INV-RSM-STATE-COMPLETE: the
        // load gate rejects a `host_handoff` under any other status, and the
        // store's write hook enforces the same rule). Leaving the status
        // without clearing the record produced a state the tool itself could
        // not read back — a state that only escaped because nothing validated
        // the write path. Dropping it here is also what the field MEANS: the
        // pending workload it digests is about to be re-prepared for the
        // answered item.
        delete s.host_handoff;
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
        // A non-empty dispatch frontier dispatches; triage only runs once every
        // item has left "pending".
        const pendingBlocks = dispatchFrontier(s);
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
        // Dead-end pending nodes that can never enter the frontier (INV-RS-01)
        // so the implementing→triage loop can't livelock; transition so the
        // engine re-scans on the updated state.
        if (sweepPermanentlyDeadBlocks(s)) {
          await store.saveState(s);
          return { kind: "transition", state: s };
        }
        return handleImplementing(root, artifactsDir, s, runLogger, store);
      },
    },
    {
      id: "triage",
      derive: (state) => (state?.status === "triage" ? "missing" : "satisfied"),
      execute: async (state) =>
        handleImplementing(root, artifactsDir, requireState(state), runLogger, store),
    },
    {
      // planning with zero documentable findings is a user question, not a
      // dead-end — must fire BEFORE all_terminal so an all-resolved planning state
      // doesn't silently advance to close.
      id: "planning_zero",
      derive: (state) =>
        state != null &&
        state.status === "planning" &&
        documentableFindings(state).length === 0 && !allItemsTerminal(state)
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
        handleAllTerminalTransition(requireState(state), store, root, artifactsDir),
    },
    {
      id: "closing",
      derive: (state) => (state?.status === "closing" ? "missing" : "satisfied"),
      execute: async (state) =>
        handleClosing(root, artifactsDir, requireState(state), runLogger, store, options),
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
  if (state) await store.reconcileDecisionApplications(state);
  let control = await store.loadOperatorLifecycle();
  if (control && control.mode !== "active") {
    return buildOperatorControlStep(root, artifactsDir, state, control);
  }
  if (options.planOnly === true) control = await store.setOperatorLifecycleUnderPhaseLock("plan-only");
  // Covers a crash after planning saved its phase but before its pause was
  // persisted. No override, guidance, ingestion or dispatch may slip through.
  if (control?.plan_only && isPlanOnlyBoundary(state) && !options.forceReplan) {
    control = await store.setOperatorLifecycleUnderPhaseLock("pause", undefined, "plan-only");
    return buildOperatorControlStep(root, artifactsDir, state, control);
  }
  if (options.guidanceFile && options.guidanceText !== undefined) throw new Error("Choose --guidance or --guidance-file, not both.");
  const boundSource = await readPlanSource(artifactsDir);
  // A conflicting new source must reach the bounded choice before bootstrap
  // touches the existing conversation input (or throws on different bytes).
  if (!boundSource && (state == null || state.status === "pending")) {
    if (options.guidanceFile) applyGuidanceFile(artifactsDir, options.guidanceFile);
    if (options.guidanceText !== undefined) applyGuidanceText(artifactsDir, options.guidanceText);
  }

  if (options.verificationCommand !== undefined && state?.plan) {
    if (parseCommandString(options.verificationCommand).length === 0) {
      throw new Error("--verification-command must name an executable command");
    }
    state.plan.test_command = options.verificationCommand;
    state.plan.test_command_source = "explicit";
    await store.saveState(state);
  }
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
  const currentCanonical=state?.plan ? await readCanonicalPlan(artifactsDir) : undefined;
  if (state != null && (options.forceReplan || existsSync(executionPlanPaths(artifactsDir).submission) || (currentCanonical && currentCanonical.revision_sha256!==state.plan?.review_revision_sha256))) {
    await countStep(state);
    const replanOutcome = await forceReplanFromExistingIntake(
      root,
      artifactsDir,
      state,
      runLogger,
    );
    // A discarded plan is REPORTED here, not collapsed into `state = null`. Once
    // it is null the loop can no longer tell "the plan was destroyed, and here is
    // why" from "there was never an input", and it emits the second.
    if (replanOutcome !== null && "kind" in replanOutcome) {
      if(replanOutcome.kind==="planning_step")return replanOutcome.step;
      return emitPlanRevisionBlockedStep(root, artifactsDir, replanOutcome);
    }
    state = replanOutcome;
  }

  // Pre-read the once-async signals the pre-intake derive()s consume
  // synchronously (no transition inside this advance call rewrites either file).
  const checkpointPath = join(artifactsDir, "intent_checkpoint.json");
  // LENIENT: this read feeds the pre-intake derive()s, whose confirmation
  // obligation is what REFUSES a malformed checkpoint by name and re-asks. A
  // strict read here would pre-empt that obligation with a thrown load error.
  //
  // Every consumer of the VALUE here uses a validated field (as a value, or as a
  // presence question on a DIFFERENT field), never quotes an offending one — the
  // prompt that quotes the refused value is `buildConfirmIntentStep`, which reads
  // the raw rejections itself. So this site takes the plain lenient read, whose
  // value is schema-valid.
  //
  // The REJECTIONS are threaded beside it rather than discarded, because one
  // consumer is not a value read: `confirm_intent`'s `fires` asks whether the
  // checkpoint carries an ACCEPTED answer, and a refused `closing_action` is a
  // key the lenient read DROPPED — so the parsed value cannot answer for it, and
  // asking only the parsed value reads a refusal as "no answer given, so no
  // question". Strict is not the alternative: it would replace the gate's named
  // refusal with a thrown load error.
  //
  // A legacy DRAFT checkpoint (`confirmed_by: "draft"`, written by the retired
  // synthesis prompt) is not a confirmation. It is archived here, so that every
  // presence check on the checkpoint path below reads it as absent and the
  // confirm step asks again.
  if (isLegacyDraftCheckpoint(await readOptionalJsonFile<unknown>(checkpointPath))) {
    await rename(checkpointPath, `${checkpointPath}.legacy-draft-${Date.now()}`);
  }
  const checkpointRead = existsSync(checkpointPath)
    ? await readIntentCheckpointLenient(checkpointPath)
    : undefined;
  const existingCheckpoint = checkpointRead?.checkpoint;
  const resumeAck = await readOptionalJsonFile<{ choice?: string }>(
    join(artifactsDir, "confirm_resume_ack.json"),
  );
  // Whether a supplied `--input` matches the input the existing run was built
  // from — so re-passing the same `--input` (the loader does this each next-step)
  // resumes rather than tripping the input_conflict gate.
  const sourceManifest = await readSourceManifest(intakePaths(artifactsDir).sourceManifest);
  const requestedSelection = requestedFindingSelection(options);
  const recordedSelection = sourceManifest?.finding_selection;
  const selectedSourceChanged = recordedSelection !== undefined && (!existsSync(recordedSelection.source_path) ||
    hashContent(await readFile(recordedSelection.source_path, "utf8")) !== recordedSelection.source_hash);
  const inputSelectionChanged = selectedSourceChanged ||
    (requestedSelection !== undefined && JSON.stringify(requestedSelection) !== JSON.stringify(recordedSelection?.criteria));
  const suppliedInputUnchanged = !inputSelectionChanged && suppliedInputMatchesRun(
    inputResolution, sourceManifest,
    boundSource?.sources.map(source => source.path).filter(path => resolve(path) !== resolve(intakePaths(artifactsDir).brief)),
  );

  // The linear pre-intake gates run as obligations through the shared advance
  // loop. An emit returns to the host; a transition re-scans within this call;
  // exhausting them (step === null) means the run is past intake and falls
  // through to the post-intake `advance` (MAIN_PRIORITY) below.
  const ctx: RemediateCtx = {
    root,
    artifactsDir,
    options: { ...options, planOnly: control?.plan_only === true },
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
        rejectedCheckpointFields: checkpointRead?.rejected ?? [],
        resumeAck,
        entryState: state,
        suppliedInputUnchanged,
        sourceAlreadyBound: boundSource !== undefined,
        inputSelectionChanged,
        selectionAlreadyBound: recordedSelection !== undefined,
        selectedSourceChanged,
        guidanceFileSupplied: Boolean(options.guidanceFileSupplied || options.guidanceFile || options.guidanceText !== undefined),
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
