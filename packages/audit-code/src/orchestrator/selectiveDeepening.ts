import { createHash } from "node:crypto";
import type { AuditResult, AuditTask, Finding, Lens } from "../types.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type {
  RuntimeValidationReport,
  RuntimeValidationTask,
  RuntimeValidationTaskManifest,
  RuntimeValidationStatus,
} from "../types/runtimeValidation.js";

const DEFAULT_MAX_DEEPENING_TASKS = 6;
const DEFAULT_MAX_TOTAL_DEEPENING_TASKS = 24;
const DEEPENING_TAG = "selective_deepening";
const LENS_VERIFICATION_TAG = "lens_verification";
const LENS_VERIFICATION_FOLLOWUP_TAG = "lens_verification_followup";
const MAX_LENS_VERIFICATION_FILES = 12;
const MAX_LENS_VERIFICATION_RESULT_SUMMARIES = 12;
const MAX_VERIFICATION_FOLLOWUP_TASKS_PER_RESULT = 4;
const IMPORTANT_LENS_VERIFICATION_LENSES = new Set<Lens>([
  "security",
  "data_integrity",
  "reliability",
]);

const SEVERITY_RANK: Record<Finding["severity"], number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

const CONFIDENCE_RANK: Record<Finding["confidence"], number> = {
  high: 3,
  medium: 2,
  low: 1,
};

function priorityRank(priority: AuditTask["priority"]): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

export interface BuildSelectiveDeepeningTaskOptions {
  existingTasks?: AuditTask[];
  results: AuditResult[];
  lineIndex?: Record<string, number>;
  runtimeValidationTasks?: RuntimeValidationTaskManifest;
  runtimeValidationReport?: RuntimeValidationReport;
  externalAnalyzerResults?: ExternalAnalyzerResults;
  maxTasks?: number;
  maxTotalDeepeningTasks?: number;
}

interface FindingContext {
  result: AuditResult;
  task?: AuditTask;
  finding: Finding;
  paths: string[];
}

function isDeepeningTask(task: AuditTask | undefined): boolean {
  return task?.tags?.includes(DEEPENING_TAG) ?? false;
}

