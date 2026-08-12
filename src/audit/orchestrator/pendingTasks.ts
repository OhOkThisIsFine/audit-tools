import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditTask } from "../types.js";
import { selectCurrentResults } from "./ledger.js";
import { computeStaleResultTaskIds } from "./resultBaseline.js";
import { canonicalizeAuditTasks } from "../../shared/affinityArtifacts.js";

/**
 * The single pending-set derivation (INV-PENDING-SINGLE-SOURCE): host workload
 * construction and the completion gate (`deriveAuditState`'s
 * `audit_tasks_completed` obligation) both consume THIS partition, so the two
 * can never disagree on which tasks still need work.
 *
 * Semantics (the O3 staleness gate's consume half): results resolve to the
 * CURRENT record per lineage (`selectCurrentResults`), and a task whose current
 * result has DRIFTED from its recorded content-key baseline is pending again —
 * it must return for review even though its stale result left it status
 * `complete`. Consumers layer their own presentation ordering on top.
 */
export interface PendingTaskPartition {
  /** Tasks whose current result drifted from its baseline (must be reviewed again). */
  staleResultTaskIds: Set<string>;
  /** Tasks with a current, non-drifted result (genuinely done). */
  completedTaskIds: Set<string>;
  /** Tasks that still need work, in `bundle.audit_tasks` order. */
  pendingTasks: AuditTask[];
}

export function derivePendingTaskPartition(
  bundle: ArtifactBundle,
): PendingTaskPartition {
  const auditTasks = canonicalizeAuditTasks(bundle.audit_tasks ?? []);
  const currentResults = selectCurrentResults(bundle.audit_results ?? []);
  const staleResultTaskIds = computeStaleResultTaskIds(
    currentResults,
    auditTasks,
    bundle.artifact_metadata?.result_baselines,
  );
  const completedTaskIds = new Set(
    currentResults
      .map((result) => result.task_id)
      .filter((taskId) => !staleResultTaskIds.has(taskId)),
  );
  const pendingTasks = auditTasks.filter(
    (task) =>
      staleResultTaskIds.has(task.task_id) ||
      (task.status !== "complete" && !completedTaskIds.has(task.task_id)),
  );
  return { staleResultTaskIds, completedTaskIds, pendingTasks };
}
