import { mkdir } from "node:fs/promises";
import { promoteFinalAuditReport } from "../io/artifacts.js";
import { clearDispatchFiles, ensureSupervisorDirs } from "../io/runArtifacts.js";
import type { SessionConfig } from "@audit-tools/shared";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { resolveRunProviderName, getArtifactsDir, getRootDir, warnIfNotGitRepo, getBatchResultsDir, getFlag } from "./args.js";
import { runAuditStep, ingestBatchAuditResults } from "./auditStep.js";
import { emitEnvelope } from "./envelope.js";
import { persistConfigErrorHandoff } from "./reviewRun.js";
import { cleanupStaleArtifactsDir } from "./cleanup.js";

export async function cmdAdvanceAudit(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  await cleanupStaleArtifactsDir(artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  await ensureSupervisorDirs(artifactsDir);
  let sessionConfig: SessionConfig;
  try {
    sessionConfig = await loadSessionConfig(artifactsDir);
  } catch (error) {
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const providerName = resolveRunProviderName(argv, sessionConfig);
  const batchResultsDir = getBatchResultsDir(argv);
  if (batchResultsDir && getFlag(argv, "--results")) {
    throw new Error("Use either --results <file> or --batch-results <dir>, not both.");
  }
  if (batchResultsDir) {
    const result = await ingestBatchAuditResults({
      root,
      artifactsDir,
      batchDir: batchResultsDir,
    });
    if (result.selected_executor !== "agent") {
      await clearDispatchFiles(artifactsDir);
    }
    await emitEnvelope({
      root,
      artifactsDir,
      bundle: result.bundle,
      audit_state: result.audit_state,
      selected_obligation: result.selected_obligation,
      selected_executor: result.selected_executor,
      progress_made: result.progress_made,
      artifacts_written: result.artifacts_written,
      progress_summary: result.progress_summary,
      next_likely_step: result.next_likely_step,
      providerName,
    });
    if (result.audit_state.status === "complete") {
      await promoteFinalAuditReport({ artifactsDir });
    }
    return;
  }
  const externalAnalyzerPath = getFlag(argv, "--external-analyzer-results");
  const result = await runAuditStep({
    root,
    artifactsDir,
    preferredExecutor:
      getFlag(argv, "--preferred-executor") ??
      (externalAnalyzerPath ? "external_analyzer_import_executor" : undefined),
    auditResultsPath: getFlag(argv, "--results"),
    runtimeUpdatesPath: getFlag(argv, "--updates"),
    externalAnalyzerPath,
    analyzers: sessionConfig.analyzers,
    graphLlmEdgeReasoning: sessionConfig.graph?.llm_edge_reasoning,
    since: getFlag(argv, "--since"),
    opentoken: sessionConfig.opentoken?.enabled,
    runLog: sessionConfig.observability?.run_log,
  });
  if (result.selected_executor !== "agent") {
    await clearDispatchFiles(artifactsDir);
  }
  await emitEnvelope({
    root,
    artifactsDir,
    bundle: result.updated_bundle,
    audit_state: result.audit_state,
    selected_obligation: result.selected_obligation,
    selected_executor: result.selected_executor,
    progress_made: result.progress_made,
    artifacts_written: result.artifacts_written,
    progress_summary: result.progress_summary,
    next_likely_step: result.next_likely_step,
    providerName,
  });
  if (result.audit_state.status === "complete") {
    await promoteFinalAuditReport({ artifactsDir });
  }
}
