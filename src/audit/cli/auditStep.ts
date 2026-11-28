import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import type { AssertLockOwnership } from "../../shared/io/fileLock.js";
import { assertNoPendingFoldReceipt } from "../io/foldReceiptPath.js";
import { commitFold, createFoldTransaction } from "./foldTransaction.js";
import { ensureRunSourceRoot, readRunSourceRoot, resolveRunSince } from "../io/runSnapshot.js";
import { readAuditReviewSubmission, currentAuditReviewInputRevision } from "./reviewSubmission.js";
import { GATE_LANES, systemicChallengeLane } from "./laneSubmissions.js";
// sites-pinned: tests/audit/next-step-helpers.test.ts, tests/audit/charter-emit-order.test.ts, tests/audit/executor-registry-sync.test.ts, tests/audit/pipeline-integration.test.ts, tests/audit/review-evidence-right-sizing.test.ts
import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  readJsonFile,
  RunLogger,
  CharterExtractionMergedSchema,
  CharterComparisonSubmissionSchema,
  CharterFidelitySubmissionSchema,
  ClarificationAnswersSubmissionSchema,
  type SystemicChallengeSubmission,
} from "audit-tools/shared";
import { systemicChallengeSchemaForBundle } from "../orchestrator/systemicChallengeExecutor.js";
import { loadArtifactBundle } from "../io/artifacts.js";
import { advanceAudit } from "../orchestrator/advance.js";
import type { AdvanceAuditResult } from "../orchestrator/advanceTypes.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { IntentEquivalenceVerdictSchema } from "../orchestrator/intentEquivalenceExecutor.js";
import type { EdgeReasoningResults } from "../orchestrator/edgeReasoning.js";
import { laneSubmissionPath } from "./laneSubmissions.js";
import { nextStepCommand } from "./prompts.js";
import type { AnalyzerSetting, SynthesisNarrative, CriticalFlowFallbackResult } from "audit-tools/shared";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type { ExternalAcquisitionAdvanceOptions } from "../orchestrator/acquisitionExecutor.js";
import type { ScopeIndexMemo } from "../orchestrator/scopeIndexBaseline.js";
import { readQuestionReviewRunId } from "./questionReviewSession.js";
import { deriveQuestionCycleUnlocked } from "./questionReviewCycle.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import { reviewSourceScope } from "../orchestrator/questionPlanning.js";
import { checkFileIntegrity } from "../orchestrator/fileIntegrity.js";

export interface RunAuditStepOptions {
  /** The LIVE repository root: identity (consent, manifest name, write-back). */
  root: string;
  artifactsDir: string;
  /**
   * The run's frozen snapshot root every content read uses. The fold passes the
   * one it resolved under its hold; {@link runAuditStep} resolves it itself.
   */
  sourceRoot?: string;
  preferredExecutor?: string;
  /** Provide a file path OR an already-parsed object; path is only read when the object is absent. */
  externalAnalyzerPath?: string;
  externalAnalyzerData?: ExternalAnalyzerResults;
  narrativeResultsPath?: string;
  criticalFlowFallbackResultsPath?: string;
  intentEquivalenceVerdictPath?: string;
  charterSubmissionPath?: string;
  charterComparisonSubmissionPath?: string;
  charterFidelitySubmissionPath?: string;
  clarificationAnswersPath?: string;
  systemicChallengePath?: string;
  /** Gate-computed hash binding the systemic challenge's round lane and staged bytes. */
  systemicChallengeSubmissionHash?: string;
  /**
   * Already-validated edge-reasoning rewrites. Parsed + shape-checked by the
   * caller (`handleGraphEnrichmentBranch` tolerant-unwraps or quarantines the
   * submission) — never a raw file path, so no unvalidated cast here.
   */
  edgeReasoningResults?: EdgeReasoningResults;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  externalAcquisition?: ExternalAcquisitionAdvanceOptions;
  since?: string;
  runLog?: boolean;
  /**
   * The FOLD's git-index probe cache (see `ScopeIndexMemo`). Present only when
   * this dispatch is one step of a fold (`runDeterministicForNextStep` creates
   * it and threads it here); a standalone `runAuditStep` leaves it unset and
   * probes the index on its own. It rides the options bag rather than an
   * argument because it must reach `advanceAudit` INSIDE `executeAdvance`, and
   * the submission-polling gates reach that same call without a fold context to
   * read it from.
   */
  scopeIndexMemo?: ScopeIndexMemo;
}

