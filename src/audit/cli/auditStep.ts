import { rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  artifactTreeLockPath,
  nodeClaimsPath,
  readJsonFile,
  RunLogger,
  withFileLock,
  withFsRetry,
  ClaimRegistry,
  claimWithBackoff,
  withClaimHeartbeat,
  CharterSubmissionSchema,
  CharterDeltaSubmissionSchema,
  ClarificationAnswersSubmissionSchema,
  SystemicChallengeSubmissionSchema,
  type SessionConfig,
} from "audit-tools/shared";
import {
  loadArtifactBundle,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import { advanceAudit } from "../orchestrator/advance.js";
import type { AdvanceAuditResult } from "../orchestrator/advanceTypes.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { EXECUTOR_RUNNERS } from "../orchestrator/executorRunners.js";
import { deriveAuditState } from "../orchestrator/state.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import type { EdgeReasoningResults } from "../orchestrator/edgeReasoning.js";
import { sizeIndexFromManifest } from "../orchestrator/reviewPackets.js";
import { partitionOrphanedAuditResults } from "../orchestrator/resultIngestion.js";
import {
  validateAuditResults,
  formatAuditResultIssues,
} from "../validation/auditResults.js";
import { formatAuditResultValidationError } from "./workerResult.js";
import { looksLikeCliFlag, listBatchResultFiles } from "./args.js";
import { buildLineIndex } from "./lineIndex.js";
import type { AuditResult } from "../types.js";
import type { AnalyzerSetting, SynthesisNarrative, CriticalFlowFallbackResult } from "audit-tools/shared";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { ExternalAcquisitionAdvanceOptions } from "../orchestrator/acquisitionExecutor.js";

async function maybeArchiveLegacyPendingResults(
  auditResultsPath: string | undefined,
): Promise<string | undefined> {
  if (!auditResultsPath || basename(auditResultsPath) !== "worker_results_pending.json") {
    return undefined;
  }

  const archivedPath = join(
    dirname(auditResultsPath),
    `worker_results_submitted_${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  try {
    await withFsRetry(() => rename(auditResultsPath, archivedPath));
    return archivedPath;
  } catch (error) {
    process.stderr.write(
      `[audit-results cleanup] failed to archive ${auditResultsPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

export interface RunAuditStepOptions {
  root: string;
  artifactsDir: string;
  preferredExecutor?: string;
  auditResultsPath?: string;
  runtimeUpdatesPath?: string;
  /** Provide a file path OR an already-parsed object; path is only read when the object is absent. */
  externalAnalyzerPath?: string;
  externalAnalyzerData?: ExternalAnalyzerResults;
  narrativeResultsPath?: string;
  criticalFlowFallbackResultsPath?: string;
  charterSubmissionPath?: string;
  charterDeltaSubmissionPath?: string;
  clarificationAnswersPath?: string;
  systemicChallengePath?: string;
  edgeReasoningResultsPath?: string;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  externalAcquisition?: ExternalAcquisitionAdvanceOptions;
  since?: string;
  runLog?: boolean;
  /**
   * 2a-ii: the EFFECTIVE dispatch config (handshake inventory overlaid onto the repo
   * config), forwarded to advanceAudit so dispatch-inventory-reading executors
   * (provider_confirmation) build/persist from the inventory. Absent ⇒ the executor
   * re-reads the repo config (deprecated fallback).
   */
  sessionConfig?: SessionConfig;
}

// The single cross-process mutex node for BUNDLE MUTATION (multi-agent
// cooperative runs, spec/multi-ide-concurrent-runs-design.md). A deterministic
// bundle-mutating executor is claimed here so exactly one peer runs it while
// others cooperative-wait; the claim is heartbeated so it survives an executor
// that outruns the file-lock's stale window. Audit's obligation frontier is
// singular, so one bundle mutation at a time is the correct invariant — the
// per-task parallelism is separate (task-pool claiming, slice 2).
const BUNDLE_MUTATION_NODE = "bundle-mutation";
// Heartbeat well inside STALE_LOCK_MS (30s) so a live long executor is never
// reclaimed; the executor's awaits (subprocess spawns, IO) free the event loop
// for the timer to fire.
const CLAIM_HEARTBEAT_MS = 10_000;

interface StepClassification {
  bundle: ArtifactBundle;
  selectedExecutor: string | null;
  selectedObligation: string | null;
  /** True iff the current step runs a deterministic bundle-mutating runner. */
  needsClaim: boolean;
}

// Deterministically classify the current step WITHOUT executing it — mirrors the
// executor/obligation selection advanceAudit does — so we can decide whether this
// invocation needs the exclusive bundle-mutation claim (a runner-backed step) or
// is the cheap host-delegation/no-op path.
function classifyStep(
  bundle: ArtifactBundle,
  options: RunAuditStepOptions,
): StepClassification {
  const decision = decideNextStep(bundle);
  const forcedExecutor = options.preferredExecutor ?? null;
  const selectedExecutor = forcedExecutor ?? decision.selected_executor;
  const selectedObligation = forcedExecutor
    ? `forced:${forcedExecutor}`
    : decision.selected_obligation;
  const needsClaim = Boolean(
    selectedExecutor && EXECUTOR_RUNNERS[selectedExecutor],
  );
  return { bundle, selectedExecutor, selectedObligation, needsClaim };
}

function nonPersistingResult(
  bundle: ArtifactBundle,
  classification: StepClassification,
  progressSummary: string,
): AdvanceAuditResult {
  const state = deriveAuditState(bundle);
  return {
    audit_state: state,
    selected_obligation: classification.selectedObligation,
    selected_executor: classification.selectedExecutor,
    progress_made: false,
    artifacts_written: [],
    progress_summary: progressSummary,
    next_likely_step: classification.selectedObligation,
    updated_bundle: bundle,
  };
}

export async function runAuditStep(
  options: RunAuditStepOptions,
): Promise<AdvanceAuditResult> {
  const runLogger = new RunLogger(join(options.artifactsDir, "run.log.jsonl"), {
    enabled: options.runLog ?? true,
  });
  const lockPath = artifactTreeLockPath(options.artifactsDir);
  const registry = new ClaimRegistry(nodeClaimsPath(options.artifactsDir));

  // Probe (short lock) whether this step needs the exclusive bundle-mutation
  // claim. The host-delegation handoff / complete / no-runner cases keep the
  // original short-lock read-modify-write — they don't hold across a long
  // executor, so the file lock alone is sufficient and they do not exclusively
  // own the bundle (audit_tasks pooling is slice 2).
  const probe = await withFileLock(
    lockPath,
    async () => classifyStep(await loadArtifactBundle(options.artifactsDir), options),
    undefined,
    runLogger,
  );
  if (!probe.needsClaim) {
    return withFileLock(
      lockPath,
      () => runAuditStepLocked(options, runLogger),
      undefined,
      runLogger,
    );
  }

  // Bundle-mutating deterministic runner: claim the mutex (OD1 bounded backoff),
  // execute UNLOCKED under a heartbeat, then persist under a short lock with a
  // merge-time ownership re-validation (OD3 airtight gate).
  const claim = await claimWithBackoff(registry, BUNDLE_MUTATION_NODE, {
    poolId: `obligation:${probe.selectedObligation ?? "unknown"}`,
  });
  if (!claim.acquired) {
    return nonPersistingResult(
      probe.bundle,
      probe,
      `Another agent is currently working the audit (obligation '${probe.selectedObligation ?? "?"}', ` +
        `held by ${claim.heldBy.slice(0, 12)}…). No other work is claimable right now — retry shortly.`,
    );
  }
  const ownerToken = claim.ownerToken;
  try {
    // Re-load fresh UNDER the claim and re-classify: if the obligation advanced
    // to a no-runner / complete step while we waited for the claim, fall through
    // to the cheap short-lock path; otherwise execute the current runner step.
    const fresh = await withFileLock(
      lockPath,
      async () => classifyStep(await loadArtifactBundle(options.artifactsDir), options),
      undefined,
      runLogger,
    );
    if (!fresh.needsClaim) {
      return await withFileLock(
        lockPath,
        () => runAuditStepLocked(options, runLogger),
        undefined,
        runLogger,
      );
    }

    const result = await withClaimHeartbeat(
      registry,
      BUNDLE_MUTATION_NODE,
      ownerToken,
      { intervalMs: CLAIM_HEARTBEAT_MS },
      () => executeAdvance(options, fresh.bundle, runLogger),
    );

    const persisted = await withFileLock(
      lockPath,
      async () => {
        // OD3 layer 2: refuse the merge if a peer reclaimed our (stale) lease
        // while we executed. A superseded peer must never land a result.
        if (!(await registry.heartbeat(BUNDLE_MUTATION_NODE, ownerToken))) {
          return false;
        }
        await writeCoreArtifacts(options.artifactsDir, result.updated_bundle, {
          prune: true,
        });
        return true;
      },
      undefined,
      runLogger,
    );
    if (!persisted) {
      return nonPersistingResult(
        fresh.bundle,
        fresh,
        `This agent's claim on the audit was revoked by a peer (stale-lease reclaim) mid-step; ` +
          `result discarded without persisting — retry shortly.`,
      );
    }

    const archivedPendingResults = await maybeArchiveLegacyPendingResults(
      options.auditResultsPath,
    );
    if (archivedPendingResults) {
      result.progress_summary += ` Archived legacy staging file to ${archivedPendingResults}.`;
    }
    return result;
  } finally {
    await registry.release(BUNDLE_MUTATION_NODE, ownerToken);
  }
}

async function runAuditStepLocked(
  options: RunAuditStepOptions,
  runLogger: RunLogger,
): Promise<AdvanceAuditResult> {
  const bundle = await loadArtifactBundle(options.artifactsDir);
  const result = await executeAdvance(options, bundle, runLogger);
  // Prune: result.updated_bundle is the full accumulated bundle, so an artifact
  // an executor cleared to `undefined` must be removed from disk (not left to
  // reload as a stale "present" artifact). Safe only because this is the
  // authoritative per-step persist.
  await writeCoreArtifacts(options.artifactsDir, result.updated_bundle, {
    prune: true,
  });
  const archivedPendingResults = await maybeArchiveLegacyPendingResults(
    options.auditResultsPath,
  );
  if (archivedPendingResults) {
    result.progress_summary +=
      ` Archived legacy staging file to ${archivedPendingResults}.`;
  }
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
): Promise<AdvanceAuditResult> {
  const lineIndex = bundle.repo_manifest
    ? await buildLineIndex(options.root, bundle.repo_manifest)
    : undefined;
  const sizeIndex = bundle.repo_manifest
    ? sizeIndexFromManifest(bundle.repo_manifest)
    : undefined;
  if (looksLikeCliFlag(options.auditResultsPath)) {
    throw new Error(
      `Invalid audit results path '${options.auditResultsPath}'. This looks like a CLI flag rather than a file path.`,
    );
  }
  let auditResults = options.auditResultsPath
    ? await readJsonFile<unknown>(options.auditResultsPath)
    : undefined;
  if (auditResults !== undefined) {
    // Partition results whose task_id is no longer in the active manifest — e.g.
    // selective-deepening tasks pruned by a later re-plan. Only the RETAINED
    // (task-known) subset is validated below: an orphan cannot be validated
    // against a task that no longer exists, and would otherwise abort the whole
    // batch at the validation gate and strand every valid result. But O2's
    // RETAIN-UNASSIGNED invariant means an orphan is NEVER pruned from the
    // ledger — so the FULL set (retained + orphaned) still flows to advanceAudit,
    // where the append-only ledger keeps the orphan, just un-associated.
    const partition = partitionOrphanedAuditResults(
      auditResults,
      new Set((bundle.audit_tasks ?? []).map((task) => task.task_id)),
    );
    const resultsToValidate =
      partition && partition.orphanedTaskIds.length > 0
        ? partition.retained
        : auditResults;
    if (partition && partition.orphanedTaskIds.length > 0) {
      process.stderr.write(
        `audit-results ingestion: ${partition.orphanedTaskIds.length} result(s) whose task_id ` +
          `is not in the active manifest (orphaned by re-planning) retained in the ledger but skipped at the validation gate: ${partition.orphanedTaskIds.join(", ")}\n`,
      );
    }
    const issues = validateAuditResults(resultsToValidate, bundle.audit_tasks ?? [], {
      lineIndex,
    });
    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");

    if (warnings.length > 0) {
      // Cap the per-warning detail so a run with many out-of-scope-evidence
      // warnings (each listing the task's full assigned-file set) doesn't bury
      // the rest of the output. The count is exact; the detail is a sample.
      const WARNING_DETAIL_CAP = 10;
      const moreSuffix =
        warnings.length > WARNING_DETAIL_CAP
          ? `\n  ... (+${warnings.length - WARNING_DETAIL_CAP} more warning(s) suppressed)`
          : "";
      process.stderr.write(
        `[${new Date().toISOString()}] audit-results validation (artifacts: ${options.artifactsDir}): ${warnings.length} warning(s):\n` +
          formatAuditResultIssues(warnings.slice(0, WARNING_DETAIL_CAP)) +
          moreSuffix +
          "\n",
      );
    }

    if (errors.length > 0) {
      throw new Error(formatAuditResultValidationError(errors));
    }
  }
  const runtimeValidationUpdates = options.runtimeUpdatesPath
    ? await readJsonFile<RuntimeValidationReport>(options.runtimeUpdatesPath)
    : undefined;
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
  const charterSubmission = options.charterSubmissionPath
    ? CharterSubmissionSchema.parse(
        await readJsonFile<unknown>(options.charterSubmissionPath),
      )
    : undefined;
  const charterDeltaSubmission = options.charterDeltaSubmissionPath
    ? CharterDeltaSubmissionSchema.parse(
        await readJsonFile<unknown>(options.charterDeltaSubmissionPath),
      )
    : undefined;
  const clarificationAnswers = options.clarificationAnswersPath
    ? ClarificationAnswersSubmissionSchema.parse(
        await readJsonFile<unknown>(options.clarificationAnswersPath),
      )
    : undefined;
  const systemicChallenge = options.systemicChallengePath
    ? SystemicChallengeSubmissionSchema.parse(
        await readJsonFile<unknown>(options.systemicChallengePath),
      )
    : undefined;
  const edgeReasoningResults = options.edgeReasoningResultsPath
    ? await readJsonFile<EdgeReasoningResults>(options.edgeReasoningResultsPath)
    : undefined;

  const result = await advanceAudit(bundle, {
    root: options.root,
    artifactsDir: options.artifactsDir,
    lineIndex,
    sizeIndex,
    auditResults: auditResults as AuditResult[] | undefined,
    runtimeValidationUpdates,
    externalAnalyzerResults,
    narrativeResults,
    criticalFlowFallbackResults,
    charterSubmission,
    charterDeltaSubmission,
    clarificationAnswers,
    systemicChallenge,
    edgeReasoningResults,
    analyzers: options.analyzers,
    graphLlmEdgeReasoning: options.graphLlmEdgeReasoning,
    externalAcquisition: options.externalAcquisition,
    since: options.since,
    preferredExecutor: options.preferredExecutor,
    sessionConfig: options.sessionConfig,
    runLogger,
  });

  return result;
}

export async function ingestBatchAuditResults(options: {
  root: string;
  artifactsDir: string;
  batchDir: string;
}) {
  const batchFiles = await listBatchResultFiles(options.batchDir);
  const artifactsWritten = new Set<string>();
  const progressSummaries: string[] = [];
  let lastStep:
    | Awaited<ReturnType<typeof runAuditStep>>
    | null = null;
  let anyProgress = false;

  for (const batchFile of batchFiles) {
    const step = await runAuditStep({
      root: options.root,
      artifactsDir: options.artifactsDir,
      preferredExecutor: "result_ingestion_executor",
      auditResultsPath: batchFile,
    });
    lastStep = step;
    anyProgress ||= step.progress_made;
    for (const artifact of step.artifacts_written) {
      artifactsWritten.add(artifact);
    }
    progressSummaries.push(`${basename(batchFile)}: ${step.progress_summary}`);
  }

  const bundle =
    lastStep?.updated_bundle ??
    (await loadArtifactBundle(options.artifactsDir));
  const state = deriveAuditState(bundle);
  const decision = decideNextStep(bundle);

  return {
    batchFiles,
    bundle,
    audit_state: state,
    selected_obligation:
      lastStep?.selected_obligation ?? decision.selected_obligation,
    selected_executor:
      lastStep?.selected_executor ?? "result_ingestion_executor",
    progress_made: anyProgress,
    artifacts_written: Array.from(artifactsWritten),
    progress_summary:
      `Imported ${batchFiles.length} batch result file${batchFiles.length === 1 ? "" : "s"} from ${options.batchDir}.` +
      (progressSummaries.length > 0
        ? `\n${progressSummaries.join("\n")}`
        : ""),
    next_likely_step:
      state.status === "complete" ? null : decision.selected_obligation,
  };
}
