import { join } from "node:path";
import { isFileMissingError, readJsonFile } from "audit-tools/shared";
import type { AuditTask } from "../types.js";
import type { AuditState } from "../types/auditState.js";
import { getArtifactsDir } from "./args.js";
import { outputJson } from "./cliHelpers.js";
import { loadCurrentActiveReviewRun } from "./reviewRun.js";

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
    outputJson({ status: 'no_active_audit', error: 'No audit_state.json found; no active audit in this artifacts directory.' });
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

  // 2. Read the ACTIVE run's pending-audit-tasks.json
  //
  // The active run is the one the loop is on, named by the review-run manifest
  // the pause wrote — never "the newest directory under runs/". That inference
  // sorted the directory NAMES, which only meant "newest" while a run id began
  // with a UTC timestamp: with the derived id (obligation slug + digest) the
  // sort is alphabetical, so the command would report an arbitrary obligation's
  // pending count and call it current.
  //
  // Both reads degrade to "no run" rather than to a stack. A malformed
  // manifest, an unreadable manifest and an absent manifest all say the same
  // true thing about the ACTIVE run: `status` does not know of one. A status
  // command that throws tells an operator nothing it could have reported.
  let pendingTasksSummary: {
    run_id: string;
    total: number;
    remaining: number;
  } | null = null;

  try {
    const activeRun = await loadCurrentActiveReviewRun(artifactsDir);
    if (activeRun) {
      const tasks = await readJsonFile<AuditTask[]>(
        activeRun.pending_audit_tasks_path,
      );
      if (Array.isArray(tasks)) {
        // Count remaining: tasks without status "complete"
        const total = tasks.length;
        const remaining = tasks.filter(
          (t) => t.status !== "complete",
        ).length;

        pendingTasksSummary = {
          run_id: activeRun.run_id,
          total,
          remaining,
        };
      }
    }
  } catch {
    // Malformed / unreadable active-run manifest: report "no run", never throw.
  }

  outputJson({
    artifacts_dir: artifactsDir,
    status: auditState.status,
    last_obligation: auditState.last_obligation ?? null,
    last_executor: auditState.last_executor ?? null,
    blockers: auditState.blockers ?? [],
    obligations_summary: obligationStates,
    pending_tasks: pendingTasksSummary,
  });
}
