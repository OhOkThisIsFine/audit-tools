import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isFileMissingError, readJsonFile } from "@audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { AuditState } from "../types/auditState.js";
import { loadRunLedger } from "../supervisor/runLedger.js";
import { getArtifactsDir } from "./args.js";

export async function cmdStatus(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const auditStatePath = join(artifactsDir, "audit_state.json");

  // 1. Read audit_state.json
  let auditState: AuditState | null = null;
  try {
    auditState = await readJsonFile<AuditState>(auditStatePath);
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  if (!auditState) {
    console.log(JSON.stringify({ status: 'no_active_audit', error: 'No audit_state.json found; no active audit in this artifacts directory.' }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Build obligations summary: count by state
  const obligationStates: Record<string, number> = {
    missing: 0,
    present: 0,
    stale: 0,
    blocked: 0,
    satisfied: 0,
  };
  for (const obligation of auditState.obligations ?? []) {
    const state = obligation.state;
    if (state in obligationStates) {
      obligationStates[state]!++;
    }
  }

  // 2. Read run ledger for last N entries
  const ledger = await loadRunLedger(artifactsDir);
  const RECENT_RUN_LIMIT = 5;
  const recentRuns = ledger.runs
    .slice(-RECENT_RUN_LIMIT)
    .reverse()
    .map((entry) => ({
      run_id: entry.run_id,
      obligation_id: entry.obligation_id,
      status: entry.status,
      started_at: entry.started_at,
    }));

  // 3. Find the most recent run directory and read pending-audit-tasks.json
  let pendingTasksSummary: {
    run_id: string;
    total: number;
    remaining: number;
  } | null = null;

  const runsDir = join(artifactsDir, "runs");
  let runDirs: string[] = [];
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    runDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    // runs directory may not exist yet
  }

  for (const runDirName of runDirs) {
    const runDir = join(runsDir, runDirName);
    const tasksPath = join(runDir, "pending-audit-tasks.json");
    let tasks: AuditTask[] | null = null;
    try {
      tasks = await readJsonFile<AuditTask[]>(tasksPath);
    } catch {
      continue; // no pending-audit-tasks.json in this run dir — try previous
    }
    if (!Array.isArray(tasks)) continue;

    // Count remaining: tasks without status "complete"
    const total = tasks.length;
    const remaining = tasks.filter(
      (t) => t.status !== "complete",
    ).length;

    pendingTasksSummary = {
      run_id: runDirName,
      total,
      remaining,
    };
    break;
  }

  // 4. Surface failed-tasks.json from the most recent run that has one
  let failedTasks: Array<{ task_id: string; errors: string[] }> | null = null;
  for (const runDirName of runDirs) {
    const failedTasksPath = join(runsDir, runDirName, "failed-tasks.json");
    try {
      const raw = await readJsonFile<Array<{ task_id: string; errors: string[] }>>(
        failedTasksPath,
      );
      if (Array.isArray(raw) && raw.length > 0) {
        failedTasks = raw;
        break;
      }
    } catch {
      // Not present in this run dir — keep looking
    }
  }

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        status: auditState.status,
        last_obligation: auditState.last_obligation ?? null,
        last_executor: auditState.last_executor ?? null,
        blockers: auditState.blockers ?? [],
        obligations_summary: obligationStates,
        recent_runs: recentRuns,
        pending_tasks: pendingTasksSummary,
        failed_tasks: failedTasks,
      },
      null,
      2,
    ),
  );
}
