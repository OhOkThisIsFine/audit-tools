import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type {
  AuditTask,
  CoverageMatrix,
  Lens,
} from "../types.js";
import type { CriticalFlowManifest } from "@audit-tools/shared";
import { claimFlowReviewBlocks } from "./flowPlanning.js";
import { isTrivialAuditPath } from "./trivialAudit.js";
import { LENS_ORDER, priorityRank } from "./auditTaskUtils.js";
import {
  isTestPath,
  normalizeExtractorPath,
} from "../extractors/pathPatterns.js";

export interface UnitLineIndex {
  [path: string]: number;
}

export interface BuildChunkedTaskOptions {
  /**
   * Line count above which a single file gets its own task rather than being
   * grouped with the rest of its unit. Default: 3000. Set to 0 to disable
   * splitting entirely.
   */
  file_split_threshold?: number;
  /**
   * Approximate total line budget for a review task. Multi-file blocks above
   * this budget are split into multiple bounded review tasks. Default: 1500.
   * Set to 0 to disable aggregate line-budget splitting.
   */
  max_task_lines?: number;
  /**
   * Maximum number of files in one review task. Default: 8. Set to 0 to
   * disable aggregate file-count splitting.
   */
  max_task_files?: number;
  /**
   * Test files at or below this size can be batched across unit boundaries.
   * Default: 250. Set to 0 to disable tiny-test batching.
   */
  tiny_test_file_lines?: number;
  limit_lenses?: Lens[];
  external_analyzer_results?: ExternalAnalyzerResults;
  critical_flows?: CriticalFlowManifest;
}

function taskPriority(
  hasExternalSignal: boolean,
  lens: Lens,
  isCriticalFlow = false,
): "high" | "medium" | "low" {
  if (isCriticalFlow) {
    return lens === "security" || lens === "reliability" || lens === "correctness"
      ? "high"
      : "medium";
  }
  if (
    hasExternalSignal &&
    (lens === "security" || lens === "data_integrity" || lens === "reliability")
  ) {
    return "high";
  }
  if (hasExternalSignal) {
    return "medium";
  }
  return lens === "security" || lens === "data_integrity" ? "medium" : "low";
}

function pickAnalyzerLens(category: string): Lens {
  const normalized = category.toLowerCase();
  if (
    normalized.includes("security") ||
    normalized.includes("secret") ||
    normalized.includes("dependency")
  )
    return "security";
  if (normalized.includes("data")) return "data_integrity";
  if (normalized.includes("tests") || normalized.includes("coverage"))
    return "tests";
  if (normalized.includes("reliability") || normalized.includes("concurrency"))
    return "reliability";
  if (
    normalized.includes("maintainability") ||
    normalized.includes("lint") ||
    normalized.includes("style")
  )
    return "maintainability";
  return "correctness";
}

const DEFAULT_FILE_SPLIT_THRESHOLD = 5000;
const DEFAULT_MAX_TASK_LINES = 3000;
const DEFAULT_MAX_TASK_FILES = 15;
const DEFAULT_TINY_TEST_FILE_LINES = 250;
const TINY_TEST_UNIT_ID = "tests-tiny-files";

type SplitKind = "none" | "large_file" | "budget";

function buildCoverageIndex(
  coverageMatrix: CoverageMatrix,
): Map<string, CoverageMatrix["files"][number]> {
  return new Map(coverageMatrix.files.map((file) => [file.path, file]));
}

function getExternalSignalPaths(
  externalAnalyzerResults?: ExternalAnalyzerResults,
): Set<string> {
  const results = Array.isArray(externalAnalyzerResults?.results)
    ? externalAnalyzerResults.results
    : [];
  return new Set(
    results
      .map((item) =>
        item && typeof item.path === "string" && item.path.length > 0
          ? item.path
          : null,
      )
      .filter((path): path is string => path !== null),
  );
}

function getExternalSignalResults(
  externalAnalyzerResults?: ExternalAnalyzerResults,
): ExternalAnalyzerResults["results"] {
  if (!Array.isArray(externalAnalyzerResults?.results)) {
    return [];
  }
  return externalAnalyzerResults.results.filter(
    (item): item is ExternalAnalyzerResults["results"][number] =>
      Boolean(item) &&
      typeof item.path === "string" &&
      typeof item.category === "string" &&
      typeof item.summary === "string" &&
      typeof item.id === "string",
  );
}

