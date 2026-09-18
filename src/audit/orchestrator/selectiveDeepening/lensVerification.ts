// sites-pinned: tests/audit/lens-steward-surface.test.ts, tests/audit/orchestrator-remediation.test.ts
import { lineCountForPath, lineCountFromSources } from "../lineCounts.js";
import type { AuditResult, AuditTask, Lens } from "../../types.js";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import { compareCodeUnits } from "audit-tools/shared";
import { isHighRiskCleanResult } from "./highRiskClean.js";
import {
  DEEPENING_TAG,
  IMPORTANT_LENS_VERIFICATION_LENSES,
  LENS_VERIFICATION_TAG,
  SEVERITY_RANK,
  formatList,
  getExternalAnalyzerPaths,
  isDeepeningTask,
  isLensVerificationTask,


  priorityLabel,
  priorityRank,
  taskIdFor,
  uniqueSorted,
} from "./shared.js";

/** Score boost for files touched by a critical-flow task — highest semantic signal. */
const SCORE_CRITICAL_FLOW = 6;
/** Score boost for files flagged by an external analyzer tool — treated equally to critical-flow signal. */
const SCORE_EXTERNAL_ANALYZER_SIGNAL = 6;
/** Score boost for files from a large-file task — moderately elevated scrutiny. */
const SCORE_LARGE_FILE = 4;
/** Score boost for a high-risk task whose result was suspiciously clean — warrants re-examination. */
const SCORE_HIGH_RISK_CLEAN = 5;
/** Score boost for files directly matched by an external-analyzer path set — strongest single boost, above tag signals. */
const SCORE_EXTERNAL_ANALYZER_PATH_MATCH = 8;

export interface LensVerificationSource {
  result: AuditResult;
  task?: AuditTask;
}

function sourceTaskIds(sources: LensVerificationSource[]): string[] {
  return uniqueSorted(sources.map((source) => source.result.task_id));
}

function resultFiles(source: LensVerificationSource): string[] {
  return uniqueSorted(
    source.task?.file_paths && source.task.file_paths.length > 0
      ? source.task.file_paths
      : source.result.file_coverage.map((coverage) => coverage.path),
  );
}

function lensVerificationTriggers(params: {
  lens: Lens;
  sources: LensVerificationSource[];
  externalAnalyzerPaths: Set<string>;
}): string[] {
  const filePaths = uniqueSorted(params.sources.flatMap(resultFiles));
  const findingPaths = new Set(
    params.sources.flatMap((source) =>
      source.result.findings.flatMap((finding) =>
        finding.affected_files.map((file) => file.path),
      ),
    ),
  );
  const externalPathsInScope = filePaths.filter((path) =>
    params.externalAnalyzerPaths.has(path),
  );
  const unresolvedExternalPaths = externalPathsInScope.filter(
    (path) => !findingPaths.has(path),
  );
  const cleanResults = params.sources.filter(
    (source) =>
      source.result.findings.length === 0 &&
      source.result.requires_followup !== false,
  );
  const highRiskCleanResults = params.sources.filter((source) =>
    isHighRiskCleanResult(source.result, source.task),
  );
  const pathOwnerMap = new Map<string, LensVerificationSource>();
  for (const source of params.sources) {
    for (const path of resultFiles(source)) {
      if (!pathOwnerMap.has(path)) pathOwnerMap.set(path, source);
    }
  }
  const totalLines = filePaths.reduce((sum, path) => {
    const owner = pathOwnerMap.get(path);
    return sum + (owner ? lineCountForPath(path, { task: owner.task, result: owner.result }) : 0);
  }, 0);

  const triggers: string[] = [];
  if (params.sources.some((source) => source.task?.priority === "high")) {
    triggers.push("high_priority_lens");
  }
  if (
    params.sources.some((source) =>
      source.task?.tags?.some(
        (tag) => tag === "critical_flow" || tag.startsWith("critical_flow:"),
      ),
    )
  ) {
    triggers.push("critical_flow");
  }
  if (
    params.sources.some((source) =>
      source.task?.tags?.some(
        (tag) =>
          tag === "external_analyzer_signal" ||
          tag.startsWith("external_tool:"),
      ),
    ) ||
    externalPathsInScope.length > 0
  ) {
    triggers.push("external_analyzer_signal");
  }
  if (unresolvedExternalPaths.length > 0) {
    triggers.push("unresolved_external_signal");
  }
  if (
    params.sources.length >= 3 ||
    filePaths.length >= 4 ||
    totalLines >= 2000
  ) {
    triggers.push("large_lens_surface");
  }
  if (cleanResults.length >= 2 && cleanResults.length >= params.sources.length / 2) {
    triggers.push("many_no_finding_results");
  }
  if (highRiskCleanResults.length > 0) {
    triggers.push("high_risk_clean_result");
  }
  if (
    params.sources.some((source) =>
      source.task?.tags?.some((tag) => tag === "large_file"),
    )
  ) {
    triggers.push("large_file_reviewed");
  }

  return uniqueSorted(triggers);
}

