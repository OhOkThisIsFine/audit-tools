import { createHash } from "node:crypto";
import type { AuditTask, Lens } from "../types.js";
import type {
  AuditPlanMetrics,
  ReviewPacket,
  WeaklyExplainedPacketSample,
} from "../types/reviewPlanning.js";
import type { GraphBundle, GraphEdge } from "@audit-tools/shared";
import { LENS_ORDER, priorityRank, sortLenses } from "./auditTaskUtils.js";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";
import {
  DEFAULT_MAX_TASKS_PER_PACKET,
  DEFAULT_TARGET_PACKET_TOKENS,
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  sizeIndexFromManifest,
  fileGroupContentTokens,
  taskContentTokens,
  estimateTaskGroupTokens,
} from "./reviewPacketSizing.js";
import {
  HIGH_FAN_DEGREE_THRESHOLD,
  collectGraphEdges,
  buildGraphDegreeIndex,
  isPacketExpansionEdge,
  buildFileToGroupKeys,
  isConcreteGraphEdge,
  unionFindFromGroups,
  roundQuality,
  buildPlanningGraphEdges,
  buildPacketGraphContext,
} from "./reviewPacketGraph.js";
import { sanitizeSegment } from "./selectiveDeepening/shared.js";

// Re-exported for scope.ts, which imports the canonical path normalizer here.
export { normalizeGraphPath };

// Sizing / token-budget arithmetic moved to reviewPacketSizing.ts; re-exported
// here for the modules that import it from reviewPackets.
export {
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  sizeIndexFromManifest,
  estimateTaskGroupTokens,
};

const MAX_WEAK_PACKET_SAMPLES = 12;
const MAX_WEAK_PACKET_SAMPLE_FILES = 8;
const WEAK_PACKET_GAP_ORDER: WeaklyExplainedPacketSample["primary_gap"][] = [
  "missing_internal_edges",
  "unexplained_files",
  "partial_cohesion",
];

export interface BuildReviewPacketOptions {
  graphBundle?: GraphBundle;
  lineIndex?: Record<string, number>;
  /** Path → size_bytes (from the repo manifest); drives byte-based token sizing. */
  sizeIndex?: Record<string, number>;
  maxTasksPerPacket?: number;
  /**
   * Soft per-packet content-token budget. Defaults to
   * DEFAULT_TARGET_PACKET_TOKENS. A packet is split when its estimated content
   * tokens would exceed this budget.
   */
  targetPacketTokens?: number;
  /**
   * Available context budget in tokens (context_tokens − reserved_output_tokens).
   * When provided, targetPacketTokens is capped to fit within this budget so a
   * packet's estimated tokens never exceed it.
   */
  maxContextTokens?: number;
}

interface ReviewPacketPlanningData {
  graphEdges: GraphEdge[];
  groups: Map<string, AuditTask[]>;
  planningGraphEdges: GraphEdge[];
  packets: ReviewPacket[];
}

function normalizePriority(priority: AuditTask["priority"]): NonNullable<AuditTask["priority"]> {
  return priority ?? "low";
}

function lineCountForPath(
  task: AuditTask,
  path: string,
  lineIndex?: Record<string, number>,
): number {
  return task.file_line_counts?.[path] ?? lineIndex?.[path] ?? 0;
}

function taskLineCount(
  task: AuditTask,
  lineIndex?: Record<string, number>,
): number {
  return task.file_paths.reduce(
    (sum, path) => sum + lineCountForPath(task, path, lineIndex),
    0,
  );
}

function taskFileSignature(task: AuditTask): string {
  return [...new Set(task.file_paths)].sort((a, b) => a.localeCompare(b)).join("\0");
}

function packetGroupingKey(task: AuditTask): string {
  const criticalFlowTag = task.tags?.find((tag) =>
    tag.startsWith("critical_flow:"),
  );
  const scope = criticalFlowTag ?? task.unit_id;
  return `${scope}\0${taskFileSignature(task)}`;
}