export function buildChunkedAuditTasks(
  coverageMatrix: CoverageMatrix,
  unitLineIndex: UnitLineIndex,
  options: BuildChunkedTaskOptions = {},
): AuditTask[] {
  const fileSplitThreshold = options.file_split_threshold ?? DEFAULT_FILE_SPLIT_THRESHOLD;
  const maxTaskLines = options.max_task_lines ?? DEFAULT_MAX_TASK_LINES;
  const maxTaskFiles = options.max_task_files ?? DEFAULT_MAX_TASK_FILES;
  const tinyTestFileLines = options.tiny_test_file_lines ?? DEFAULT_TINY_TEST_FILE_LINES;
  const allowed = new Set(options.limit_lenses ?? []);
  const enforceLensFilter = allowed.size > 0;
  const tasks: AuditTask[] = [];
  const seen = new Set<string>();
  const externalPaths = getExternalSignalPaths(options.external_analyzer_results);

  const coverageByPath = new Map(
    coverageMatrix.files.map((file) => [file.path, file]),
  );
  const pendingByLens = new Map<Lens, Set<string>>();

  for (const file of coverageMatrix.files) {
    if (file.audit_status === "excluded") {
      continue;
    }

    for (const lens of file.required_lenses) {
      if (file.completed_lenses.includes(lens)) {
        continue;
      }
      if (enforceLensFilter && !allowed.has(lens)) {
        continue;
      }
      if (
        isTrivialAuditPath(
          file.path,
          unitLineIndex[file.path] ?? 0,
          externalPaths.has(file.path),
        )
      ) {
        continue;
      }

      const pending = pendingByLens.get(lens) ?? new Set<string>();
      pending.add(file.path);
      pendingByLens.set(lens, pending);
    }
  }

  function chunkByTaskBudget(filePaths: string[]): string[][] {
    if (filePaths.length === 0) {
      return [];
    }
    if (maxTaskLines <= 0 && maxTaskFiles <= 0) {
      return [filePaths];
    }

    const chunks: string[][] = [];
    let current: string[] = [];
    let currentLines = 0;

    for (const path of filePaths) {
      const lineCount = unitLineIndex[path] ?? 0;
      const wouldExceedFiles =
        maxTaskFiles > 0 && current.length >= maxTaskFiles;
      const wouldExceedLines =
        maxTaskLines > 0 &&
        current.length > 0 &&
        currentLines + lineCount > maxTaskLines;

      if (wouldExceedFiles || wouldExceedLines) {
        chunks.push(current);
        current = [];
        currentLines = 0;
      }

      current.push(path);
      currentLines += lineCount;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  function addTaskBlock(params: {
    scopeId: string;
    unitId: string;
    passId: string;
    lens: Lens;
    filePaths: string[];
    priority: AuditTask["priority"];
    tags: string[];
    rationale: (filePaths: string[], splitKind: SplitKind) => string;
  }): void {
    const oversizedFiles =
      fileSplitThreshold > 0
        ? params.filePaths.filter((path) => (unitLineIndex[path] ?? 0) > fileSplitThreshold)
        : [];
    const oversizedSet = new Set(oversizedFiles);
    const normalFiles = params.filePaths.filter((path) => !oversizedSet.has(path));

    const normalChunks = chunkByTaskBudget(normalFiles);
    for (let index = 0; index < normalChunks.length; index++) {
      const chunk = normalChunks[index];
      const splitKind: SplitKind = normalChunks.length > 1 ? "budget" : "none";
      const taskId =
        splitKind === "budget"
          ? `${params.scopeId}:${params.lens}:part-${index + 1}`
          : `${params.scopeId}:${params.lens}`;
      if (!seen.has(taskId)) {
        seen.add(taskId);
        tasks.push({
          task_id: taskId,
          unit_id: params.unitId,
          pass_id: params.passId,
          lens: params.lens,
          file_paths: chunk,
          rationale: params.rationale(chunk, splitKind),
          priority: params.priority,
          tags:
            splitKind === "budget"
              ? [...new Set([...params.tags, "line_budget_split"])]
              : params.tags.length > 0
                ? params.tags
                : undefined,
        });
      }
    }

    for (const filePath of oversizedFiles) {
      const taskId = `${params.scopeId}:${params.lens}:${filePath}`;
      if (seen.has(taskId)) {
        continue;
      }
      seen.add(taskId);
      tasks.push({
        task_id: taskId,
        unit_id: params.unitId,
        pass_id: params.passId,
        lens: params.lens,
        file_paths: [filePath],
        rationale: params.rationale([filePath], "large_file"),
        priority: params.priority,
        tags:
          params.tags.length > 0
            ? [...new Set([...params.tags, "large_file"])]
            : ["large_file"],
      });
    }
  }

  const assigned = new Set<string>();
  const flowBlocks = options.critical_flows
    ? claimFlowReviewBlocks(options.critical_flows, pendingByLens, assigned)
    : [];

  for (const block of flowBlocks) {
    const hasExternalSignal = block.file_paths.some((path) => externalPaths.has(path));
    addTaskBlock({
      scopeId: `flow:${block.flow_id}`,
      unitId: `flow:${block.flow_id}`,
      passId: `flow-pass:${block.lens}`,
      lens: block.lens,
      filePaths: block.file_paths,
      priority: taskPriority(hasExternalSignal, block.lens, true),
      tags: hasExternalSignal
        ? ["critical_flow", `critical_flow:${block.flow_id}`, "external_analyzer_signal"]
        : ["critical_flow", `critical_flow:${block.flow_id}`],
      rationale: (filePaths, splitKind) =>
        splitKind === "large_file"
          ? `Audit ${filePaths[0]} (large file from critical flow ${block.flow_id}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
          : splitKind === "budget"
            ? `Audit part of critical flow ${block.flow_id} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
          : `Audit critical flow ${block.flow_id} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`,
    });
  }

  const groupedRemainders = new Map<string, { lens: Lens; unitId: string; filePaths: string[] }>();
  for (const lens of LENS_ORDER) {
    const pendingPaths = pendingByLens.get(lens);
    if (!pendingPaths || pendingPaths.size === 0) {
      continue;
    }

    for (const path of [...pendingPaths].sort((a, b) => a.localeCompare(b))) {
      if (assigned.has(`${lens}:${path}`)) {
        continue;
      }

      const lineCount = unitLineIndex[path] ?? 0;
      const isTinyTestReview =
        tinyTestFileLines > 0 &&
        lineCount <= tinyTestFileLines &&
        isTestPath(normalizeExtractorPath(path)) &&
        !externalPaths.has(path);
      const record = coverageByPath.get(path);
      const unitId = isTinyTestReview
        ? TINY_TEST_UNIT_ID
        : record?.unit_ids[0] ?? `review:${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
      const key = `${lens}|${unitId}`;
      const current = groupedRemainders.get(key) ?? {
        lens,
        unitId,
        filePaths: [],
      };
      current.filePaths.push(path);
      groupedRemainders.set(key, current);
    }
  }

  for (const block of [...groupedRemainders.values()].sort((a, b) => {
    const lensDelta = LENS_ORDER.indexOf(a.lens) - LENS_ORDER.indexOf(b.lens);
    if (lensDelta !== 0) return lensDelta;
    return a.unitId.localeCompare(b.unitId);
  })) {
    const hasExternalSignal = block.filePaths.some((path) => externalPaths.has(path));
    addTaskBlock({
      scopeId: block.unitId,
      unitId: block.unitId,
      passId: `pass:${block.lens}`,
      lens: block.lens,
      filePaths: block.filePaths,
      priority: taskPriority(hasExternalSignal, block.lens),
      tags: hasExternalSignal ? ["external_analyzer_signal"] : [],
      rationale: (filePaths, splitKind) =>
        splitKind === "large_file"
          ? `Audit ${filePaths[0]} (large file split from ${block.unitId}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
          : splitKind === "budget"
            ? `Audit part of ${block.unitId} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
          : `Audit ${block.unitId} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`,
    });
  }

  return tasks.sort((a, b) => {
    const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return a.task_id.localeCompare(b.task_id);
  });
}

/** Strip control characters and newlines, then truncate to maxLen. */
function sanitizeField(value: string, maxLen: number): string {
  return value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, maxLen).trimEnd();
}

export function buildExternalSignalTasks(
  coverageMatrix: CoverageMatrix,
  _unitLineIndex: UnitLineIndex,
  externalAnalyzerResults?: ExternalAnalyzerResults,
): AuditTask[] {
  if (!externalAnalyzerResults) {
    return [];
  }

  const tasks: AuditTask[] = [];
  const seen = new Set<string>();
  const coverageByPath = buildCoverageIndex(coverageMatrix);

  for (const result of getExternalSignalResults(externalAnalyzerResults)) {
    const safeCategory = sanitizeField(result.category, 80);
    const safePath = sanitizeField(result.path ?? "", 260);
    const safeSummary = sanitizeField(result.summary ?? "", 200);

    const lens = pickAnalyzerLens(safeCategory);
    const coverage = coverageByPath.get(result.path);
    if (!coverage || coverage.audit_status === "excluded") {
      continue;
    }

    const id = `analyzer:${externalAnalyzerResults.tool}:${lens}:${safePath}:${result.id}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);

    tasks.push({
      task_id: id,
      unit_id: coverage.unit_ids[0] ?? `analyzer:${safePath}`,
      pass_id: `analyzer:${externalAnalyzerResults.tool}:${lens}`,
      lens,
      file_paths: [result.path],
      rationale: `Analyzer follow-up for ${safePath} under the ${lens} lens because ${externalAnalyzerResults.tool} reported: ${safeSummary}`,
      priority: "high",
      tags: [
        "external_analyzer_signal",
        `external_tool:${externalAnalyzerResults.tool}`,
      ],
    });
  }

  return tasks.sort((a, b) => a.task_id.localeCompare(b.task_id));
}
