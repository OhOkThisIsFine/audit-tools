import { basename, join } from "node:path";
import {
  artifactTreeLockPath,
  createMemoizedSourceReader,
  readJsonFile,
  RunLogger,
  verifyFindingGrounding,
  withFileLock,
  CharterSubmissionSchema,
  CharterDeltaSubmissionSchema,
  ClarificationAnswersSubmissionSchema,
  SystemicChallengeSubmissionSchema,
} from "audit-tools/shared";
import {
  loadArtifactBundle,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import { advanceAudit } from "../orchestrator/advance.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import { deriveAuditState } from "../orchestrator/state.js";
import type { AdvanceAuditResult } from "../orchestrator/advanceTypes.js";
import type { ArtifactBundle } from "../io/artifacts.js";
import { IntentEquivalenceVerdictSchema } from "../orchestrator/intentEquivalenceExecutor.js";
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
import type { AnalyzerSetting, Finding, SynthesisNarrative, CriticalFlowFallbackResult } from "audit-tools/shared";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type { ExternalAcquisitionAdvanceOptions } from "../orchestrator/acquisitionExecutor.js";

export interface RunAuditStepOptions {
  root: string;
  artifactsDir: string;
  preferredExecutor?: string;
  auditResultsPath?: string;
  /**
   * Already-validated host-handoff results. This is the in-process counterpart
   * to `auditResultsPath`: the zero-adapter host boundary validates and binds
   * each untrusted result before handing the normalized AuditResult objects to
   * the ordinary result-ingestion executor.
   */
  auditResultsData?: AuditResult[];
  runtimeUpdatesPath?: string;
  /** Provide a file path OR an already-parsed object; path is only read when the object is absent. */
  externalAnalyzerPath?: string;
  externalAnalyzerData?: ExternalAnalyzerResults;
  narrativeResultsPath?: string;
  criticalFlowFallbackResultsPath?: string;
  intentEquivalenceVerdictPath?: string;
  charterSubmissionPath?: string;
  charterDeltaSubmissionPath?: string;
  clarificationAnswersPath?: string;
  systemicChallengePath?: string;
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
}

export async function runAuditStep(
  options: RunAuditStepOptions,
): Promise<AdvanceAuditResult> {
  const runLogger = new RunLogger(join(options.artifactsDir, "run.log.jsonl"), {
    enabled: options.runLog ?? true,
  });
  const lockPath = artifactTreeLockPath(options.artifactsDir);
  // Deterministic bundle mutation is one heartbeat-protected critical section.
  // Host semantic review never runs here: it is emitted as a workload and this
  // lock only covers local artifact derivation and result ingestion.
  return await withFileLock(
    lockPath,
    () => runAuditStepLocked(options, runLogger),
    undefined,
    runLogger,
  );
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
  options: RunAuditStepOptions,
  bundle: ArtifactBundle,
  runLogger?: RunLogger,
): Promise<AdvanceAuditResult> {
  const logger =
    runLogger ??
    new RunLogger(join(options.artifactsDir, "run.log.jsonl"), {
      enabled: options.runLog ?? true,
    });
  return await executeAdvance(options, bundle, logger);
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
  if (options.auditResultsPath !== undefined && options.auditResultsData !== undefined) {
    throw new Error("Provide either auditResultsPath or auditResultsData, not both.");
  }
  let auditResults: unknown =
    options.auditResultsData ??
    (options.auditResultsPath
      ? await readJsonFile<unknown>(options.auditResultsPath)
      : undefined);
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
  const intentEquivalenceVerdict = options.intentEquivalenceVerdictPath
    ? IntentEquivalenceVerdictSchema.parse(
        await readJsonFile<unknown>(options.intentEquivalenceVerdictPath),
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
    intentEquivalenceVerdict,
    charterSubmission,
    charterDeltaSubmission,
    clarificationAnswers,
    systemicChallenge,
    edgeReasoningResults: options.edgeReasoningResults,
    analyzers: options.analyzers,
    graphLlmEdgeReasoning: options.graphLlmEdgeReasoning,
    externalAcquisition: options.externalAcquisition,
    since: options.since,
    preferredExecutor: options.preferredExecutor,
    runLogger,
  });

  return result;
}

/**
 * The CLI batch lane's half of the S7 grounding contract (docs-16): overwrite
 * every finding's `grounding` with the TOOL's own re-check before the payload
 * reaches validation or the ledger.
 *
 * OVERWRITE, not refuse: unlike the host-handoff boundary — whose worker
 * submissions are raw and where a supplied verdict is rejected outright — this
 * lane also carries results a previous ingest already grounded, so a refusal
 * would reject legitimate re-imports. Recomputing is idempotent on those and
 * strips a self-reported verdict from the rest. Runs BEFORE `validateAuditResults`
 * and shape-guards its own traversal, so a malformed payload still fails at the
 * validation gate with its normal message instead of throwing here.
 *
 * Exported so the contract is tested against THIS mechanism directly: the only
 * alternative seam is the multi-minute end-to-end batch-ingest fixture, and a
 * test that cannot reach the code it names is not a guard.
 */
export async function stampToolComputedGrounding(
  root: string,
  results: readonly unknown[],
): Promise<void> {
  const readSource = createMemoizedSourceReader();
  for (const result of results) {
    if (typeof result !== "object" || result === null) continue;
    const findings = (result as { findings?: unknown }).findings;
    if (!Array.isArray(findings)) continue;
    for (const finding of findings) {
      if (typeof finding !== "object" || finding === null) continue;
      const typed = finding as Finding;
      typed.grounding = await verifyFindingGrounding(root, typed, readSource);
    }
  }
}

export async function ingestBatchAuditResults(options: {
  root: string;
  artifactsDir: string;
  batchDir: string;
}) {
  const batchFiles = await listBatchResultFiles(options.batchDir);
  // A batch directory is one host submission boundary. Ingest every canonical
  // file atomically so partial files cannot trigger selective-deepening/requeue
  // derivation between siblings and manufacture new pending review tasks before
  // the rest of the same batch is visible.
  const payloads = await Promise.all(
    batchFiles.map((batchFile) => readJsonFile<unknown>(batchFile)),
  );
  const auditResultsData = payloads.flatMap((payload) =>
    Array.isArray(payload) ? payload : [payload],
  ) as AuditResult[];
  await stampToolComputedGrounding(options.root, auditResultsData);
  const step = batchFiles.length > 0
    ? await runAuditStep({
        root: options.root,
        artifactsDir: options.artifactsDir,
        preferredExecutor: "result_ingestion_executor",
        auditResultsData,
      })
    : null;

  const bundle =
    step?.updated_bundle ??
    (await loadArtifactBundle(options.artifactsDir));
  const state = deriveAuditState(bundle);
  const decision = decideNextStep(bundle);

  return {
    batchFiles,
    bundle,
    audit_state: state,
    selected_obligation:
      step?.selected_obligation ?? decision.selected_obligation,
    selected_executor:
      step?.selected_executor ?? "result_ingestion_executor",
    progress_made: step?.progress_made ?? false,
    artifacts_written: step?.artifacts_written ?? [],
    progress_summary:
      `Imported ${batchFiles.length} batch result file${batchFiles.length === 1 ? "" : "s"} from ${options.batchDir}.` +
      (step
        ? `\n${batchFiles.map((file) => basename(file)).join(", ")}: ${step.progress_summary}`
        : ""),
    next_likely_step:
      state.status === "complete" ? null : decision.selected_obligation,
  };
}