function hasPendingBaseTaskForLens(
  lens: Lens,
  tasks: AuditTask[],
  completedResultIds: Set<string>,
): boolean {
  return tasks.some(
    (task) =>
      task.lens === lens &&
      !isDeepeningTask(task) &&
      !completedResultIds.has(task.task_id) &&
      task.status !== "complete",
  );
}

function shouldBuildLensVerificationTask(params: {
  lens: Lens;
  sources: LensVerificationSource[];
  triggers: string[];
  existingTasks: AuditTask[];
  completedResultIds: Set<string>;
}): boolean {
  if (!IMPORTANT_LENS_VERIFICATION_LENSES.has(params.lens)) {
    return false;
  }
  if (params.sources.length === 0 || params.triggers.length === 0) {
    return false;
  }
  const explicitlyClosedCleanScope = params.sources.every(
    (source) =>
      source.result.findings.length === 0 &&
      source.result.requires_followup === false,
  );
  if (
    explicitlyClosedCleanScope &&
    !params.triggers.some((trigger) =>
      ["external_analyzer_signal", "unresolved_external_signal"].includes(trigger),
    )
  ) {
    return false;
  }
  if (
    hasPendingBaseTaskForLens(
      params.lens,
      params.existingTasks,
      params.completedResultIds,
    )
  ) {
    return false;
  }

  const enoughSurface =
    params.sources.length >= 2 ||
    params.triggers.some((trigger) =>
      [
        "critical_flow",
        "external_analyzer_signal",
        "unresolved_external_signal",
        "large_lens_surface",
      ].includes(trigger),
    );
  if (!enoughSurface) {
    return false;
  }

  const sourceSignature = sourceTaskIds(params.sources);
  const candidateId = taskIdFor("steward", [params.lens, ...sourceSignature]);
  return !params.existingTasks.some((task) => task.task_id === candidateId);
}

/** One surface file's metrics, exactly as `AuditTask.file_metrics` declares them. */
type LensSurfaceFileMetric = NonNullable<AuditTask["file_metrics"]>[number];

/**
 * The metrics a lens steward chooses its own review from.
 *
 * EVERY file the lens was applied to appears exactly once. `score` is the same
 * ranking the deleted twelve-file cap used to TRUNCATE by; it now only ORDERS
 * the list. A steward that never sees a file can neither judge that file's
 * coverage nor name it in a follow-up, and naming a path costs nothing — so the
 * rank is a hint, never a boundary.
 *
 * A path that a finding cites but that this lens never reviewed stays OFF the
 * surface: the surface states what the lens covered, and a path with no review
 * behind it has no line count and no coverage to judge.
 */