export async function runAuditStep(
  options: RunAuditStepOptions,
): Promise<AdvanceAuditResult> {
  const runLogger = new RunLogger(join(options.artifactsDir, "run.log.jsonl"), {
    enabled: options.runLog ?? true,
  });
  // Deterministic bundle mutation is one heartbeat-protected critical section.
  // Host semantic review never runs here: it is emitted as a workload and this
  // lock only covers local artifact derivation and result ingestion.
  return await withArtifactTreeHold(options.artifactsDir, runLogger, async (assertOwnership) => {
    // The fold, not standalone synthesis, owns recovery of staged submissions.
    await assertNoPendingFoldReceipt(options.artifactsDir);
    // Check admitted tooling policy before an unsupported standalone executor
    // can restore, create or change the qualified review's frozen snapshot.
    const bundle = await loadArtifactBundle(options.artifactsDir);
    if (options.preferredExecutor === "synthesis_executor") {
      return runStandaloneSynthesis(options, runLogger, bundle, assertOwnership);
    }
    // The run's frozen snapshot is run state: created once per run, under the
    // hold, and read by every content reader of this step.
    const sourceRoot = await ensureRunSourceRoot(options.root, options.artifactsDir);
    const since = options.since === undefined
      ? undefined
      : await resolveRunSince(options.root, options.artifactsDir, options.since);
    return runAuditStepLocked({ ...options, since }, runLogger, sourceRoot, bundle, assertOwnership);
  });
}

/**
 * The LOCK-FREE, PERSIST-FREE bounded step — the fold's entry point.
 *
 * `withFileLock` is non-reentrant (an exclusive `wx` create), so a fold that
 * holds the artifact-tree lock for its whole drain cannot call {@link
 * runAuditStep}: the wrapper's second acquisition would deadlock into a
 * deterministic `FileLockTimeoutError`. The fold therefore calls this, and owns
 * the one hold and the one persist itself.
 *
 * It takes the bundle rather than loading one, because under persist-once the
 * fold's own state is not on disk yet and a reload would silently roll it back.
 *
 * The wrapper/core split is not new here — `executeAdvance` was already split
 * out "so the claim path can execute this UNLOCKED". This is that seam, named
 * and exported so the fold cannot reach the locking half by accident.
 */
export async function runAuditStepUnlocked(
  options: RunAuditStepOptions & { sourceRoot: string },
  bundle: ArtifactBundle,
  runLogger?: RunLogger,
): Promise<AdvanceAuditResult> {
  const logger =
    runLogger ??
    new RunLogger(join(options.artifactsDir, "run.log.jsonl"), {
      enabled: options.runLog ?? true,
    });
  return await executeAdvance(options, bundle, logger, options.sourceRoot);
}

/** Standalone synthesis may render the active accepted ledger, but cannot
 * advance earlier obligations, accept submissions, or reopen a finished run. */
async function runStandaloneSynthesis(
  options: RunAuditStepOptions,
  runLogger: RunLogger,
  bundle: ArtifactBundle,
  assertOwnership: AssertLockOwnership,
): Promise<AdvanceAuditResult> {
  const { root, artifactsDir } = options;
  const runId = await readQuestionReviewRunId(artifactsDir);
  if (!runId || !bundle.repo_manifest || !bundle.review_plan ||
      decideNextStep(bundle, { emitStaleness: false }).selected_obligation !== "audit_tasks_completed") {
    throw new Error("No active review ready for standalone synthesis. Continue with: " + nextStepCommand(root, artifactsDir));
  }
  const sourceRoot = await readRunSourceRoot(root, artifactsDir);
  const scope = reviewSourceScope(bundle);
  const admitted = [...new Set([...scope.allowedSourcePaths, ...scope.allowedContractPaths])];
  if (!(await checkFileIntegrity(sourceRoot, bundle.repo_manifest, admitted)).is_clean) {
    throw new Error("The frozen source changed. Continue with: " + nextStepCommand(root, artifactsDir));
  }
  const question_cycle = await deriveQuestionCycleUnlocked({ root, sourceRoot, artifactsDir, bundle, readOnlyRunId: runId });
  const projected = { ...bundle, question_cycle };
  if (question_cycle.pending.length > 0) {
    throw new Error("Question review must reach report-ready state before synthesis. Continue with: " + nextStepCommand(root, artifactsDir));
  }
  if (decideNextStep(projected, { emitStaleness: false }).selected_obligation !== "synthesis_current") {
    throw new Error("No deterministic synthesis is pending. Continue with: " + nextStepCommand(root, artifactsDir));
  }
  return runAuditStepLocked(options, runLogger, sourceRoot, projected, assertOwnership);
}

async function runAuditStepLocked(
  options: RunAuditStepOptions,
  runLogger: RunLogger,
  sourceRoot: string,
  bundle: ArtifactBundle,
  assertOwnership: AssertLockOwnership,
): Promise<AdvanceAuditResult> {
  const result = await executeAdvance(options, bundle, runLogger, sourceRoot);
  // Journal exact writes and prunes under the existing hold, without ingesting lanes.
  await commitFold(options.artifactsDir, result.updated_bundle, createFoldTransaction(), assertOwnership);
  return result;
}

