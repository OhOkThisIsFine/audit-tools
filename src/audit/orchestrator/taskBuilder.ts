import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type {
  AuditTask,
  CoverageMatrix,
  Lens,
} from "../types.js";
import type { CriticalFlowManifest } from "audit-tools/shared";
import { chunkByBudget } from "audit-tools/shared";
import { claimFlowReviewBlocks } from "./flowPlanning.js";
import { isTrivialAuditPath } from "./trivialAudit.js";
import { LENS_ORDER, priorityRank } from "./auditTaskUtils.js";
import {
  isTestPath,
  normalizeExtractorPath,
} from "../extractors/pathPatterns.js";
import { isUnmeasuredLineCount } from "../cli/lineIndex.js";

export interface UnitLineIndex {
  [path: string]: number;
}

export interface BuildChunkedTaskOptions {
  /**
   * Line count above which a single file gets its own task rather than being
   * grouped with the rest of its unit. Default: `DEFAULT_FILE_SPLIT_THRESHOLD`
   * (5000). Set to 0 to disable splitting entirely.
   */
  file_split_threshold?: number;
  /**
   * Approximate total line budget for a review task. Multi-file blocks above
   * this budget are split into multiple bounded review tasks. Default: 1500.
   * Set to 0 to disable aggregate line-budget splitting.
   */
  max_task_lines?: number;
  /**
   * Maximum number of files in one review task. Default: 0 (disabled).
   * Token budget (max_task_lines) is the real constraint; file-count splitting
   * is off by default. Set to a positive integer to re-enable.
   */
  max_task_files?: number;
  /**
   * Test files at or below this size can be batched across unit boundaries.
   * Default: 250. Set to 0 to disable tiny-test batching.
   */
  tiny_test_file_lines?: number;
  limit_lenses?: string[];
  /**
   * Lenses whose tasks should have their priority elevated by one tier
   * (low→medium, medium→high). Derived from free_form_intent at planning time;
   * never promoted above 'high'.
   */
  intent_priority_boost?: string[];
  external_analyzer_results?: ExternalAnalyzerResults[];
  critical_flows?: CriticalFlowManifest;
}

function taskPriority(
  hasExternalSignal: boolean,
  lens: string,
  isCriticalFlow = false,
  intentBoostLenses?: Set<string>,
): "high" | "medium" | "low" {
  let base: "high" | "medium" | "low";
  if (isCriticalFlow) {
    base =
      lens === "security" || lens === "reliability" || lens === "correctness"
        ? "high"
        : "medium";
  } else if (
    hasExternalSignal &&
    (lens === "security" || lens === "data_integrity" || lens === "reliability")
  ) {
    base = "high";
  } else if (hasExternalSignal) {
    base = "medium";
  } else {
    base = lens === "security" || lens === "data_integrity" ? "medium" : "low";
  }

  // Apply intent_priority_boost: elevate one tier, never above 'high'.
  if (intentBoostLenses && intentBoostLenses.has(lens)) {
    if (base === "low") return "medium";
    if (base === "medium") return "high";
    // already "high" — no change
  }
  return base;
}

const DEFAULT_FILE_SPLIT_THRESHOLD = 5000;
const DEFAULT_MAX_TASK_LINES = 3000;
const DEFAULT_MAX_TASK_FILES = 0;
const DEFAULT_TINY_TEST_FILE_LINES = 250;
const TINY_TEST_UNIT_ID = "tests-tiny-files";

type SplitKind = "none" | "large_file" | "budget";

interface TaskBudgetLimits {
  maxTaskLines: number;
  maxTaskFiles: number;
}

/**
 * The file's size when it is genuinely KNOWN, `undefined` when the index carried
 * no key for it or carried the unmeasured sentinel. Every size CLASSIFICATION in
 * this module reads through here, so "unmeasured" can never decay into a number
 * a comparison happens to accept.
 */
function measuredLinesOf(
  unitLineIndex: UnitLineIndex,
  path: string,
): number | undefined {
  const value = unitLineIndex[path];
  return isUnmeasuredLineCount(value) ? undefined : value;
}

/**
 * The file's size for BUDGET ARITHMETIC, where an unknown size contributes
 * nothing. Distinct from {@link measuredLinesOf} on purpose: the sentinel is
 * `NaN`, and letting it into a running total poisons the sum, after which every
 * `cost > budget` comparison is false and the greedy chunker silently stops
 * splitting. Zero is the right answer for "adds no known weight", and it is a
 * budgeting answer only — it never reaches a triviality verdict.
 */