function isLensVerificationTask(task: AuditTask | undefined): boolean {
  return task?.tags?.includes(LENS_VERIFICATION_TAG) ?? false;
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "followup";
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function resultLineIndex(result: AuditResult): Record<string, number> {
  return Object.fromEntries(
    result.file_coverage.map((coverage) => [
      coverage.path,
      coverage.total_lines,
    ]),
  );
}

function lineCountForPath(
  path: string,
  task: AuditTask | undefined,
  result: AuditResult,
  lineIndex?: Record<string, number>,
): number {
  return (
    task?.file_line_counts?.[path] ??
    resultLineIndex(result)[path] ??
    lineIndex?.[path] ??
    0
  );
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function pathsForFinding(
  finding: Finding,
  result: AuditResult,
  task: AuditTask | undefined,
): string[] {
  const assignedPaths = new Set([
    ...(task?.file_paths ?? []),
    ...result.file_coverage.map((coverage) => coverage.path),
  ]);
  const affected = finding.affected_files
    .map((file) => file.path)
    .filter((path) => assignedPaths.size === 0 || assignedPaths.has(path));
  return uniqueSorted(
    affected.length > 0
      ? affected
      : result.file_coverage.map((coverage) => coverage.path),
  );
}

function taskIdFor(prefix: string, values: string[]): string {
  return `deepening:${prefix}:${shortHash(values.join("\0"))}`;
}

function lineCountFromSources(
  path: string,
  tasks: AuditTask[],
  results: AuditResult[],
  lineIndex?: Record<string, number>,
): number {
  for (const task of tasks) {
    const count = task.file_line_counts?.[path];
    if (count !== undefined) {
      return count;
    }
  }

  for (const result of results) {
    const coverage = result.file_coverage.find((item) => item.path === path);
    if (coverage) {
      return coverage.total_lines;
    }
  }

  return lineIndex?.[path] ?? 0;
}

function formatList(values: string[], maxItems: number): string {
  const visible = values.slice(0, maxItems);
  const suffix =
    values.length > maxItems ? `, ... (+${values.length - maxItems} more)` : "";
  return `${visible.join(", ")}${suffix}`;
}

function priorityLabel(priority: AuditTask["priority"]): NonNullable<AuditTask["priority"]> {
  return priority ?? "low";
}

function getExternalAnalyzerPaths(
  externalAnalyzerResults?: ExternalAnalyzerResults,
): Set<string> {
  return new Set(
    (externalAnalyzerResults?.results ?? [])
      .map((result) =>
        result && typeof result.path === "string" && result.path.length > 0
          ? result.path
          : null,
      )
      .filter((path): path is string => path !== null),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizedSuggestedPriority(
  value: unknown,
  fallback: NonNullable<AuditTask["priority"]> = "medium",
): NonNullable<AuditTask["priority"]> {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : fallback;
}

function buildFindingFollowupTask(params: {
  result: AuditResult;
  task?: AuditTask;
  finding: Finding;
  triggers: string[];
  lineIndex?: Record<string, number>;
}): AuditTask {
  const paths = pathsForFinding(params.finding, params.result, params.task);
  const triggerLabel = params.triggers.join("+");
  const taskId = taskIdFor("finding", [
    params.result.task_id,
    params.finding.id,
    triggerLabel,
  ]);
  const priority =
    SEVERITY_RANK[params.finding.severity] >= SEVERITY_RANK.high
      ? "high"
      : "medium";

  return {
    task_id: taskId,
    unit_id: params.result.unit_id,
    pass_id: `deepening:${params.result.pass_id}`,
    lens: params.result.lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(
      paths.map((path) => [
        path,
        lineCountForPath(path, params.task, params.result, params.lineIndex),
      ]),
    ),
    rationale:
      `Follow up on ${params.finding.id} (${params.finding.severity}/${params.finding.confidence}) from ${params.result.task_id}. ` +
      "Verify impact, evidence quality, affected scope, and whether the finding should stand, narrow, or be downgraded.",
    priority,
    tags: [
      DEEPENING_TAG,
      ...params.triggers.map((trigger) => `trigger:${trigger}`),
      `source_task:${sanitizeSegment(params.result.task_id)}`,
      `finding:${sanitizeSegment(params.finding.id)}`,
    ],
    status: "pending",
  };
}

function buildConflictFollowupTask(params: {
  contexts: FindingContext[];
  conflictKey: string;
  lineIndex?: Record<string, number>;
}): AuditTask {
  const [first] = params.contexts;
  const paths = uniqueSorted(params.contexts.flatMap((context) => context.paths));
  const maxSeverity = Math.max(
    ...params.contexts.map((context) => SEVERITY_RANK[context.finding.severity]),
  );
  const lineSources = new Map<string, { task?: AuditTask; result: AuditResult }>();
  for (const context of params.contexts) {
    for (const path of context.paths) {
      if (!lineSources.has(path)) {
        lineSources.set(path, { task: context.task, result: context.result });
      }
    }
  }
  const sourceTaskIds = uniqueSorted(
    params.contexts.map((context) => context.result.task_id),
  );
  const findingIds = uniqueSorted(
    params.contexts.map((context) => context.finding.id),
  );

  return {
    task_id: taskIdFor("conflict", [
      params.conflictKey,
      ...sourceTaskIds,
      ...findingIds,
    ]),
    unit_id: first?.result.unit_id ?? "selective-deepening",
    pass_id: `deepening:${first?.result.pass_id ?? "conflict"}`,
    lens: (first?.result.lens ?? "correctness") as Lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(
      paths.map((path) => {
        const source = lineSources.get(path);
        return [
          path,
          source
            ? lineCountForPath(path, source.task, source.result, params.lineIndex)
            : (params.lineIndex?.[path] ?? 0),
        ];
      }),
    ),
    rationale:
      `Reconcile conflicting audit output for ${params.conflictKey}. ` +
      `Compare source tasks ${sourceTaskIds.join(", ")} and decide the correct severity, confidence, and evidence-backed conclusion.`,
    priority: maxSeverity >= SEVERITY_RANK.high ? "high" : "medium",
    tags: [
      DEEPENING_TAG,
      "trigger:conflicting_output",
      ...sourceTaskIds.slice(0, 3).map((id) => `source_task:${sanitizeSegment(id)}`),
    ],
    status: "pending",
  };
}

function isHighRiskCleanResult(
  result: AuditResult,
  task: AuditTask | undefined,
): boolean {
  if (
    result.findings.length > 0 ||
    result.requires_followup === false ||
    isDeepeningTask(task)
  ) {
    return false;
  }
  if (!task) {
    return (
      result.requires_followup === true &&
      (result.lens === "security" || result.lens === "data_integrity")
    );
  }

  if (task.priority === "high") {
    return true;
  }

  if (
    task.tags?.some((tag) =>
      ["critical_flow", "external_analyzer_signal"].includes(tag),
    )
  ) {
    return true;
  }

  return result.requires_followup === true && task.priority === "medium";
}

function buildHighRiskCleanFollowupTask(params: {
  result: AuditResult;
  task?: AuditTask;
  lineIndex?: Record<string, number>;
}): AuditTask {
  const paths = uniqueSorted(
    (params.task?.file_paths.length ?? 0) > 0
      ? (params.task?.file_paths ?? [])
      : params.result.file_coverage.map((coverage) => coverage.path),
  );

  return {
    task_id: taskIdFor("clean", [params.result.task_id, params.result.lens]),
    unit_id: params.result.unit_id,
    pass_id: `deepening:${params.result.pass_id}`,
    lens: params.result.lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(
      paths.map((path) => [
        path,
        lineCountForPath(path, params.task, params.result, params.lineIndex),
      ]),
    ),
    rationale:
      `Sample high-risk no-finding result from ${params.result.task_id}. ` +
      "Re-review the assigned files for missed edge cases, hidden runtime failures, and whether the clean conclusion should stand.",
    priority: params.task?.priority === "high" ? "high" : "medium",
    tags: [
      DEEPENING_TAG,
      "trigger:high_risk_no_finding",
      `source_task:${sanitizeSegment(params.result.task_id)}`,
    ],
    status: "pending",
  };
}

function runtimeResultNeedsFollowup(status: RuntimeValidationStatus): boolean {
  return status === "not_confirmed" || status === "inconclusive";
}

function pickRuntimeFollowupLens(relatedTasks: AuditTask[]): Lens {
  const preference: Lens[] = [
    "security",
    "data_integrity",
    "reliability",
    "correctness",
    "tests",
    "operability",
    "config_deployment",
    "performance",
    "architecture",
    "maintainability",
  ];
  for (const lens of preference) {
    if (relatedTasks.some((task) => task.lens === lens)) {
      return lens;
    }
  }
  return "correctness";
}

function runtimeValidationHasStrongStaticFinding(
  runtimeTask: RuntimeValidationTask,
  contexts: FindingContext[],
): boolean {
  return contexts.some(
    (context) =>
      intersects(context.paths, runtimeTask.target_paths) &&
      SEVERITY_RANK[context.finding.severity] >= SEVERITY_RANK.high,
  );
}

function buildRuntimeValidationFollowupTask(params: {
  runtimeTask: RuntimeValidationTask;
  runtimeResultStatus: RuntimeValidationStatus;
  relatedTasks: AuditTask[];
  results: AuditResult[];
  lineIndex?: Record<string, number>;
}): AuditTask {
  const paths = uniqueSorted(params.runtimeTask.target_paths);
  const lens = pickRuntimeFollowupLens(params.relatedTasks);
  const firstRelated = params.relatedTasks[0];

  return {
    task_id: taskIdFor("runtime", [params.runtimeTask.id]),
    unit_id: firstRelated?.unit_id ?? `runtime:${sanitizeSegment(params.runtimeTask.id)}`,
    pass_id: `deepening:runtime:${sanitizeSegment(params.runtimeTask.id)}`,
    lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(
      paths.map((path) => [
        path,
        lineCountFromSources(
          path,
          params.relatedTasks,
          params.results,
          params.lineIndex,
        ),
      ]),
    ),
    rationale:
      `Reconcile runtime validation ${params.runtimeTask.id} (${params.runtimeResultStatus}) with semantic audit output. ` +
      "Verify the failing or inconclusive runtime evidence, map it to source behavior, and decide whether a finding should be added or escalated.",
    priority:
      params.runtimeTask.priority === "high" ||
      params.runtimeResultStatus === "not_confirmed"
        ? "high"
        : "medium",
    tags: [
      DEEPENING_TAG,
      "trigger:runtime_validation_disagreement",
      `runtime_task:${sanitizeSegment(params.runtimeTask.id)}`,
      `runtime_status:${params.runtimeResultStatus}`,
    ],
    status: "pending",
  };
}

interface LensVerificationSource {
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
  const totalLines = filePaths.reduce((sum, path) => {
    const owner = params.sources.find((source) => resultFiles(source).includes(path));
    return (
      sum +
      (owner
        ? lineCountForPath(path, owner.task, owner.result)
        : 0)
    );
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
      if (source.task?.tags?.includes("critical_flow")) add(path, 6, 0);
      if (source.task?.tags?.includes("external_analyzer_signal")) add(path, 6, 0);
      if (source.task?.tags?.includes("large_file")) add(path, 4, 0);
      if (highRiskClean) add(path, 5, 0);
    }
    for (const finding of source.result.findings) {
      for (const file of finding.affected_files) {
        add(file.path, SEVERITY_RANK[finding.severity], 0);
      }
    }
  }

  for (const path of externalAnalyzerPaths) {
    if (scores.has(path)) {
      add(path, 8, 0);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => {
      const scoreDelta = b[1].score - a[1].score;
      if (scoreDelta !== 0) return scoreDelta;
      const lineDelta = b[1].lines - a[1].lines;
      if (lineDelta !== 0) return lineDelta;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, MAX_LENS_VERIFICATION_FILES)
    .map(([path]) => path);
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
  );
  const allPaths = uniqueSorted(params.sources.flatMap(resultFiles));
  const omittedPathCount = Math.max(0, allPaths.length - selectedPaths.length);
  const externalPathsInScope = allPaths.filter((path) =>
    params.externalAnalyzerPaths.has(path),
  );
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

function buildLensVerificationTasks(params: {
  existingTasks: AuditTask[];
  results: AuditResult[];
  lineIndex?: Record<string, number>;
  externalAnalyzerResults?: ExternalAnalyzerResults;
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

function buildVerificationFollowupTasks(params: {
  result: AuditResult;
  task?: AuditTask;
  lineIndex?: Record<string, number>;
}): AuditTask[] {
  if (
    !params.result.verification?.needs_followup ||
    !Array.isArray(params.result.verification.followup_tasks) ||
    !isLensVerificationTask(params.task)
  ) {
    return [];
  }

  const coverageByPath = new Map(
    params.result.file_coverage.map((coverage) => [
      coverage.path,
      coverage.total_lines,
    ]),
  );
  const concerns = [
    ...(params.result.verification.concerns ?? []),
    ...(params.result.verification.coverage_concerns ?? []),
    ...(params.result.verification.confidence_concerns ?? []),
  ];
  const tasks: AuditTask[] = [];

  for (let index = 0; index < params.result.verification.followup_tasks.length; index++) {
    if (tasks.length >= MAX_VERIFICATION_FOLLOWUP_TASKS_PER_RESULT) {
      break;
    }
    const suggestion = params.result.verification.followup_tasks[index] as unknown;
    if (!isRecord(suggestion)) {
      continue;
    }
    if (suggestion.lens !== params.result.lens) {
      continue;
    }
    const suggestedPaths = Array.isArray(suggestion.file_paths)
      ? suggestion.file_paths.filter(
          (path): path is string =>
            typeof path === "string" && coverageByPath.has(path),
        )
      : [];
    const paths = uniqueSorted(suggestedPaths);
    if (paths.length === 0) {
      continue;
    }
    const suggestedRationale =
      typeof suggestion.rationale === "string" && suggestion.rationale.trim().length > 0
        ? suggestion.rationale.trim()
        : concerns[0] ?? "Lens steward requested bounded follow-up.";
    const suggestedId =
      typeof suggestion.task_id === "string" && suggestion.task_id.trim().length > 0
        ? suggestion.task_id
        : `suggestion-${index + 1}`;

    tasks.push({
      task_id: taskIdFor("steward-followup", [
        params.result.task_id,
        String(index),
        suggestedId,
        ...paths,
        suggestedRationale,
      ]),
      unit_id:
        typeof suggestion.unit_id === "string" && suggestion.unit_id.trim().length > 0
          ? suggestion.unit_id
          : params.result.unit_id,
      pass_id: `deepening:${params.result.pass_id}`,
      lens: params.result.lens,
      file_paths: paths,
      file_line_counts: Object.fromEntries(
        paths.map((path) => [
          path,
          coverageByPath.get(path) ?? params.lineIndex?.[path] ?? 0,
        ]),
      ),
      rationale:
        `Lens steward follow-up from ${params.result.task_id}. ${suggestedRationale}`,
      priority: normalizedSuggestedPriority(suggestion.priority, "medium"),
      tags: [
        DEEPENING_TAG,
        LENS_VERIFICATION_FOLLOWUP_TAG,
        "trigger:lens_verification",
        `source_task:${sanitizeSegment(params.result.task_id)}`,
      ],
      status: "pending",
    });
  }

  return tasks;
}

function findingContexts(
  results: AuditResult[],
  taskById: Map<string, AuditTask>,
): FindingContext[] {
  const contexts: FindingContext[] = [];
  for (const result of results) {
    const task = taskById.get(result.task_id);
    if (isDeepeningTask(task)) {
      continue;
    }
    for (const finding of result.findings) {
      contexts.push({
        result,
        task,
        finding,
        paths: pathsForFinding(finding, result, task),
      });
    }
  }
  return contexts;
}

function conflictGroups(contexts: FindingContext[]): Map<string, FindingContext[]> {
  const groups = new Map<string, FindingContext[]>();
  for (const context of contexts) {
    for (const path of context.paths) {
      const key = [
        context.result.lens,
        context.finding.category,
        path.toLowerCase(),
      ].join(":");
      const group = groups.get(key) ?? [];
      group.push(context);
      groups.set(key, group);
    }
  }
  for (const [key, group] of groups) {
    const uniqueTasks = new Set(group.map((context) => context.result.task_id));
    const severities = group.map((context) => SEVERITY_RANK[context.finding.severity]);
    const confidences = group.map((context) => CONFIDENCE_RANK[context.finding.confidence]);
    const severitySpread = Math.max(...severities) - Math.min(...severities);
    const confidenceSpread = Math.max(...confidences) - Math.min(...confidences);
    if (uniqueTasks.size < 2 || (severitySpread < 2 && confidenceSpread < 2)) {
      groups.delete(key);
    }
  }
  return groups;
}

export function buildSelectiveDeepeningTasks(
  options: BuildSelectiveDeepeningTaskOptions,
): AuditTask[] {
  const taskById = new Map(
    (options.existingTasks ?? []).map((task) => [task.task_id, task]),
  );
  const existingTasks = options.existingTasks ?? [];
  const existingIds = new Set(taskById.keys());
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_DEEPENING_TASKS;
  const maxTotalDeepeningTasks =
    options.maxTotalDeepeningTasks ?? DEFAULT_MAX_TOTAL_DEEPENING_TASKS;

  const existingDeepeningCount = existingTasks.filter((task) =>
    isDeepeningTask(task),
  ).length;
  if (existingDeepeningCount >= maxTotalDeepeningTasks) {
    return [];
  }
  const remainingBudget = maxTotalDeepeningTasks - existingDeepeningCount;
  const effectiveMax = Math.min(maxTasks, remainingBudget);
  const created: AuditTask[] = [];

  function pushIfNew(task: AuditTask): void {
    if (created.length >= effectiveMax || existingIds.has(task.task_id)) {
      return;
    }
    existingIds.add(task.task_id);
    created.push(task);
  }

  const contexts = findingContexts(options.results, taskById);
  for (const context of contexts) {
    const triggers: string[] = [];
    if (SEVERITY_RANK[context.finding.severity] >= SEVERITY_RANK.high) {
      triggers.push("high_severity");
    }
    if (context.finding.confidence === "low") {
      triggers.push("low_confidence");
    }
    if (triggers.length === 0) {
      continue;
    }
    pushIfNew(
      buildFindingFollowupTask({
        result: context.result,
        task: context.task,
        finding: context.finding,
        triggers,
        lineIndex: options.lineIndex,
      }),
    );
  }

  for (const [key, group] of [...conflictGroups(contexts).entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    pushIfNew(
      buildConflictFollowupTask({
        contexts: group,
        conflictKey: key,
        lineIndex: options.lineIndex,
      }),
    );
  }

  for (const result of options.results) {
    const task = taskById.get(result.task_id);
    for (const followupTask of buildVerificationFollowupTasks({
      result,
      task,
      lineIndex: options.lineIndex,
    })) {
      pushIfNew(followupTask);
    }
  }

  const runtimeTaskById = new Map(
    (options.runtimeValidationTasks?.tasks ?? []).map((task) => [
      task.id,
      task,
    ]),
  );
  for (const result of [...(options.runtimeValidationReport?.results ?? [])].sort(
    (a, b) => a.task_id.localeCompare(b.task_id),
  )) {
    if (!runtimeResultNeedsFollowup(result.status)) {
      continue;
    }
    const runtimeTask = runtimeTaskById.get(result.task_id);
    if (!runtimeTask || runtimeTask.target_paths.length === 0) {
      continue;
    }
    if (runtimeValidationHasStrongStaticFinding(runtimeTask, contexts)) {
      continue;
    }
    const relatedTasks = existingTasks.filter(
      (task) =>
        !isDeepeningTask(task) && intersects(task.file_paths, runtimeTask.target_paths),
    );
    pushIfNew(
      buildRuntimeValidationFollowupTask({
        runtimeTask,
        runtimeResultStatus: result.status,
        relatedTasks,
        results: options.results,
        lineIndex: options.lineIndex,
      }),
    );
  }

  for (const task of buildLensVerificationTasks({
    existingTasks,
    results: options.results,
    lineIndex: options.lineIndex,
    externalAnalyzerResults: options.externalAnalyzerResults,
  })) {
    pushIfNew(task);
  }

  const cleanResults = options.results
    .map((result) => ({ result, task: taskById.get(result.task_id) }))
    .filter(({ result, task }) => isHighRiskCleanResult(result, task))
    .sort((a, b) => {
      const priorityDelta =
        priorityRank(b.task?.priority) - priorityRank(a.task?.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return a.result.task_id.localeCompare(b.result.task_id);
    });

  for (const { result, task } of cleanResults) {
    pushIfNew(
      buildHighRiskCleanFollowupTask({
        result,
        task,
        lineIndex: options.lineIndex,
      }),
    );
  }

  return created;
}

export const selectiveDeepeningTestUtils = {
  DEEPENING_TAG,
  LENS_VERIFICATION_TAG,
  LENS_VERIFICATION_FOLLOWUP_TAG,
  DEFAULT_MAX_TOTAL_DEEPENING_TASKS,
};