function buildTaskGroups(tasks: AuditTask[]): Map<string, AuditTask[]> {
  const groups = new Map<string, AuditTask[]>();
  for (const task of tasks) {
    const key = packetGroupingKey(task);
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }
  return groups;
}


function packetIdFor(tasks: AuditTask[], packetIndex: number): string {
  const unit = sanitizeSegment(tasks[0]?.unit_id ?? "review");
  const lenses = sortLenses(tasks.map((task) => task.lens)).join("-");
  const hash = createHash("sha1")
    .update(tasks.map((task) => task.task_id).join("\0"))
    .digest("hex")
    .slice(0, 10);
  return `${unit}:${lenses}:packet-${packetIndex + 1}-${hash}`;
}

function compareTasksForPacket(a: AuditTask, b: AuditTask): number {
  const aIdx = LENS_ORDER.indexOf(a.lens as Lens);
  const bIdx = LENS_ORDER.indexOf(b.lens as Lens);
  const lensDelta = (aIdx === -1 ? LENS_ORDER.length : aIdx) - (bIdx === -1 ? LENS_ORDER.length : bIdx);
  if (lensDelta !== 0) return lensDelta;
  return a.task_id.localeCompare(b.task_id);
}

function comparePackets(a: ReviewPacket, b: ReviewPacket): number {
  const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
  if (priorityDelta !== 0) return priorityDelta;
  const sizeDelta = b.task_ids.length - a.task_ids.length;
  if (sizeDelta !== 0) return sizeDelta;
  return a.packet_id.localeCompare(b.packet_id);
}

