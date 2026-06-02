import { rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readJsonFile, RunLogger } from "@audit-tools/shared";
import {
  loadArtifactBundle,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import { advanceAudit } from "../orchestrator/advance.js";
import { deriveAuditState } from "../orchestrator/state.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import type { EdgeReasoningResults } from "../orchestrator/edgeReasoning.js";
import { sizeIndexFromManifest } from "../orchestrator/reviewPackets.js";
import {
  validateAuditResults,
  formatAuditResultIssues,
} from "../validation/auditResults.js";
import { formatAuditResultValidationError } from "./workerResult.js";
import { looksLikeCliFlag, listBatchResultFiles } from "./args.js";
import { buildLineIndex } from "./lineIndex.js";
import type { AuditResult } from "../types.js";
import type { AnalyzerSetting, SynthesisNarrative } from "@audit-tools/shared";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";

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
    await rename(auditResultsPath, archivedPath);
    return archivedPath;
  } catch (error) {
    process.stderr.write(
      `[audit-results cleanup] failed to archive ${auditResultsPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

export async function runAuditStep(options: {
  root: string;
  artifactsDir: string;
  preferredExecutor?: string;
  auditResultsPath?: string;
  runtimeUpdatesPath?: string;
  externalAnalyzerPath?: string;
  narrativeResultsPath?: string;
  edgeReasoningResultsPath?: string;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  since?: string;
  opentoken?: boolean;
  runLog?: boolean;
}) {
  const bundle = await loadArtifactBundle(options.artifactsDir);
  const runLogger = new RunLogger(join(options.artifactsDir, "run.log.jsonl"), {
    enabled: options.runLog ?? true,
  });
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
  const auditResults = options.auditResultsPath
    ? await readJsonFile<unknown>(options.auditResultsPath)
    : undefined;
  if (auditResults !== undefined) {
    const issues = validateAuditResults(auditResults, bundle.audit_tasks ?? [], {
      lineIndex,
    });
    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");

    if (warnings.length > 0) {
      process.stderr.write(
        `audit-results validation: ${warnings.length} warning(s):\n` +
          formatAuditResultIssues(warnings) +
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
  const externalAnalyzerResults = options.externalAnalyzerPath
    ? await readJsonFile<ExternalAnalyzerResults>(options.externalAnalyzerPath)
    : undefined;
  const narrativeResults = options.narrativeResultsPath
    ? await readJsonFile<SynthesisNarrative>(options.narrativeResultsPath)
    : undefined;
  const edgeReasoningResults = options.edgeReasoningResultsPath
    ? await readJsonFile<EdgeReasoningResults>(options.edgeReasoningResultsPath)
    : undefined;

  const result = await advanceAudit(bundle, {
    root: options.root,
    lineIndex,
    sizeIndex,
    auditResults: auditResults as AuditResult[] | undefined,
    runtimeValidationUpdates,
    externalAnalyzerResults,
    narrativeResults,
    edgeReasoningResults,
    analyzers: options.analyzers,
    graphLlmEdgeReasoning: options.graphLlmEdgeReasoning,
    since: options.since,
    preferredExecutor: options.preferredExecutor,
    opentoken: options.opentoken,
    runLogger,
  });

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
