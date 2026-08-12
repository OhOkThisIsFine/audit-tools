import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile } from "audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import {
  CURRENT_TASK_FILENAME,
  CURRENT_TASKS_FILENAME,
} from "../supervisor/operatorHandoff.js";
import { canonicalizeAuditTasks } from "../../shared/affinityArtifacts.js";
import type { RunPaths } from "./runArtifactTypes.js";

export type { RunPaths } from "./runArtifactTypes.js";

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0");
}

function formatRunTimestamp(value: Date): string {
  return [
    pad(value.getUTCFullYear(), 4),
    pad(value.getUTCMonth() + 1),
    pad(value.getUTCDate()),
    "T",
    pad(value.getUTCHours()),
    pad(value.getUTCMinutes()),
    pad(value.getUTCSeconds()),
    pad(value.getUTCMilliseconds(), 3),
    "Z",
  ].join("");
}

function normalizeRunIdSegment(value: string | null): string {
  const normalized = (value ?? "terminal")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "terminal";
}

export function buildRunId(
  obligationId: string | null,
  index: number,
  now: Date = new Date(),
): string {
  return `${formatRunTimestamp(now)}_${normalizeRunIdSegment(obligationId)}_${String(index).padStart(3, "0")}`;
}

export function getRunPaths(artifactsDir: string, runId: string): RunPaths {
  const runDir = join(artifactsDir, "runs", runId);
  return {
    runDir,
    reviewRunPath: join(runDir, "review-run.json"),
    pendingTasksPath: join(runDir, "pending-audit-tasks.json"),
    hostWorkloadPath: join(runDir, "host-workload.json"),
    hostResultMapPath: join(runDir, "host-result-map.json"),
  };
}

export async function ensureSupervisorDirs(artifactsDir: string): Promise<void> {
  await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
  await mkdir(join(artifactsDir, "runs"), { recursive: true });
}

/** Persist only review identity + pending work; the host owns all execution. */
export async function writeReviewRunFiles(
  artifactsDir: string,
  run: ActiveReviewRun,
  pendingTasks: readonly AuditTask[],
): Promise<void> {
  await mkdir(join(artifactsDir, "dispatch"), { recursive: true });
  await mkdir(join(artifactsDir, "runs", run.run_id), { recursive: true });
  const canonicalTasks = canonicalizeAuditTasks([...pendingTasks]);
  await writeJsonFile(run.review_run_path, run);
  await writeJsonFile(run.pending_audit_tasks_path, canonicalTasks);
  await writeJsonFile(
    join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME),
    run,
  );
  await writeJsonFile(
    join(artifactsDir, "dispatch", CURRENT_TASKS_FILENAME),
    canonicalTasks,
  );
}
