import type { ArtifactBundle } from "../../io/artifacts.js";
import { derivePendingTaskPartition } from "../../orchestrator/pendingTasks.js";

/**
 * Return the canonical pending semantic-review frontier.
 *
 * This is intentionally a projection only. Grouping, backend fit, admission,
 * model selection, and launch policy belong to the host.
 */
export function buildPendingAuditTasks(bundle: ArtifactBundle) {
  return derivePendingTaskPartition(bundle).pendingTasks;
}