function budgetLinesOf(unitLineIndex: UnitLineIndex, path: string): number {
  return measuredLinesOf(unitLineIndex, path) ?? 0;
}

// Split a flat list of file paths into review-task-sized chunks, bounded by both
// an aggregate line budget and a max file count. Thin adapter over the shared
// `chunkByBudget` greedy chunker (extracted alongside chunkPacketTasks in
// reviewPackets.ts — previously byte-identical loop shapes); the two trivial-bypass
// shortcuts (empty input, both budgets disabled) are kept as-is since they are
// cheap and avoid ever invoking the generic loop for the common unbounded case.
function chunkByTaskBudget(
  filePaths: string[],
  unitLineIndex: UnitLineIndex,
  limits: TaskBudgetLimits,
): string[][] {
  const { maxTaskLines, maxTaskFiles } = limits;
  if (filePaths.length === 0) {
    return [];
  }
  if (maxTaskLines <= 0 && maxTaskFiles <= 0) {
    return [filePaths];
  }

  return chunkByBudget(filePaths, {
    budget: maxTaskLines > 0 ? maxTaskLines : Number.POSITIVE_INFINITY,
    maxItems: maxTaskFiles > 0 ? maxTaskFiles : undefined,
    costOf: (candidate) =>
      candidate.reduce((sum, path) => sum + budgetLinesOf(unitLineIndex, path), 0),
  });
}

// Emit one or more audit tasks for a scope/lens. Normal-sized files are grouped
// into budget-bounded chunks; files over `fileSplitThreshold` get their own
// isolated task. Hoisted to module scope: the per-call mutable accumulators
// (`tasks`, `seen`) and budget config are now explicit parameters instead of
// captured closure state.
function addTaskBlock(
  params: {
    scopeId: string;
    unitId: string;
    passId: string;
    lens: string;
    filePaths: string[];
    priority: AuditTask["priority"];
    tags: string[];
    rationale: (filePaths: string[], splitKind: SplitKind) => string;
  },
  context: {
    tasks: AuditTask[];
    seen: Set<string>;
    unitLineIndex: UnitLineIndex;
    fileSplitThreshold: number;
    budgetLimits: TaskBudgetLimits;
    unmeasuredPaths: ReadonlySet<string>;
  },
): void {
  const { tasks, seen, unitLineIndex, fileSplitThreshold, budgetLimits, unmeasuredPaths } =
    context;

  // Tags for one emitted task. `unmeasured_line_count` is the explicit LEAD an
  // unmeasured `unitLineIndex` entry earns (see `buildPendingByLens`): the file
  // is still reviewed, but the task says out loud that its size was never
  // measured, so a downstream consumer can tell "unmeasured" from "measured and
  // small".
  const tagsFor = (chunk: string[], extra: string[]): string[] | undefined => {
    const lead = chunk.some((path) => unmeasuredPaths.has(path))
      ? ["unmeasured_line_count"]
      : [];
    const merged = [...new Set([...params.tags, ...extra, ...lead])];
    return merged.length > 0 ? merged : undefined;
  };
  const oversizedFiles =
    fileSplitThreshold > 0
      ? params.filePaths.filter(
          (path) => budgetLinesOf(unitLineIndex, path) > fileSplitThreshold,
        )
      : [];
  const oversizedSet = new Set(oversizedFiles);
  const normalFiles = params.filePaths.filter((path) => !oversizedSet.has(path));

  const normalChunks = chunkByTaskBudget(normalFiles, unitLineIndex, budgetLimits);
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
        tags: tagsFor(chunk, splitKind === "budget" ? ["line_budget_split"] : []),
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
      tags: tagsFor([filePath], ["large_file"]),
    });
  }
}

function withSignalTag(baseTags: string[], hasExternalSignal: boolean): string[] {
  return hasExternalSignal ? [...baseTags, "external_analyzer_signal"] : baseTags;
}