// Validate any supplied worker results and run the executor for the current
// obligation, returning the advance RESULT WITHOUT persisting. Split out of
// runAuditStepLocked so the claim path can execute this UNLOCKED (holding the
// bundle-mutation claim) while the short lock is reserved for load + persist.
async function executeAdvance(
  options: RunAuditStepOptions,
  bundle: ArtifactBundle,
  runLogger: RunLogger,
  sourceRoot: string,
): Promise<AdvanceAuditResult> {
  const externalAnalyzerResults =
    options.externalAnalyzerData ??
    (options.externalAnalyzerPath
      ? await readJsonFile<ExternalAnalyzerResults>(options.externalAnalyzerPath)
      : undefined);
  const narrativeResults = options.narrativeResultsPath
    ? await readJsonFile<SynthesisNarrative>(options.narrativeResultsPath)
    : undefined;
  const criticalFlowFallbackResults = options.criticalFlowFallbackResultsPath
    ? await readJsonFile<CriticalFlowFallbackResult>(
        options.criticalFlowFallbackResultsPath,
      )
    : undefined;
  const intentEquivalenceVerdict = options.intentEquivalenceVerdictPath
    ? IntentEquivalenceVerdictSchema.parse(
        await readJsonFile<unknown>(options.intentEquivalenceVerdictPath),
      )
    : undefined;
  const charterSubmission = options.charterSubmissionPath
    ? CharterExtractionMergedSchema.parse(
        await readJsonFile<unknown>(options.charterSubmissionPath),
      )
    : undefined;
  const charterComparisonSubmission = options.charterComparisonSubmissionPath
    ? CharterComparisonSubmissionSchema.parse(
        await readAuditReviewSubmission<unknown>(options.charterComparisonSubmissionPath, options.artifactsDir, GATE_LANES.charter_comparison, () => currentAuditReviewInputRevision(sourceRoot, bundle, GATE_LANES.charter_comparison)),
      )
    : undefined;
  const charterFidelitySubmission = options.charterFidelitySubmissionPath
    ? CharterFidelitySubmissionSchema.parse(
        await readAuditReviewSubmission<unknown>(options.charterFidelitySubmissionPath, options.artifactsDir, GATE_LANES.charter_fidelity, () => currentAuditReviewInputRevision(sourceRoot, bundle, GATE_LANES.charter_fidelity)),
      )
    : undefined;
  const clarificationAnswers = options.clarificationAnswersPath
    ? ClarificationAnswersSubmissionSchema.parse(
        await readJsonFile<unknown>(options.clarificationAnswersPath),
      )
    : undefined;
  const systemicChallenge = options.systemicChallengePath
    ? (systemicChallengeSchemaForBundle(bundle).parse(
        await readAuditReviewSubmission<unknown>(options.systemicChallengePath, options.artifactsDir, systemicChallengeLane(bundle.systemic_challenge?.rounds ?? []), () => currentAuditReviewInputRevision(sourceRoot, bundle, systemicChallengeLane(bundle.systemic_challenge?.rounds ?? []))),
      ) as SystemicChallengeSubmission)
    : undefined;
  return await advanceAudit(bundle, {
    root: sourceRoot,
    repositoryRoot: options.root,
    artifactsDir: options.artifactsDir,
    externalAnalyzerResults,
    narrativeResults,
    criticalFlowFallbackResults,
    intentEquivalenceVerdict,
    charterSubmission,
    charterComparisonSubmission,
    charterFidelitySubmission,
    clarificationAnswers,
    systemicChallenge,
    systemicChallengeSubmissionHash: options.systemicChallengeSubmissionHash,
    edgeReasoningResults: options.edgeReasoningResults,
    analyzers: options.analyzers,
    graphLlmEdgeReasoning: options.graphLlmEdgeReasoning,
    externalAcquisition: options.externalAcquisition,
    since: options.since,
    preferredExecutor: options.preferredExecutor,
    // The fold's probe cache rides through to every probe this dispatch makes
    // (see `ScopeIndexMemo`). Undefined for a standalone `runAuditStep`.
    scopeIndexMemo: options.scopeIndexMemo,
    // The plan-draw classification's lane probe: pure presence, never a read
    // or a consume — a pending submission is a boundary the unforced draw
    // halts at (see AdvanceAuditOptions.submissionProbe).
    submissionProbe: async (lane) => {
      try {
        await access(laneSubmissionPath(options.artifactsDir, lane));
        return true;
      } catch {
        return false;
      }
    },
    runLogger,
  });
}