function buildLensSurfaceMetrics(params: {
  sources: LensVerificationSource[];
  surfacePaths: string[];
  externalAnalyzerPaths: Set<string>;
  lineIndex?: Record<string, number>;
}): LensSurfaceFileMetric[] {
  const onSurface = new Set(params.surfacePaths);
  const scores = new Map<string, number>();
  const signals = new Map<string, Set<string>>();
  const priorFindings = new Map<string, Map<string, number>>();

  function add(path: string, score: number, signal: string): void {
    if (!onSurface.has(path)) return;
    scores.set(path, (scores.get(path) ?? 0) + score);
    const set = signals.get(path) ?? new Set<string>();
    set.add(signal);
    signals.set(path, set);
  }

  for (const source of params.sources) {
    const highRiskClean = isHighRiskCleanResult(source.result, source.task);
    for (const path of resultFiles(source)) {
      add(
        path,
        priorityRank(source.task?.priority),
        `${priorityLabel(source.task?.priority)}_priority`,
      );
      if (source.task?.tags?.includes("critical_flow")) {
        add(path, SCORE_CRITICAL_FLOW, "critical_flow");
      }
      if (source.task?.tags?.includes("external_analyzer_signal")) {
        add(path, SCORE_EXTERNAL_ANALYZER_SIGNAL, "external_analyzer_signal");
      }
      if (source.task?.tags?.includes("large_file")) {
        add(path, SCORE_LARGE_FILE, "large_file");
      }
      if (highRiskClean) {
        add(path, SCORE_HIGH_RISK_CLEAN, "high_risk_clean");
      }
    }
    for (const finding of source.result.findings) {
      for (const file of finding.affected_files) {
        if (!onSurface.has(file.path)) continue;
        add(file.path, SEVERITY_RANK[finding.severity], "prior_finding");
        const counts =
          priorFindings.get(file.path) ?? new Map<string, number>();
        counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
        priorFindings.set(file.path, counts);
      }
    }
  }

  for (const path of params.externalAnalyzerPaths) {
    add(path, SCORE_EXTERNAL_ANALYZER_PATH_MATCH, "external_analyzer_path_match");
  }

  const tasks = params.sources
    .map((source) => source.task)
    .filter((task): task is AuditTask => task !== undefined);
  const results = params.sources.map((source) => source.result);

  // Ordered by prior signal, strongest first — a content-derived, stable key
  // (score, then size, then path), so the list never churns the task's hash.
  return params.surfacePaths
    .map((path) => ({
      path,
      total_lines: lineCountFromSources(path, tasks, results, params.lineIndex),
      score: scores.get(path) ?? 0,
      signals: uniqueSorted(signals.get(path) ?? []),
      prior_findings: Object.fromEntries(
        [...(priorFindings.get(path) ?? new Map<string, number>())].sort(
          (left, right) => compareCodeUnits(left[0], right[0]),
        ),
      ),
    }))
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) return scoreDelta;
      const lineDelta = right.total_lines - left.total_lines;
      if (lineDelta !== 0) return lineDelta;
      return compareCodeUnits(left.path, right.path);
    });
}

function summarizeLensVerificationSource(source: LensVerificationSource): string {
  const findings =
    source.result.findings.length === 0
      ? "findings=none"
      : `findings=${source.result.findings
          .slice(0, 3)
          .map(
            (finding) =>
              `${finding.id} ${finding.severity}/${finding.confidence} ${finding.category}: ${finding.title}`,
          )
          .join("; ")}${source.result.findings.length > 3 ? "; ..." : ""}`;
  const tags = source.task?.tags?.length
    ? ` tags=${source.task.tags.join(",")}`
    : "";
  return (
    `- ${source.result.task_id} priority=${priorityLabel(source.task?.priority)}` +
    `${tags} files=${formatList(resultFiles(source), 4)} ${findings}` +
    (source.result.requires_followup === true ? " requires_followup=true" : "")
  );
}

