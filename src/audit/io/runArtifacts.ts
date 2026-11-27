// sites-pinned: tests/audit-smoke.test.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
export interface RunPaths {
  runDir: string;
  reviewRunPath: string;
  pendingTasksPath: string;
  hostWorkloadPath: string;
  hostResultMapPath: string;
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
