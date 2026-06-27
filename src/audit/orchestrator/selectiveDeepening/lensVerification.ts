import type { AuditResult, AuditTask, Lens } from "../../types.js";
import type { ExternalAnalyzerResults } from "../../types/externalAnalyzer.js";
import { isHighRiskCleanResult } from "./highRiskClean.js";
import {
  DEEPENING_TAG,
  IMPORTANT_LENS_VERIFICATION_LENSES,
  LENS_VERIFICATION_TAG,
  MAX_LENS_VERIFICATION_FILES,
  MAX_LENS_VERIFICATION_RESULT_SUMMARIES,
  SEVERITY_RANK,
  formatList,
  getExternalAnalyzerPaths,
  isDeepeningTask,
  isLensVerificationTask,
  lineCountForPath,
  lineCountFromSources,
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
    return sum + (owner ? lineCountForPath(path, owner.task, owner.result) : 0);
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

function selectLensVerificationFiles(
  sources: LensVerificationSource[],
  externalAnalyzerPaths: Set<string>,
  lens: Lens,
): string[] {
  const scores = new Map<string, { score: number; lines: number }>();
  function add(path: string, score: number, lines: number): void {
    const current = scores.get(path) ?? { score: 0, lines };
    current.score += score;
    current.lines = Math.max(current.lines, lines);
    scores.set(path, current);
  }

  for (const source of sources) {
    const priorityScore = priorityRank(source.task?.priority);
    const highRiskClean = isHighRiskCleanResult(source.result, source.task);
    for (const path of resultFiles(source)) {
      add(path, priorityScore, lineCountForPath(path, source.task, source.result));
      if (source.task?.tags?.includes("critical_flow")) add(path, SCORE_CRITICAL_FLOW, 0);
      if (source.task?.tags?.includes("external_analyzer_signal")) add(path, SCORE_EXTERNAL_ANALYZER_SIGNAL, 0);
      if (source.task?.tags?.includes("large_file")) add(path, SCORE_LARGE_FILE, 0);
      if (highRiskClean) add(path, SCORE_HIGH_RISK_CLEAN, 0);
    }
    for (const finding of source.result.findings) {
      for (const file of finding.affected_files) {
        add(file.path, SEVERITY_RANK[finding.severity], 0);
      }
    }
  }

  for (const path of externalAnalyzerPaths) {
    if (scores.has(path)) {
      add(path, SCORE_EXTERNAL_ANALYZER_PATH_MATCH, 0);
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => {
    const scoreDelta = b[1].score - a[1].score;
    if (scoreDelta !== 0) return scoreDelta;
    const lineDelta = b[1].lines - a[1].lines;
    if (lineDelta !== 0) return lineDelta;
    return a[0].localeCompare(b[0]);
  });
  if (ranked.length > MAX_LENS_VERIFICATION_FILES) {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        source: "audit-code:selectiveDeepening",
        event: "truncated_verification_file_list",
        lens,
        kept: MAX_LENS_VERIFICATION_FILES,
        total: ranked.length,
        ts: new Date().toISOString(),
      }) + "\n",
    );
  }
  return ranked.slice(0, MAX_LENS_VERIFICATION_FILES).map(([path]) => path);
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
  const selectedPaths = selectLensVerificationFiles(
    params.sources,
    params.externalAnalyzerPaths,
    params.lens,
  );
  const allPaths = uniqueSorted(params.sources.flatMap(resultFiles));
  const omittedPathCount = Math.max(0, allPaths.length - selectedPaths.length);
  const externalPathsInScope = allPaths.filter((path) =>
    params.externalAnalyzerPaths.has(path),
  );
  if (params.sources.length > MAX_LENS_VERIFICATION_RESULT_SUMMARIES) {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        source: "audit-code:selectiveDeepening",
        event: "truncated_result_summary_list",
        lens: params.lens,
        kept: MAX_LENS_VERIFICATION_RESULT_SUMMARIES,
        total: params.sources.length,
        ts: new Date().toISOString(),
      }) + "\n",
    );
  }
  const summaries = params.sources
    .sort((a, b) => a.result.task_id.localeCompare(b.result.task_id))
    .slice(0, MAX_LENS_VERIFICATION_RESULT_SUMMARIES)
    .map(summarizeLensVerificationSource);

  return {
    task_id: taskIdFor("steward", [params.lens, ...sourceIds]),
    unit_id: `lens-steward:${params.lens}`,
    pass_id: `lens-steward:${params.lens}`,
    lens: params.lens,
    file_paths: selectedPaths,
    file_line_counts: Object.fromEntries(
      selectedPaths.map((path) => [
        path,
        lineCountFromSources(
          path,
          params.sources.map((source) => source.task).filter((task): task is AuditTask => task !== undefined),
          params.sources.map((source) => source.result),
          params.lineIndex,
        ),
      ]),
    ),
    inputs: {
      source_task_ids: sourceIds.join(","),
      trigger_summary: params.triggers.join(","),
    },
    rationale:
      `Lens steward verification for ${params.lens} after ${params.sources.length} completed base result(s) across ${allPaths.length} file(s). ` +
      `Triggers: ${params.triggers.join(", ")}. ` +
      "Review whether high-risk packets are suspiciously clean, severity/confidence levels are consistent, external analyzer signals were resolved rather than hand-waved, cross-packet issues are visible, no-finding conclusions are believable, and related-file findings contradict each other. " +
      "Do not write direct findings from this verification task; return findings: [] plus verification metadata with bounded follow-up AuditTask suggestions when needed.\n" +
      `Selected verification files: ${formatList(selectedPaths, 8)}${omittedPathCount > 0 ? `; omitted ${omittedPathCount} lower-priority file(s) from direct source checks` : ""}.\n` +
      (externalPathsInScope.length > 0
        ? `External analyzer paths in scope: ${formatList(externalPathsInScope, 8)}.\n`
        : "") +
      "Source result summary:\n" +
      summaries.join("\n") +
      (params.sources.length > MAX_LENS_VERIFICATION_RESULT_SUMMARIES
        ? `\n- ... (+${params.sources.length - MAX_LENS_VERIFICATION_RESULT_SUMMARIES} more result summaries omitted)`
        : ""),
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
    a.localeCompare(b),
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