function getExternalSignalPaths(
  externalAnalyzerResults?: ExternalAnalyzerResults[],
): Set<string> {
  const results = (externalAnalyzerResults ?? []).flatMap((tool) =>
    Array.isArray(tool.results) ? tool.results : [],
  );
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

/**
 * Resolve option defaults and build the map of pending (file path → lens)
 * pairs from the coverage matrix, filtering out excluded files, completed
 * lenses, lens-filter violations, and trivial audit paths.
 *
 * AN UNMEASURED LINE COUNT IS NOT A ZERO LINE COUNT. This resolved size as
 * `unitLineIndex[file.path] ?? 0` and handed it to `isTrivialAuditPath`, whose
 * `lineCount === 0` branch then classified the file trivial and `continue`d past
 * it. Unlike `autoCompleteTrivialCoverage`, which marks a trivial file `excluded`
 * in the coverage matrix, this loop leaves the record untouched: the file got no
 * task, kept its non-empty `required_lenses`, and stayed reported outstanding
 * forever — a silent permanent coverage hole indistinguishable from "still
 * queued".
 *
 * The size question is now answered in ONE place — `isTrivialAuditPath` reads
 * through the shared `isUnmeasuredLineCount` predicate — so this loop does NOT
 * gate the triviality call on measuredness: a file that is trivial by NAME stays
 * trivial when nobody could measure it. What the unmeasured signal buys is the
 * LEAD: a surviving unmeasured path is collected into `unmeasuredPaths`, and
 * every task carrying it is tagged `unmeasured_line_count`.
 *
 * This is the SECOND of the two sites that decide the fate of an unmeasured
 * file, and the later one. `autoCompleteTrivialCoverage` runs first
 * (planningExecutors.ts) and excludes from the coverage matrix; leniency here
 * alone would be unreachable, because the `audit_status === "excluded"` guard
 * above would already have skipped the file. Both sites are fixed together.
 */
function buildPendingByLens(
  coverageMatrix: CoverageMatrix,
  unitLineIndex: UnitLineIndex,
  externalPaths: Set<string>,
  options: {
    limit_lenses?: string[];
    enforceLensFilter: boolean;
    tinyTestFileLines: number;
  },
): { pendingByLens: Map<string, Set<string>>; unmeasuredPaths: Set<string> } {
  const allowed = new Set(options.limit_lenses ?? []);
  const pendingByLens = new Map<string, Set<string>>();
  const unmeasuredPaths = new Set<string>();

  for (const file of coverageMatrix.files) {
    if (file.audit_status === "excluded") {
      continue;
    }
    const unmeasured = isUnmeasuredLineCount(unitLineIndex[file.path]);
    for (const lens of file.required_lenses) {
      if (file.completed_lenses.includes(lens)) {
        continue;
      }
      if (options.enforceLensFilter && !allowed.has(lens)) {
        continue;
      }
      if (
        isTrivialAuditPath(
          file.path,
          unitLineIndex[file.path],
          externalPaths.has(file.path),
        )
      ) {
        continue;
      }
      if (unmeasured) {
        unmeasuredPaths.add(file.path);
      }
      const pending = pendingByLens.get(lens) ?? new Set<string>();
      pending.add(file.path);
      pendingByLens.set(lens, pending);
    }
  }
  return { pendingByLens, unmeasuredPaths };
}

/**
 * Group remainder (non-flow) pending paths by lens+unit into review blocks,
 * skipping paths already assigned to a flow block.
 */
function buildRemainderBlocks(
  pendingByLens: ReadonlyMap<string, ReadonlySet<string>>,
  assigned: ReadonlySet<string>,
  coverageByPath: Map<string, CoverageMatrix["files"][number]>,
  unitLineIndex: UnitLineIndex,
  externalPaths: Set<string>,
  tinyTestFileLines: number,
): Array<{ lens: Lens; unitId: string; filePaths: string[] }> {
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
      // An UNMEASURED file is not known-small, so it is never batched as a tiny
      // test: `measuredLinesOf` yields undefined and the comparison is skipped.
      const lineCount = measuredLinesOf(unitLineIndex, path);
      const isTinyTestReview =
        tinyTestFileLines > 0 &&
        lineCount !== undefined &&
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
  return [...groupedRemainders.values()].sort((a, b) => {
    const lensDelta = LENS_ORDER.indexOf(a.lens) - LENS_ORDER.indexOf(b.lens);
    if (lensDelta !== 0) return lensDelta;
    return a.unitId.localeCompare(b.unitId);
  });
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
  const externalPaths = getExternalSignalPaths(options.external_analyzer_results);

  // Phase 1: resolve pending work by lens.
  const { pendingByLens, unmeasuredPaths } = buildPendingByLens(
    coverageMatrix,
    unitLineIndex,
    externalPaths,
    {
      limit_lenses: options.limit_lenses,
      enforceLensFilter,
      tinyTestFileLines,
    },
  );

  const intentBoostSet =
    options.intent_priority_boost && options.intent_priority_boost.length > 0
      ? new Set<string>(options.intent_priority_boost)
      : undefined;

  const tasks: AuditTask[] = [];
  const seen = new Set<string>();
  const budgetLimits: TaskBudgetLimits = { maxTaskLines, maxTaskFiles };
  const taskBlockContext = {
    tasks,
    seen,
    unitLineIndex,
    fileSplitThreshold,
    budgetLimits,
    unmeasuredPaths,
  };

  // Phase 2: claim critical-flow review blocks first (highest priority).
  //
  // ONE KEY SPACE, SATISFIED BY CONSTRUCTION — NOT BY RE-KEYING HERE.
  // `claimFlowReviewBlocks` declares that every path it joins on is already in
  // one key space. It is, and this call site is where that reading is recorded:
  //
  //   - Coverage paths, line-index keys and critical-flow paths all descend from
  //     the SAME repo manifest, which `fsIntake` emits posix-normal. They are one
  //     key space at the source; re-normalizing copies of them here would create a
  //     SECOND one, since the persisted coverage matrix, the persisted line index
  //     and result ingestion (`applyFileCoverage`) all stay keyed on the original
  //     strings — a divergence with no live route to close.
  //   - The one genuinely FOREIGN path surface is a worker-supplied string copied
  //     into a followup task's `file_paths`. That never enters here; it enters at
  //     validation, where `validateAuditResults` normalizes both sides of the
  //     coverage join tolerantly. That is where the key-space fix belongs and
  //     where it is pinned.
  //
  // THE CLAIM CONTRACT IS THE ONLY CHANNEL (`artifact:flow-claim-contract`).
  // `claimFlowReviewBlocks` writes nothing back through its arguments, so the
  // post-claim state must be read off the RETURN value: `claim.pending` is the
  // pending map with every claimed path removed, `claim.assigned` the claim keys.
  // Reading the pre-claim arguments instead re-emits every flow-claimed path as
  // a remainder task — the same lens:path reviewed twice.
  const claim = options.critical_flows
    ? claimFlowReviewBlocks(options.critical_flows, pendingByLens, new Set<string>())
    : undefined;
  const flowBlocks = claim ?? [];
  const remainingPending: ReadonlyMap<string, ReadonlySet<string>> =
    claim?.pending ?? pendingByLens;
  const assigned: ReadonlySet<string> = claim?.assigned ?? new Set<string>();

  for (const block of flowBlocks) {
    const hasExternalSignal = block.file_paths.some((path) => externalPaths.has(path));
    addTaskBlock({
      scopeId: `flow:${block.flow_id}`,
      unitId: `flow:${block.flow_id}`,
      passId: `flow-pass:${block.lens}`,
      lens: block.lens,
      filePaths: block.file_paths,
      priority: taskPriority(hasExternalSignal, block.lens, true, intentBoostSet),
      tags: withSignalTag(["critical_flow", `critical_flow:${block.flow_id}`], hasExternalSignal),
      rationale: (filePaths, splitKind) =>
        splitKind === "large_file"
          ? `Audit ${filePaths[0]} (large file from critical flow ${block.flow_id}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
          : splitKind === "budget"
            ? `Audit part of critical flow ${block.flow_id} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
            : `Audit critical flow ${block.flow_id} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`,
    }, taskBlockContext);
  }

  // Phase 3: group and emit remainder tasks (files not assigned to a flow block).
  const coverageByPath = new Map(coverageMatrix.files.map((file) => [file.path, file]));
  const remainderBlocks = buildRemainderBlocks(
    remainingPending,
    assigned,
    coverageByPath,
    unitLineIndex,
    externalPaths,
    tinyTestFileLines,
  );

  for (const block of remainderBlocks) {
    const hasExternalSignal = block.filePaths.some((path) => externalPaths.has(path));
    addTaskBlock({
      scopeId: block.unitId,
      unitId: block.unitId,
      passId: `pass:${block.lens}`,
      lens: block.lens,
      filePaths: block.filePaths,
      priority: taskPriority(hasExternalSignal, block.lens, false, intentBoostSet),
      tags: withSignalTag([], hasExternalSignal),
      rationale: (filePaths, splitKind) =>
        splitKind === "large_file"
          ? `Audit ${filePaths[0]} (large file split from ${block.unitId}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
          : splitKind === "budget"
            ? `Audit part of ${block.unitId} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`
            : `Audit ${block.unitId} (${filePaths.length} file${filePaths.length === 1 ? "" : "s"}) under the ${block.lens} lens.${hasExternalSignal ? " External analyzer signals raise priority." : ""}`,
    }, taskBlockContext);
  }

  // Phase 4: sort by priority descending, then stable by task_id.
  return tasks.sort((a, b) => {
    const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return a.task_id.localeCompare(b.task_id);
  });
}

