/**
 * The requeue fold — ONE mechanism, two draws.
 *
 * Both the planning executor and the result-ingestion executor fold pending
 * requeue tasks into the persisted dispatch set so a mandatory coverage gap
 * becomes an actual host work item. They are the same operation over different
 * inputs (a freshly-initialized coverage matrix vs. the post-ingest one), so
 * they run the same selection here rather than each keeping its own.
 *
 * They did not, and the divergence was the defect: ingestion deduped by
 * `task_id` equality while requeue ids are minted as `requeue:<lens>:<path>`
 * (`requeue.ts`) and plan ids as `<unit>:<lens>` — two id grammars that can
 * never collide, so the filter was structurally a no-op and every uncovered
 * (path × required-lens) cell became its own single-file audit task on the
 * first ingest of a run. One live lap minted 2908 tasks where the correct
 * number was zero.
 */
import type { AuditTask } from "../types.js";
import { isUnmeasuredLineCount } from "../cli/lineIndex.js";

/**
 * The requeue fold's COVERAGE-based dedupe (INV-PLAN-PERSIST-COMPLETE half 1).
 * A pending requeue task duplicates existing work whenever some audit task with
 * the SAME lens already covers every one of its file paths — on a fresh plan the
 * requeue payload mirrors the entire pending coverage set under `requeue:*` ids,
 * so a task_id-only dedupe never matches and the fold would double-audit
 * everything. Only a genuinely-uncovered gap survives. An operator-limited lens
 * set also gates the fold: a lens the operator excluded must not re-enter
 * dispatch through requeue.
 */
export function selectUncoveredRequeueTasks(
  requeueTasks: readonly AuditTask[],
  auditTasks: readonly AuditTask[],
  effectiveLenses?: readonly string[],
): AuditTask[] {
  const coveredPathsByLens = new Map<string, Set<string>>();
  for (const task of auditTasks) {
    const covered = coveredPathsByLens.get(task.lens) ?? new Set<string>();
    for (const path of task.file_paths) covered.add(path);
    coveredPathsByLens.set(task.lens, covered);
  }
  const allowedLenses =
    effectiveLenses === undefined ? null : new Set(effectiveLenses);
  return requeueTasks.filter((task) => {
    if (task.status !== "pending") return false;
    if (allowedLenses !== null && !allowedLenses.has(task.lens)) return false;
    const covered = coveredPathsByLens.get(task.lens);
    const fullyCovered =
      covered !== undefined &&
      task.file_paths.every((path) => covered.has(path));
    return !fullyCovered;
  });
}

/**
 * The requeue fold's `file_line_counts` enrichment (INV-PLAN-PERSIST-COMPLETE
 * half 2) — a MEASURED-ONLY projection of the line index over a task's paths.
 *
 * `file_line_counts` is a `Record<string, number>`, schema-constrained downstream
 * to `z.number().int().min(0)`. A path is therefore either present with a real
 * count or ABSENT: an absent index key, a `null`, and the unmeasured sentinel
 * (`UNMEASURED_LINE_COUNT`, NaN — which JSON-serializes as `null`) all drop the
 * key rather than emit a value the contract cannot hold. This filter is the only
 * thing standing between the diagnostic index's "unmeasured" concept and a
 * persisted numeric contract, so it is stated once, here, as its own unit.
 */
function measuredLineCounts(
  filePaths: readonly string[],
  lineIndex: Record<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    filePaths
      .filter(
        (path) =>
          lineIndex[path] != null && !isUnmeasuredLineCount(lineIndex[path]),
      )
      .map((path) => [path, lineIndex[path]]),
  );
}

/**
 * Select the genuinely-uncovered requeue tasks and enrich the survivors with
 * line-count hints — the whole fold, so neither draw re-derives half of it.
 *
 * `effectiveLenses` is the resolved operator lens set (`resolveIntentLensSelection`);
 * `undefined` means the operator declared no limit, not "no lenses".
 */
export function foldPendingRequeueTasks(params: {
  readonly requeueTasks: readonly AuditTask[];
  readonly auditTasks: readonly AuditTask[];
  readonly lineIndex: Record<string, number>;
  readonly effectiveLenses?: readonly string[];
}): AuditTask[] {
  const { lineIndex } = params;
  return selectUncoveredRequeueTasks(
    params.requeueTasks,
    params.auditTasks,
    params.effectiveLenses,
  ).map((task) => ({
    ...task,
    file_line_counts: measuredLineCounts(task.file_paths, lineIndex),
  }));
}
