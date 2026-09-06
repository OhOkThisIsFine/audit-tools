// One reading of "how many lines does this path have", for the audit
// orchestrator's planning and deepening draws.
//
// It lived twice with ACCIDENTALLY DIFFERENT SHAPES — `reviewPacketShared`
// took `(task, path, lineIndex)` and `selectiveDeepening/shared` took
// `(path, task, result, lineIndex)`. Same question, two argument orders, and a
// reader moving between the two draws had to notice which one they were in.
//
// PRECEDENCE IS STATED BY THE CALLER, not hidden in a default. A source that is
// not passed does not participate, so a call site declares its own order by what
// it supplies. That matters because the sources are NOT interchangeable: a
// task's `file_line_counts` is what was ASSIGNED, while a result's
// `file_coverage` is what the worker actually MEASURED and what the worker
// schema validates. Where a follow-up task is built FROM a result, the measured
// number is the fresher truth and the assigned one may already be stale — so
// that call site passes no task, and coverage wins. A single baked-in order
// would have made one of those two sites silently wrong.
import type { AuditTask } from "../types.js";

/** The part of an `AuditResult` a line count reads — structural, so both the
 *  full schema type and the inline `file_coverage` entry shape satisfy it. */
export interface LineCountResultView {
  readonly file_coverage: ReadonlyArray<{ path: string; total_lines: number }>;
}

export interface LineCountSources {
  /** Counts ASSIGNED to a task. */
  task?: Pick<AuditTask, "file_line_counts">;
  /** Counts MEASURED by a result. */
  result?: LineCountResultView;
  /** A prebuilt path→count index. */
  lineIndex?: Record<string, number>;
}

// Memoized per result OBJECT IDENTITY. The old deepening copy rebuilt its index
// with `Object.fromEntries` on every single call, so counting N paths over one
// result walked that result's whole coverage array N times.
const RESULT_INDEX = new WeakMap<LineCountResultView, Record<string, number>>();

/**
 * The path→total_lines index for one result, built once per result object.
 *
 * FIRST occurrence wins on a duplicated path. That is a real choice, because the
 * two deleted twins DISAGREED here and nothing noticed: `lineCountFromSources`
 * used `file_coverage.find(...)`, which takes the first, while the deepening
 * index was built with `Object.fromEntries`, which keeps the last. Duplicate
 * coverage entries for one path are malformed input, so both readings were
 * arbitrary — but they were arbitrary in two different directions, in the same
 * module, for the same question. First-wins is stated here so there is one
 * answer to state.
 */
export function resultLineIndexFor(
  result: LineCountResultView,
): Record<string, number> {
  const cached = RESULT_INDEX.get(result);
  if (cached) return cached;
  const index: Record<string, number> = {};
  for (const coverage of result.file_coverage) {
    if (!(coverage.path in index)) index[coverage.path] = coverage.total_lines;
  }
  RESULT_INDEX.set(result, index);
  return index;
}

/**
 * The line count for one path from the sources the caller supplies, in the
 * order `task` → `result` → `lineIndex` → 0.
 *
 * `??` throughout, so a stated 0 WINS over a later source rather than falling
 * through it — a file with zero lines is an answer, not a missing one.
 */
export function lineCountForPath(
  path: string,
  sources: LineCountSources = {},
): number {
  return (
    sources.task?.file_line_counts?.[path] ??
    (sources.result === undefined
      ? undefined
      : resultLineIndexFor(sources.result)[path]) ??
    sources.lineIndex?.[path] ??
    0
  );
}

/**
 * The line count for one path across SEVERAL tasks and results — first task
 * that states one, then first result that measured one, then the index.
 */
export function lineCountFromSources(
  path: string,
  tasks: readonly Pick<AuditTask, "file_line_counts">[],
  results: readonly LineCountResultView[],
  lineIndex?: Record<string, number>,
): number {
  for (const task of tasks) {
    const count = task.file_line_counts?.[path];
    if (count !== undefined) return count;
  }
  for (const result of results) {
    const count = resultLineIndexFor(result)[path];
    if (count !== undefined) return count;
  }
  return lineIndex?.[path] ?? 0;
}