function chunkPacketTasks(
  tasks: AuditTask[],
  options: Required<Pick<BuildReviewPacketOptions, "maxTasksPerPacket" | "targetPacketTokens">> &
    Pick<BuildReviewPacketOptions, "lineIndex" | "sizeIndex">,
): AuditTask[][] {
  const chunks: AuditTask[][] = [];
  let current: AuditTask[] = [];
  const verbose = Boolean(process.env.AUDIT_CODE_VERBOSE);

  for (const task of tasks.sort(compareTasksForPacket)) {
    const taskEstimatedTokens = taskContentTokens(task, options.sizeIndex, options.lineIndex);
    const isolatedLargeFileTask =
      task.file_paths.length === 1 &&
      taskEstimatedTokens > options.targetPacketTokens;
    if (isolatedLargeFileTask) {
      if (current.length > 0) {
        chunks.push(current);
        current = [];
      }
      if (verbose) {
        process.stderr.write(
          `[audit-code:packet-planning] isolated large-file chunk: task="${task.task_id}" file="${task.file_paths[0]}" estimatedTokens=${taskEstimatedTokens} targetPacketTokens=${options.targetPacketTokens}\n`,
        );
      }
      chunks.push([task]);
      continue;
    }

    const candidate = [...current, task];
    const uniquePaths = new Set(candidate.flatMap((item) => item.file_paths));
    const candidateContentTokens = fileGroupContentTokens(
      uniquePaths,
      candidate,
      options.sizeIndex,
      options.lineIndex,
    );
    const wouldExceedTaskCount =
      options.maxTasksPerPacket > 0 && current.length > 0 && candidate.length > options.maxTasksPerPacket;
    const wouldExceedTokens =
      current.length > 0 && candidateContentTokens > options.targetPacketTokens;

    if (wouldExceedTaskCount || wouldExceedTokens) {
      if (verbose && wouldExceedTokens) {
        process.stderr.write(
          `[audit-code:packet-planning] token-budget split: task="${task.task_id}" file="${task.file_paths[0] ?? ""}" candidateContentTokens=${candidateContentTokens} targetPacketTokens=${options.targetPacketTokens}\n`,
        );
      }
      chunks.push(current);
      current = [];
    }

    current.push(task);
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function directoryOfPath(filePath: string): string {
  const lastSlash = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\"),
  );
  return lastSlash > 0 ? filePath.slice(0, lastSlash) : "";
}

function directoryDepth(dir: string): number {
  if (!dir) return 0;
  return dir.split(/[/\\]/).length;
}

function groupDirectories(tasks: AuditTask[], minDepth: number): Set<string> {
  const dirs = new Set<string>();
  for (const task of tasks) {
    for (const fp of task.file_paths) {
      const dir = directoryOfPath(fp);
      if (directoryDepth(dir) >= minDepth) {
        dirs.add(dir);
      }
    }
  }
  return dirs;
}

function mergeByDirectoryProximity(
  groups: AuditTask[][],
  targetPacketTokens: number,
  sizeIndex?: Record<string, number>,
  lineIndex?: Record<string, number>,
): AuditTask[][] {
  const verbose = Boolean(process.env.AUDIT_CODE_VERBOSE);
  const groupTokens = groups.map((tasks) =>
    fileGroupContentTokens(
      new Set(tasks.flatMap((t) => t.file_paths)),
      tasks,
      sizeIndex,
      lineIndex,
    ),
  );

  const dirToGroups = new Map<string, Set<number>>();
  for (let i = 0; i < groups.length; i++) {
    for (const dir of groupDirectories(groups[i], 3)) {
      const set = dirToGroups.get(dir) ?? new Set();
      set.add(i);
      dirToGroups.set(dir, set);
    }
  }

  const canonical = groups.map((_, i) => i);
  const find = (i: number): number => {
    while (canonical[i] !== i) {
      canonical[i] = canonical[canonical[i]];
      i = canonical[i];
    }
    return i;
  };

  const sortedDirs = [...dirToGroups.entries()]
    .filter(([, indices]) => indices.size > 1)
    .sort(([a], [b]) => directoryDepth(b) - directoryDepth(a));

  for (const [dir, indices] of sortedDirs) {
    const roots = [...new Set([...indices].map(find))];
    if (roots.length < 2) continue;
    roots.sort((a, b) => groupTokens[a] - groupTokens[b]);

    const target = roots[0];
    for (let i = 1; i < roots.length; i++) {
      const source = find(roots[i]);
      if (find(target) === source) continue;
      const t = find(target);
      const combined = groupTokens[t] + groupTokens[source];
      if (combined <= targetPacketTokens) {
        if (verbose) {
          process.stderr.write(
            `[audit-code:packet-planning] directory-proximity merge: dir="${dir}" combined=${combined} budget=${targetPacketTokens}\n`,
          );
        }
        groups[t] = [...groups[t], ...groups[source]];
        groups[source] = [];
        groupTokens[t] = combined;
        groupTokens[source] = 0;
        canonical[source] = t;
      }
    }
  }

  return groups.filter((g) => g.length > 0);
}

interface MergeGroupsOptions {
  targetPacketTokens?: number;
  sizeIndex?: Record<string, number>;
  lineIndex?: Record<string, number>;
}

function mergeGraphConnectedGroups(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
  options?: MergeGroupsOptions,
): AuditTask[][] {
  const uf = unionFindFromGroups(groups, graphEdges);

  const merged = new Map<string, AuditTask[]>();
  for (const key of groups.keys()) {
    const root = uf.find(key);
    const current = merged.get(root) ?? [];
    current.push(...(groups.get(key) ?? []));
    merged.set(root, current);
  }

  let result = [...merged.values()];

  if (options?.targetPacketTokens) {
    result = mergeByDirectoryProximity(
      result,
      options.targetPacketTokens,
      options.sizeIndex,
      options.lineIndex,
    );
  }

  return result;
}

function buildPacket(
  tasks: AuditTask[],
  packetIndex: number,
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  graphEdges: GraphEdge[] = [],
  graphBundle?: GraphBundle,
): ReviewPacket {
  const filePaths = [...new Set(tasks.flatMap((task) => task.file_paths))].sort(
    (a, b) => a.localeCompare(b),
  );
  const graphContext = buildPacketGraphContext(
    filePaths,
    graphEdges,
    graphBundle,
  );
  const fileLineCounts = Object.fromEntries(
    filePaths.map((path) => {
      const owner = tasks.find((task) => task.file_paths.includes(path));
      return [path, owner ? lineCountForPath(owner, path, lineIndex) : 0];
    }),
  );
  const totalLines = Object.values(fileLineCounts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const estimatedTokens =
    ESTIMATED_PACKET_PROMPT_TOKENS +
    fileGroupContentTokens(filePaths, tasks, sizeIndex, lineIndex);
  const priority = tasks.reduce<NonNullable<AuditTask["priority"]>>(
    (highest, task) =>
      priorityRank(task.priority) > priorityRank(highest)
        ? normalizePriority(task.priority)
        : highest,
    "low",
  );
  const lenses = sortLenses(tasks.map((task) => task.lens));
  const tags = [
    ...new Set(tasks.flatMap((task) => task.tags ?? [])),
  ].sort((a, b) => a.localeCompare(b));
  const baseRationale =
    tasks.length === 1
      ? tasks[0]!.rationale
      : `Review ${filePaths.length} related file(s) across ${lenses.length} lens(es): ${lenses.join(", ")}.`;
  const graphRationale =
    graphContext.keyEdges.length > 0
      ? ` Key graph edges explain ${graphContext.keyEdges.length} internal relationship(s).`
      : graphContext.boundaryFiles.length > 0
        ? ` Boundary context is available for ${graphContext.boundaryFiles.length} adjacent file(s).`
        : "";

  return {
    packet_id: packetIdFor(tasks, packetIndex),
    task_ids: tasks.map((task) => task.task_id),
    unit_ids: [...new Set(tasks.map((task) => task.unit_id))].sort((a, b) =>
      a.localeCompare(b),
    ),
    pass_ids: [...new Set(tasks.map((task) => task.pass_id))].sort((a, b) =>
      a.localeCompare(b),
    ),
    lenses,
    file_paths: filePaths,
    file_line_counts: fileLineCounts,
    total_lines: totalLines,
    priority,
    tags: tags.length > 0 ? tags : undefined,
    entrypoints:
      graphContext.entrypoints.length > 0
        ? graphContext.entrypoints
        : undefined,
    key_edges:
      graphContext.keyEdges.length > 0 ? graphContext.keyEdges : undefined,
    boundary_files:
      graphContext.boundaryFiles.length > 0
        ? graphContext.boundaryFiles
        : undefined,
    quality: graphContext.quality,
    rationale: `${baseRationale}${graphRationale}`,
    estimated_tokens: estimatedTokens,
  };
}

function buildReviewPacketPlanningData(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): ReviewPacketPlanningData {
  const maxTasksPerPacket = options.maxTasksPerPacket ?? DEFAULT_MAX_TASKS_PER_PACKET;
  const configuredTargetTokens =
    options.targetPacketTokens ?? DEFAULT_TARGET_PACKET_TOKENS;
  const targetPacketTokens =
    options.maxContextTokens != null
      ? Math.min(
          configuredTargetTokens,
          Math.max(1, options.maxContextTokens - ESTIMATED_PACKET_PROMPT_TOKENS),
        )
      : configuredTargetTokens;
  const graphEdges = collectGraphEdges(options.graphBundle);
  const groups = buildTaskGroups(tasks);

  const planningGraphEdges = buildPlanningGraphEdges(
    groups,
    graphEdges,
    options.graphBundle,
    options.lineIndex,
    options.sizeIndex,
    targetPacketTokens,
  );

  const packets: ReviewPacket[] = [];
  let packetIndex = 0;
  const groupedTasks = mergeGraphConnectedGroups(
    groups,
    planningGraphEdges,
    { targetPacketTokens, sizeIndex: options.sizeIndex, lineIndex: options.lineIndex },
  ).sort((a, b) => {
    const aPriority = Math.max(...a.map((task) => priorityRank(task.priority)));
    const bPriority = Math.max(...b.map((task) => priorityRank(task.priority)));
    if (aPriority !== bPriority) return bPriority - aPriority;
    return (a[0]?.task_id ?? "").localeCompare(b[0]?.task_id ?? "");
  });

  for (const group of groupedTasks) {
    for (const chunk of chunkPacketTasks(group, {
      lineIndex: options.lineIndex,
      sizeIndex: options.sizeIndex,
      maxTasksPerPacket,
      targetPacketTokens,
    })) {
      packets.push(
        buildPacket(
          chunk,
          packetIndex,
          options.lineIndex,
          options.sizeIndex,
          planningGraphEdges,
          options.graphBundle,
        ),
      );
      packetIndex += 1;
    }
  }

  return {
    graphEdges,
    groups,
    planningGraphEdges,
    packets: packets.sort(comparePackets),
  };
}

export function buildReviewPackets(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): ReviewPacket[] {
  return buildReviewPacketPlanningData(tasks, options).packets;
}

export function orderTasksForPacketReview(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): AuditTask[] {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  return buildReviewPackets(tasks, options).flatMap((packet) =>
    packet.task_ids
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is AuditTask => task !== undefined),
  );
}

function countHighDegreeTaskFiles(
  degreeMap: Map<string, number>,
  taskFiles: Set<string>,
): number {
  let count = 0;
  for (const [path, degree] of degreeMap) {
    if (degree > HIGH_FAN_DEGREE_THRESHOLD && taskFiles.has(path)) {
      count += 1;
    }
  }
  return count;
}

function edgeKindKey(edge: GraphEdge): string {
  const kind = edge.kind?.trim();
  return kind && kind.length > 0 ? kind : "unknown";
}

function edgeIdentity(edge: GraphEdge): string {
  return [
    normalizeGraphPath(edge.from),
    normalizeGraphPath(edge.to),
    edgeKindKey(edge),
  ].join("\0");
}

function incrementEdgeKindCount(
  counts: Record<string, number>,
  edge: GraphEdge,
): void {
  const key = edgeKindKey(edge);
  counts[key] = (counts[key] ?? 0) + 1;
}

function sortCountRecord(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function buildTaskToGroupKey(
  groups: Map<string, AuditTask[]>,
): Map<string, string> {
  const taskToGroupKey = new Map<string, string>();
  for (const [groupKey, tasks] of groups) {
    for (const task of tasks) {
      taskToGroupKey.set(task.task_id, groupKey);
    }
  }
  return taskToGroupKey;
}

function buildGroupToPacketIds(
  packets: ReviewPacket[],
  groups: Map<string, AuditTask[]>,
): Map<string, Set<string>> {
  const taskToGroupKey = buildTaskToGroupKey(groups);
  const groupToPacketIds = new Map<string, Set<string>>();

  for (const packet of packets) {
    const packetGroupKeys = new Set(
      packet.task_ids
        .map((taskId) => taskToGroupKey.get(taskId))
        .filter((groupKey): groupKey is string => groupKey !== undefined),
    );
    for (const groupKey of packetGroupKeys) {
      const packetIds = groupToPacketIds.get(groupKey) ?? new Set<string>();
      packetIds.add(packet.packet_id);
      groupToPacketIds.set(groupKey, packetIds);
    }
  }

  return groupToPacketIds;
}

function setsOverlap<T>(a?: Set<T>, b?: Set<T>): boolean {
  if (!a || !b) {
    return false;
  }
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

function countMergeEdgeKinds(
  packets: ReviewPacket[],
  groups: Map<string, AuditTask[]>,
  planningGraphEdges: GraphEdge[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const fileToGroupKeys = buildFileToGroupKeys(groups);
  const groupToPacketIds = buildGroupToPacketIds(packets, groups);
  const degreeIndex = buildGraphDegreeIndex(planningGraphEdges);

  for (const edge of planningGraphEdges) {
    if (!isPacketExpansionEdge(edge, degreeIndex)) {
      continue;
    }
    const fromGroups = fileToGroupKeys.get(normalizeGraphPath(edge.from));
    const toGroups = fileToGroupKeys.get(normalizeGraphPath(edge.to));
    if (!fromGroups || !toGroups) {
      continue;
    }

    let mergedDistinctGroups = false;
    for (const fromKey of fromGroups) {
      for (const toKey of toGroups) {
        if (
          fromKey !== toKey &&
          setsOverlap(
            groupToPacketIds.get(fromKey),
            groupToPacketIds.get(toKey),
          )
        ) {
          mergedDistinctGroups = true;
          break;
        }
      }
      if (mergedDistinctGroups) {
        break;
      }
    }

    const identity = edgeIdentity(edge);
    if (mergedDistinctGroups && !seen.has(identity)) {
      seen.add(identity);
      incrementEdgeKindCount(counts, edge);
    }
  }

  return sortCountRecord(counts);
}

function buildFileToPacketIds(
  packets: ReviewPacket[],
): Map<string, Set<string>> {
  const fileToPacketIds = new Map<string, Set<string>>();
  for (const packet of packets) {
    for (const path of packet.file_paths) {
      const normalized = normalizeGraphPath(path);
      const packetIds = fileToPacketIds.get(normalized) ?? new Set<string>();
      packetIds.add(packet.packet_id);
      fileToPacketIds.set(normalized, packetIds);
    }
  }
  return fileToPacketIds;
}

function countBoundaryOnlyEdgeKinds(
  packets: ReviewPacket[],
  planningGraphEdges: GraphEdge[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const fileToPacketIds = buildFileToPacketIds(packets);

  for (const edge of planningGraphEdges) {
    if (!isConcreteGraphEdge(edge)) {
      continue;
    }
    const fromPacketIds = fileToPacketIds.get(normalizeGraphPath(edge.from));
    const toPacketIds = fileToPacketIds.get(normalizeGraphPath(edge.to));
    if (!fromPacketIds && !toPacketIds) {
      continue;
    }
    if (setsOverlap(fromPacketIds, toPacketIds)) {
      continue;
    }

    const identity = edgeIdentity(edge);
    if (!seen.has(identity)) {
      seen.add(identity);
      incrementEdgeKindCount(counts, edge);
    }
  }

  return sortCountRecord(counts);
}

function isWeaklyExplainedPacket(packet: ReviewPacket): boolean {
  return (
    packet.file_paths.length > 1 &&
    (packet.quality.internal_edge_count === 0 ||
      packet.quality.cohesion_score < 1 ||
      packet.quality.unexplained_file_count > 0)
  );
}

function weaklyExplainedPackets(packets: ReviewPacket[]): ReviewPacket[] {
  return packets.filter(isWeaklyExplainedPacket);
}

function weaklyExplainedPacketIds(weakPackets: ReviewPacket[]): string[] {
  return weakPackets
    .map((packet) => packet.packet_id)
    .sort((a, b) => a.localeCompare(b));
}

function weakPacketPrimaryGap(
  packet: ReviewPacket,
): WeaklyExplainedPacketSample["primary_gap"] {
  if (packet.quality.internal_edge_count === 0) {
    return "missing_internal_edges";
  }
  if (packet.quality.unexplained_file_count > 0) {
    return "unexplained_files";
  }
  return "partial_cohesion";
}

function weaklyExplainedGapCounts(
  weakPackets: ReviewPacket[],
): AuditPlanMetrics["packet_quality"]["weakly_explained_gap_counts"] {
  const counts: AuditPlanMetrics["packet_quality"]["weakly_explained_gap_counts"] =
    {
      missing_internal_edges: 0,
      unexplained_files: 0,
      partial_cohesion: 0,
    };

  for (const packet of weakPackets) {
    counts[weakPacketPrimaryGap(packet)] += 1;
  }

  return Object.fromEntries(
    WEAK_PACKET_GAP_ORDER.map((gap) => [gap, counts[gap]]),
  ) as AuditPlanMetrics["packet_quality"]["weakly_explained_gap_counts"];
}

function fileExtensionBucket(path: string): string {
  const basename = normalizeGraphPath(path).split("/").at(-1) ?? "";
  const extensionStart = basename.lastIndexOf(".");
  if (extensionStart <= 0 || extensionStart === basename.length - 1) {
    return "no_extension";
  }
  return basename.slice(extensionStart).toLowerCase();
}

function weaklyExplainedFileExtensionCounts(
  weakPackets: ReviewPacket[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const seenPaths = new Set<string>();

  for (const packet of weakPackets) {
    for (const path of packet.file_paths) {
      const normalized = normalizeGraphPath(path);
      if (seenPaths.has(normalized)) {
        continue;
      }
      seenPaths.add(normalized);
      const extension = fileExtensionBucket(path);
      counts[extension] = (counts[extension] ?? 0) + 1;
    }
  }

  return sortCountRecord(counts);
}

function weaklyExplainedPacketSamples(
  weakPackets: ReviewPacket[],
): WeaklyExplainedPacketSample[] {
  return weakPackets
    .sort(
      (a, b) =>
        b.quality.unexplained_file_count - a.quality.unexplained_file_count ||
        a.quality.cohesion_score - b.quality.cohesion_score ||
        b.file_paths.length - a.file_paths.length ||
        a.packet_id.localeCompare(b.packet_id),
    )
    .slice(0, MAX_WEAK_PACKET_SAMPLES)
    .map((packet) => ({
      packet_id: packet.packet_id,
      primary_gap: weakPacketPrimaryGap(packet),
      file_count: packet.file_paths.length,
      sample_file_paths: packet.file_paths.slice(0, MAX_WEAK_PACKET_SAMPLE_FILES),
      cohesion_score: packet.quality.cohesion_score,
      internal_edge_count: packet.quality.internal_edge_count,
      boundary_edge_count: packet.quality.boundary_edge_count,
      unexplained_file_count: packet.quality.unexplained_file_count,
    }));
}

function buildPacketQualityMetrics(
  packets: ReviewPacket[],
  tasks: AuditTask[],
  graphEdges: GraphEdge[],
  planningGraphEdges: GraphEdge[],
  groups: Map<string, AuditTask[]>,
): AuditPlanMetrics["packet_quality"] {
  const packetTaskIds = new Set(packets.flatMap((packet) => packet.task_ids));
  const orphanTaskCount = tasks.filter(
    (task) => !packetTaskIds.has(task.task_id),
  ).length;
  const degreeIndex = buildGraphDegreeIndex(graphEdges);
  const taskFiles = new Set(
    tasks.flatMap((task) => task.file_paths.map(normalizeGraphPath)),
  );
  const largestUnexplainedPacket = packets.reduce<ReviewPacket | undefined>(
    (largest, packet) =>
      !largest ||
      packet.quality.unexplained_file_count >
        largest.quality.unexplained_file_count
        ? packet
        : largest,
    undefined,
  );
  const largestUnexplainedFiles =
    largestUnexplainedPacket?.quality.unexplained_file_count ?? 0;
  const weakPackets = weaklyExplainedPackets(packets);
  const weakPacketIds = weaklyExplainedPacketIds(weakPackets);
  const weakPacketSamples = weaklyExplainedPacketSamples(weakPackets);

  return {
    average_cohesion_score:
      packets.length > 0
        ? roundQuality(
            packets.reduce(
              (sum, packet) => sum + packet.quality.cohesion_score,
              0,
            ) / packets.length,
          )
        : 0,
    boundary_crossing_count: packets.reduce(
      (sum, packet) => sum + packet.quality.boundary_edge_count,
      0,
    ),
    merge_edge_kind_counts: countMergeEdgeKinds(
      packets,
      groups,
      planningGraphEdges,
    ),
    boundary_edge_kind_counts: countBoundaryOnlyEdgeKinds(
      packets,
      planningGraphEdges,
    ),
    orphan_task_count: orphanTaskCount,
    high_fan_in_file_count: countHighDegreeTaskFiles(
      degreeIndex.fanIn,
      taskFiles,
    ),
    high_fan_out_file_count: countHighDegreeTaskFiles(
      degreeIndex.fanOut,
      taskFiles,
    ),
    weakly_explained_gap_counts: weaklyExplainedGapCounts(weakPackets),
    weakly_explained_file_extension_counts:
      weaklyExplainedFileExtensionCounts(weakPackets),
    weakly_explained_packet_count: weakPacketIds.length,
    weakly_explained_packet_ids: weakPacketIds,
    weakly_explained_packet_samples: weakPacketSamples,
    largest_unexplained_packet_id:
      largestUnexplainedFiles > 0
        ? largestUnexplainedPacket?.packet_id
        : undefined,
    largest_unexplained_packet_files: largestUnexplainedFiles,
  };
}

export function buildAuditPlanMetrics(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions & { generatedAt?: Date } = {},
): AuditPlanMetrics {
  const { graphEdges, groups, packets, planningGraphEdges } =
    buildReviewPacketPlanningData(tasks, options);
  const taskLineCounts = tasks.map((task) => taskLineCount(task, options.lineIndex));
  const totalTaskLines = taskLineCounts.reduce((sum, value) => sum + value, 0);
  const totalPacketLines = packets.reduce(
    (sum, packet) => sum + packet.total_lines,
    0,
  );
  const largestTaskIndex = taskLineCounts.reduce(
    (largest, value, index) => (value > taskLineCounts[largest]! ? index : largest),
    0,
  );
  const largestPacket = packets.reduce<ReviewPacket | undefined>(
    (largest, packet) =>
      !largest || packet.total_lines > largest.total_lines ? packet : largest,
    undefined,
  );
  const taskFileReferences = tasks.reduce(
    (sum, task) => sum + task.file_paths.length,
    0,
  );
  const uniqueFiles = new Set(tasks.flatMap((task) => task.file_paths));
  const lensTaskCounts: Record<string, number> = {};
  const priorityTaskCounts: AuditPlanMetrics["priority_task_counts"] = {
    high: 0,
    medium: 0,
    low: 0,
  };

  for (const task of tasks) {
    lensTaskCounts[task.lens] = (lensTaskCounts[task.lens] ?? 0) + 1;
    priorityTaskCounts[normalizePriority(task.priority)] += 1;
  }

  return {
    generated_at: (options.generatedAt ?? new Date()).toISOString(),
    task_count: tasks.length,
    packet_count: packets.length,
    estimated_agent_reduction: Math.max(0, tasks.length - packets.length),
    estimated_agent_reduction_ratio:
      tasks.length === 0 ? 0 : Math.max(0, tasks.length - packets.length) / tasks.length,
    unique_file_count: uniqueFiles.size,
    task_file_reference_count: taskFileReferences,
    repeated_file_reference_count: Math.max(0, taskFileReferences - uniqueFiles.size),
    total_task_lines: totalTaskLines,
    total_packet_lines: totalPacketLines,
    repeated_line_reference_count: Math.max(0, totalTaskLines - totalPacketLines),
    min_task_lines: taskLineCounts.length > 0 ? Math.min(...taskLineCounts) : 0,
    max_task_lines: taskLineCounts.length > 0 ? Math.max(...taskLineCounts) : 0,
    average_task_lines:
      taskLineCounts.length > 0 ? totalTaskLines / taskLineCounts.length : 0,
    largest_task_id: tasks[largestTaskIndex]?.task_id,
    largest_packet_id: largestPacket?.packet_id,
    lens_task_counts: lensTaskCounts,
    priority_task_counts: priorityTaskCounts,
    packet_quality: buildPacketQualityMetrics(
      packets,
      tasks,
      graphEdges,
      planningGraphEdges,
      groups,
    ),
    packet_size: {
      single_task_packets: packets.filter((packet) => packet.task_ids.length === 1).length,
      multi_task_packets: packets.filter((packet) => packet.task_ids.length > 1).length,
      max_tasks_per_packet:
        packets.length > 0 ? Math.max(...packets.map((packet) => packet.task_ids.length)) : 0,
      max_files_per_packet:
        packets.length > 0 ? Math.max(...packets.map((packet) => packet.file_paths.length)) : 0,
    },
  };
}
