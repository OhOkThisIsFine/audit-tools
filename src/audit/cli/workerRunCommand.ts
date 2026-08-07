import { readJsonFile, writeJsonFile } from "audit-tools/shared";
import type { AuditResult, AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { WorkerResult } from "../types/workerResult.js";
import { validateAuditResults, formatAuditResultIssues, emitCoverageLineCountFriction } from "../validation/auditResults.js";
import { runAuditStep } from "./auditStep.js";
import { buildLineIndexForPaths } from "./lineIndex.js";
import { WORKER_RESULT_CONTRACT_VERSION, formatAuditResultValidationError } from "./workerResult.js";
import { getFlag, looksLikeCliFlag } from "./args.js";

/**
 * Injectable IO + step seam for cmdWorkerRun. Production uses the real
 * audit-tools/shared helpers and runAuditStep; tests override individual
 * members to drive failure paths (e.g. a writeJsonFile that throws on the
 * first call and succeeds on the fallback) without module-level mocking,
 * which the project's `node --import tsx/esm --test` runner cannot do.
 */
export interface WorkerRunDeps {
  readJsonFile: typeof readJsonFile;
  writeJsonFile: typeof writeJsonFile;
  runAuditStep: typeof runAuditStep;
}

const defaultWorkerRunDeps: WorkerRunDeps = {
  readJsonFile,
  writeJsonFile,
  runAuditStep,
};

export async function cmdWorkerRun(
  argv: string[],
  deps: WorkerRunDeps = defaultWorkerRunDeps,
): Promise<void> {
  const { readJsonFile, writeJsonFile, runAuditStep } = deps;
  const taskPath = getFlag(argv, "--task");
  if (!taskPath) {
    throw new Error("worker-run requires --task <path>");
  }
  // Result path can be provided explicitly, or will be read from task
  const resultPathOverride = getFlag(argv, "--result");

  let task: WorkerTask | undefined;
  let workerResult: WorkerResult;
  try {
    task = await readJsonFile<WorkerTask>(taskPath);
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
      const errors: typeof issues = [];
      const warnings: typeof issues = [];
      for (const issue of issues) {
        if (issue.severity === "error") {
          errors.push(issue);
        } else {
          warnings.push(issue);
        }
      }

      if (warnings.length > 0) {
        process.stderr.write(
          `audit-results validation: ${warnings.length} warning(s):\n` +
            formatAuditResultIssues(warnings) +
            "\n",
        );
        // Route the deliberately-downgraded total_lines!=actual coverage
        // mismatch through the single shared friction chokepoint at this ingest
        // locus (the validator stays pure and only RETURNS the 'warning'). Same
        // policy as merge-and-ingest — single-sourced so the two cannot drift.
        if (task.run_id && task.artifacts_dir) {
          await emitCoverageLineCountFriction(
            task.artifacts_dir,
            task.run_id,
            warnings,
          );
        }
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
      run_id: task?.run_id ?? "",
      obligation_id: task?.obligation_id ?? null,
      status: "failed",
      progress_made: false,
      selected_executor: task?.preferred_executor ?? null,
      artifacts_written: [],
      summary: `Worker failed: ${error instanceof Error ? error.message : String(error)}`,
      next_likely_step: task?.obligation_id ?? null,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  // Determine result path: use override if provided, otherwise use task.result_path.
  // With NEITHER available (task unreadable, no --result), the failed WorkerResult
  // is still emitted on stdout — a constructed failure record must never be
  // silently discarded; the supervisor can at least see it in the captured output.
  const resultPath = resultPathOverride ?? task?.result_path;
  if (!resultPath) {
    process.stderr.write(
      `[workerRunCommand] Cannot determine result path: --result not provided and task file could not be read\n`,
    );
    console.log(JSON.stringify(workerResult, null, 2));
    process.exitCode = 1;
    return;
  }

  try {
    await writeJsonFile(resultPath, workerResult);
  } catch (writeError) {
    const writeFailedResult: WorkerResult = {
      contract_version: WORKER_RESULT_CONTRACT_VERSION,
      run_id: task?.run_id ?? "",
      obligation_id: task?.obligation_id ?? null,
      status: "failed",
      progress_made: false,
      selected_executor: task?.preferred_executor ?? null,
      artifacts_written: [],
      summary: `Worker result could not be persisted to ${resultPath}: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
      next_likely_step: task?.obligation_id ?? null,
      errors: [writeError instanceof Error ? writeError.message : String(writeError)],
    };
    process.stderr.write(
      `[workerRunCommand] Failed to write result to ${resultPath}: ${writeError instanceof Error ? writeError.message : String(writeError)}\n`,
    );
    // Best-effort second attempt with the degraded result. If this also fails,
    // rethrow so the caller sees a hard failure (COR-5332acdf).
    try {
      await writeJsonFile(resultPath, writeFailedResult);
    } catch (fallbackError) {
      process.stderr.write(
        `[workerRunCommand] Fallback write also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`,
      );
      throw fallbackError;
    }
    console.log(JSON.stringify(writeFailedResult, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(workerResult, null, 2));
  if (workerResult.status === "failed") {
    process.exitCode = 1;
  }
}
