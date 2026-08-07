import {
  artifactTreeLockPath,
  resolveSessionConfig,
  withFileLock,
} from "audit-tools/shared";
import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getRootDir } from "./args.js";
import { loadArtifactBundle, type ArtifactBundle } from "../io/artifacts.js";
import { recordOperatorForcedTerminalState } from "./dispatch/pausePersist.js";
import { selectCurrentResults } from "../orchestrator/ledger.js";
import { computeStaleResultTaskIds } from "../orchestrator/resultBaseline.js";
import { getAuditorDescriptor } from "./args.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { resolveCurrentWorkPartitionRuntime } from "./workPartitionRuntime.js";

/**
 * The operator recovery escape for a run wedged on audit tasks that can never
 * complete (e.g. orphaned `deepening:*` tasks whose ids no longer match any
 * dispatchable packet). It stamps a tool-owned `operator_forced`
 * partial-completion terminal over the pending task ids and drives the synthesis
 * executor, producing `audit-findings.json` / `audit-report.md` from the INTACT
 * `audit_results.jsonl` ledger on partial coverage — WITHOUT hand-editing
 * gitignored run-state (which the state machine ignores/overwrites and which
 * cascades stale `planning_artifacts`; see docs/backlog.md "selective-deepening
 * convergence" trap).
 *
 * Durability: the terminal is written directly to `active-dispatch.json` (a
 * special-loaded artifact NOT owned by `writeCoreArtifacts`, so a later
 * `next-step` re-loads it and treats the stranded tasks as uncovered rather than
 * re-blocking `audit_tasks_completed`). Metadata is resynced for free — the
 * synthesis step's `advanceAudit` recomputes `artifact_metadata` over the
 * artifacts it writes.
 */
export async function cmdForceSynthesis(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  const artifactsDir = getArtifactsDir(argv);
  const descriptor = getAuditorDescriptor(argv);
  const sessionConfig = resolveSessionConfig(
    await loadSessionConfig(artifactsDir),
    descriptor,
  );
  const workPartition = resolveCurrentWorkPartitionRuntime(
    sessionConfig,
    descriptor?.self ?? {},
  ) ?? undefined;

  // Stamp the terminal under the artifact-tree lock, then RELEASE it before
  // runAuditStep (which re-acquires the same non-reentrant lock — a nested
  // acquire would self-deadlock). The stamp itself rides the active-dispatch
  // locked store (tree lock outer, dispatch lock inner — the one sanctioned
  // ordering), which unions stranded ids with any concurrently-stamped
  // terminal and clears paused_state in the same write.
  const stamp = await withFileLock(artifactTreeLockPath(artifactsDir), async () => {
    const bundle = await loadArtifactBundle(artifactsDir);
    const { strandedIds, newlyStranded } = computeForcedStrandedTaskIds(bundle);
    if (newlyStranded === 0 && strandedIds.length === 0) {
      // Nothing pending → no terminal needed; synthesis runs from the ledger as-is.
      return { strandedIds, newlyStranded };
    }
    await recordOperatorForcedTerminalState(artifactsDir, strandedIds);
    return { strandedIds, newlyStranded };
  });

  const result = await runAuditStep({
    root,
    artifactsDir,
    preferredExecutor: "synthesis_executor",
    sessionConfig,
    workPartition,
  });

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        forced_stranded_task_ids: stamp.strandedIds,
        newly_stranded_count: stamp.newlyStranded,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
      },
      null,
      2,
    ),
  );
}

/**
 * The task ids the completion gate (`deriveAuditState`) still treats as pending
 * — a task whose CURRENT (supersession-resolved) result is missing/stale, that is
 * not already budget-deferred and not already stranded by a prior terminal. This
 * mirrors `deriveAuditState`'s `hasPendingAuditTasks` predicate so
 * `force-synthesis` strands exactly the set that would otherwise re-block the
 * loop. Returns the FULL stranded set (prior ∪ newly pending) plus the count of
 * newly-added ids.
 */
function computeForcedStrandedTaskIds(bundle: ArtifactBundle): {
  strandedIds: string[];
  newlyStranded: number;
} {
  const tasks = bundle.audit_tasks ?? [];
  const currentResults = selectCurrentResults(bundle.audit_results ?? []);
  const staleResultTaskIds = computeStaleResultTaskIds(
    currentResults,
    tasks,
    bundle.artifact_metadata?.result_baselines,
  );
  const completedTaskIds = new Set(
    currentResults
      .map((result) => result.task_id)
      .filter((taskId) => !staleResultTaskIds.has(taskId)),
  );
  const deferred = new Set<string>(bundle.active_dispatch?.deferred_task_ids ?? []);
  const alreadyStranded = new Set<string>(
    bundle.active_dispatch?.partial_completion_terminal?.stranded_ids ?? [],
  );
  const pending = tasks
    .filter(
      (task) =>
        (staleResultTaskIds.has(task.task_id) ||
          (task.status !== "complete" && !completedTaskIds.has(task.task_id))) &&
        !deferred.has(task.task_id) &&
        !alreadyStranded.has(task.task_id),
    )
    .map((task) => task.task_id);
  const strandedIds = [...new Set([...alreadyStranded, ...pending])];
  return { strandedIds, newlyStranded: pending.length };
}

