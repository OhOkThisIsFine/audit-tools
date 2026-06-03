import { readJsonFile, writeJsonFile } from "@audit-tools/shared";
import type { AuditResult, AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { WorkerResult } from "../types/workerResult.js";
import { validateAuditResults, formatAuditResultIssues } from "../validation/auditResults.js";
import { runAuditStep } from "./auditStep.js";
import { buildLineIndexForPaths } from "./lineIndex.js";
import { WORKER_RESULT_CONTRACT_VERSION, formatAuditResultValidationError } from "./workerResult.js";
import { getFlag, looksLikeCliFlag } from "./args.js";

export async function cmdWorkerRun(argv: string[]): Promise<void> {
  const taskPath = getFlag(argv, "--task");
  if (!taskPath) {
    throw new Error("worker-run requires --task <path>");
  }
  const task = await readJsonFile<WorkerTask>(taskPath);

  let workerResult: WorkerResult;
  try {
    if (looksLikeCliFlag(task.audit_results_path)) {
      throw new Error(
        `task.audit_results_path resolved to '${task.audit_results_path}', which looks like a CLI flag instead of a file path.`,
      );
    }
    if (task.preferred_executor === "agent" && !task.audit_results_path) {
      throw new Error(
        "agent worker-run requires audit_results_path so provider-assisted review can be ingested.",
      );
    }
    if (task.preferred_executor === "agent" && task.audit_results_path) {
      const pendingTasks = task.pending_audit_tasks_path
        ? await readJsonFile<AuditTask[]>(task.pending_audit_tasks_path)
        : [];
      const auditResults = await readJsonFile<AuditResult[]>(
        task.audit_results_path,
      );
      const pendingTaskIds = new Set(pendingTasks.map((item) => item.task_id));
      const matchedResultCount = auditResults.filter((result) =>
        pendingTaskIds.has(result.task_id),
      ).length;
      if (pendingTasks.length > 0 && matchedResultCount === 0) {
        throw new Error(
          "Provider-assisted review did not emit any audit results for the pending audit tasks.",
        );
      }

      const issues = validateAuditResults(auditResults, pendingTasks, {
        lineIndex: await buildLineIndexForPaths(
          task.repo_root,
          pendingTasks.flatMap((item) => item.file_paths),
        ),
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
    const preferredExecutor =
      task.preferred_executor === "agent"
        ? "result_ingestion_executor"
        : task.preferred_executor;
    const result = await runAuditStep({
      root: task.repo_root,
      artifactsDir: task.artifacts_dir,
      preferredExecutor,
      auditResultsPath: task.audit_results_path,
      runtimeUpdatesPath: task.runtime_updates_path,
      externalAnalyzerPath: task.external_analyzer_results_path,
    });
    workerResult = {
      contract_version: WORKER_RESULT_CONTRACT_VERSION,
      run_id: task.run_id,
      obligation_id: task.obligation_id,
      status: result.progress_made ? "completed" : "no_progress",
      progress_made: result.progress_made,
      selected_executor: result.selected_executor,
      artifacts_written: result.artifacts_written,
      summary: result.progress_summary,
      next_likely_step: result.next_likely_step,
      errors: [],
    };
  } catch (error) {
    workerResult = {
      contract_version: WORKER_RESULT_CONTRACT_VERSION,
      run_id: task.run_id,
      obligation_id: task.obligation_id,
      status: "failed",
      progress_made: false,
      selected_executor: task.preferred_executor,
      artifacts_written: [],
      summary: `Worker failed for executor ${task.preferred_executor}: ${error instanceof Error ? error.message : String(error)}`,
      next_likely_step: task.obligation_id,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  await writeJsonFile(task.result_path, workerResult);
  console.log(JSON.stringify(workerResult, null, 2));
  if (workerResult.status === "failed") {
    process.exitCode = 1;
  }
}