function buildLensVerificationTask(params: {
  lens: Lens;
  sources: LensVerificationSource[];
  triggers: string[];
  externalAnalyzerPaths: Set<string>;
  lineIndex?: Record<string, number>;
}): AuditTask {
  const sourceIds = sourceTaskIds(params.sources);
  const surfacePaths = uniqueSorted(params.sources.flatMap(resultFiles));
  const fileMetrics = buildLensSurfaceMetrics({
    sources: params.sources,
    surfacePaths,
    externalAnalyzerPaths: params.externalAnalyzerPaths,
    lineIndex: params.lineIndex,
  });
  const surfaceLines = fileMetrics.reduce(
    (sum, metric) => sum + metric.total_lines,
    0,
  );
  const externalPathsInScope = surfacePaths.filter((path) =>
    params.externalAnalyzerPaths.has(path),
  );
  // A COPY before the sort: `params.sources` belongs to the caller, and the old
  // in-place `.sort()` reordered the array the trigger derivation had already
  // read from.
  const summaries = [...params.sources]
    .sort((a, b) => compareCodeUnits(a.result.task_id, b.result.task_id))
    .map(summarizeLensVerificationSource);

  return {
    task_id: taskIdFor("steward", [params.lens, ...sourceIds]),
    unit_id: `lens-steward:${params.lens}`,
    pass_id: `lens-steward:${params.lens}`,
    lens: params.lens,
    file_paths: surfacePaths,
    file_line_counts: Object.fromEntries(
      fileMetrics.map((metric) => [metric.path, metric.total_lines]),
    ),
    // The steward reviews what it judges worth reviewing, so a coverage set
    // smaller than the assignment is this lane's contract. Both completeness
    // gates read this field.
    coverage_policy: "selective",
    file_metrics: fileMetrics,
    inputs: {
      source_task_ids: sourceIds.join(","),
      trigger_summary: params.triggers.join(","),
    },
    rationale:
      `Lens steward verification for ${params.lens} after ${params.sources.length} completed base result(s). ` +
      `Your assignment is the WHOLE surface this lens was applied to: ${surfacePaths.length} file(s), ${surfaceLines} line(s). ` +
      `Triggers: ${params.triggers.join(", ")}.\n` +
      "You choose which of those files to open. Every file on the surface states its line count and its prior-signal metrics, ordered strongest signal first; a file you decide not to open is not a coverage failure, but state how you chose in verification.selection_rationale. " +
      "Review whether high-risk packets are suspiciously clean, severity/confidence levels are consistent, external analyzer signals were resolved rather than hand-waved, cross-packet issues are visible, no-finding conclusions are believable, and related-file findings contradict each other.\n" +
      "Do not write direct findings from this verification task; return findings: [] plus verification metadata with bounded follow-up AuditTask suggestions when needed. A follow-up may name any file on this surface.\n" +
      (externalPathsInScope.length > 0
        ? `External analyzer paths on the surface: ${formatList(externalPathsInScope, 8)}.\n`
        : "") +
      "Source result summary:\n" +
      summaries.join("\n"),
    priority: "high",
    tags: [
      DEEPENING_TAG,
      LENS_VERIFICATION_TAG,
      `lens:${params.lens}`,
      ...params.triggers.map((trigger) => `trigger:${trigger}`),
    ],
    status: "pending",
  };
}

export function buildLensVerificationTasks(params: {
  existingTasks: AuditTask[];
  results: AuditResult[];
  lineIndex?: Record<string, number>;
  externalAnalyzerResults?: ExternalAnalyzerResults[];
}): AuditTask[] {
  const taskById = new Map(params.existingTasks.map((task) => [task.task_id, task]));
  const completedResultIds = new Set(params.results.map((result) => result.task_id));
  const externalAnalyzerPaths = getExternalAnalyzerPaths(params.externalAnalyzerResults);
  const tasks: AuditTask[] = [];

  for (const lens of [...IMPORTANT_LENS_VERIFICATION_LENSES].sort((a, b) =>
    compareCodeUnits(a, b),
  )) {
    const sources = params.results
      .map((result) => ({ result, task: taskById.get(result.task_id) }))
      .filter(
        (source) =>
          source.result.lens === lens &&
          !isDeepeningTask(source.task) &&
          !isLensVerificationTask(source.task),
      );
    const triggers = lensVerificationTriggers({
      lens,
      sources,
      externalAnalyzerPaths,
    });
    if (
      !shouldBuildLensVerificationTask({
        lens,
        sources,
        triggers,
        existingTasks: params.existingTasks,
        completedResultIds,
      })
    ) {
      continue;
    }
    tasks.push(
      buildLensVerificationTask({
        lens,
        sources,
        triggers,
        externalAnalyzerPaths,
        lineIndex: params.lineIndex,
      }),
    );
  }

  return tasks;
}
