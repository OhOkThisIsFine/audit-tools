import { createHash } from "node:crypto";
import type { AuditTask, Lens } from "../types.js";
import type {
  AuditPlanMetrics,
  ReviewPacket,
} from "../types/reviewPlanning.js";
import type { GraphBundle, GraphEdge } from "audit-tools/shared";
import { continuityMassForPaths, chunkByBudget } from "audit-tools/shared";
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
  collectGraphEdges,
  unionFindFromGroups,
} from "./reviewPacketGraphEdges.js";
import { buildPacketGraphContext } from "./reviewPacketGraphContext.js";
import { buildPlanningGraphEdges } from "./reviewPacketGraphClustering.js";
import { sanitizeSegment } from "./selectiveDeepening/shared.js";
import {
  partitionTaskGraph,
  DEFAULT_RISK_MASS_BUDGET,
} from "./partitionTaskGraph.js";
import type { TaskAffinityGraph } from "./taskAffinityGraph.js";
import { computeAuditPlanMetrics } from "./reviewPacketMetrics.js";

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

export interface BuildReviewPacketOptions {
  graphBundle?: GraphBundle;
  lineIndex?: Record<string, number>;
  /** Path → size_bytes (from the repo manifest); drives byte-based token sizing. */
  sizeIndex?: Record<string, number>;
  /**
   * Optional per-file continuity scores (normalized graph path → score) from the
   * access-memory layer. When present, packets are ordered so higher-continuity
   * packets (more connected to already-touched code) sort first WITHIN a priority
   * tier — an additive selection bias that only affects packet ordering (a
   * back-payload concern), never composition or the cached prompt prefix. Absent
   * or empty → identical to pre-2b ordering.
   */
  continuityScores?: Map<string, number>;
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

/**
 * A packet's continuity mass = the single-sourced {@link continuityMassForPaths}
 * reducer over its member files (sum of normalized per-file scores, rounded so
 * ULP-level float differences can't reorder packets). Higher = more of the
 * packet's files are connected to already-touched code. Shared with remediate's
 * per-block reduction so both orchestrators reduce identically.
 */
function packetContinuityMass(
  packet: ReviewPacket,
  scores: Map<string, number>,
): number {
  return continuityMassForPaths(packet.file_paths, scores);
}

/**
 * Packet ordering comparator. Priority is always the dominant audit signal;
 * continuity (when access-memory scores are supplied) is a secondary key that
 * biases selection WITHIN a priority tier toward packets connected to
 * already-touched code, ahead of the raw size / id tiebreaks. With no scores it
 * degrades to the original priority → size → id order.
 */
function makeComparePackets(
  continuityByPacketId?: Map<string, number>,
): (a: ReviewPacket, b: ReviewPacket) => number {
  return (a, b) => {
    const priorityDelta = priorityRank(b.priority) - priorityRank(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    if (continuityByPacketId) {
      const aContinuity = continuityByPacketId.get(a.packet_id) ?? 0;
      const bContinuity = continuityByPacketId.get(b.packet_id) ?? 0;
      if (bContinuity !== aContinuity) return bContinuity - aContinuity;
    }
    const sizeDelta = b.task_ids.length - a.task_ids.length;
    if (sizeDelta !== 0) return sizeDelta;
    return a.packet_id.localeCompare(b.packet_id);
  };
}

const comparePackets = makeComparePackets();

/**
 * Build the packet-id → continuity-mass index used to order packets, or
 * undefined when no (non-empty) continuity scores were supplied — in which case
 * callers fall back to the plain `comparePackets`.
 */
function continuityIndexForPackets(
  packets: ReviewPacket[],
  scores: Map<string, number> | undefined,
): Map<string, number> | undefined {
  if (!scores || scores.size === 0) return undefined;
  return new Map(
    packets.map((packet) => [packet.packet_id, packetContinuityMass(packet, scores)]),
  );
}

/**
 * The single canonical packet ordering: priority → continuity (when access-memory
 * scores are supplied) → size → id. Single-sourced so every site that emits an
 * ordered packet list — the two packetizers AND the per-tier re-split in
 * `fitPacketsToTierBudgets` — orders identically and the bias (and strict
 * priority monotonicity) can never be silently dropped by one of them.
 */
export function orderReviewPackets(
  packets: ReviewPacket[],
  continuityScores?: Map<string, number>,
): ReviewPacket[] {
  const continuityIndex = continuityIndexForPackets(packets, continuityScores);
  return packets.sort(
    continuityIndex ? makeComparePackets(continuityIndex) : comparePackets,
  );
}

/**
 * Thin adapter over the shared {@link chunkByBudget} greedy chunker (extracted
 * alongside chunkByTaskBudget in taskBuilder.ts and splitOversizedOverlapGroup
 * in remediate's plan.ts — three previously byte-identical loop shapes). The
 * isolated-large-file fast path and the verbose diagnostics are reproduced via
 * `isolateAlone`/`onIsolate`/`onBeforeFlush` so behavior — including the
 * exact stderr wording — is unchanged.
 */
function chunkPacketTasks(
  tasks: AuditTask[],
  options: Required<Pick<BuildReviewPacketOptions, "maxTasksPerPacket" | "targetPacketTokens">> &
    Pick<BuildReviewPacketOptions, "lineIndex" | "sizeIndex">,
): AuditTask[][] {
  const verbose = Boolean(process.env.AUDIT_CODE_VERBOSE);
  const sortedTasks = tasks.sort(compareTasksForPacket);

  return chunkByBudget(sortedTasks, {
    budget: options.targetPacketTokens,
    maxItems: options.maxTasksPerPacket,
    costOf: (candidate) => {
      const uniquePaths = new Set(candidate.flatMap((item) => item.file_paths));
      return fileGroupContentTokens(uniquePaths, candidate, options.sizeIndex, options.lineIndex);
    },
    isolateAlone: (task) =>
      task.file_paths.length === 1 &&
      taskContentTokens(task, options.sizeIndex, options.lineIndex) > options.targetPacketTokens,
    onIsolate: (task) => {
      if (!verbose) return;
      const taskEstimatedTokens = taskContentTokens(task, options.sizeIndex, options.lineIndex);
      process.stderr.write(
        `[audit-code:packet-planning] isolated large-file chunk: task="${task.task_id}" file="${task.file_paths[0]}" estimatedTokens=${taskEstimatedTokens} targetPacketTokens=${options.targetPacketTokens}\n`,
      );
    },
    onBeforeFlush: ({ item, wouldExceedBudget, candidateCost }) => {
      if (!verbose || !wouldExceedBudget) return;
      process.stderr.write(
        `[audit-code:packet-planning] token-budget split: task="${item.task_id}" file="${item.file_paths[0] ?? ""}" candidateContentTokens=${candidateCost} targetPacketTokens=${options.targetPacketTokens}\n`,
      );
    },
  });
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

export function buildPacket(
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
    packets: orderReviewPackets(packets, options.continuityScores),
  };
}

export function buildReviewPackets(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): ReviewPacket[] {
  return buildReviewPacketPlanningData(tasks, options).packets;
}

export interface BuildPartitionPacketOptions {
  /** The task-affinity graph to partition (restricted to the dispatch tasks). */
  graph: TaskAffinityGraph;
  /** Context-token ceiling per packet (dispatching model's input budget). */
  contextTokenBudget: number;
  /** Risk-mass ceiling per packet. Defaults to DEFAULT_RISK_MASS_BUDGET. */
  riskMassBudget?: number;
  lineIndex?: Record<string, number>;
  sizeIndex?: Record<string, number>;
  graphBundle?: GraphBundle;
  /**
   * Optional per-file continuity scores (see BuildReviewPacketOptions). Orders
   * the materialized packets so higher-continuity packets sort first within a
   * priority tier; absent/empty → identical to pre-2b ordering.
   */
  continuityScores?: Map<string, number>;
}

/**
 * Just-in-time packetization (Phase B): partition the provider-neutral
 * task-affinity graph under the active model's context + risk-mass ceilings,
 * then materialize each cluster into the same `ReviewPacket` contract the old
 * plan-time builder emitted — so all downstream dispatch-plan / prompt /
 * complexity / model_hint rendering is unchanged. This replaces the frozen
 * plan-time `buildReviewPackets` packetization at the dispatch call site.
 */
export function buildReviewPacketsFromPartition(
  tasks: AuditTask[],
  options: BuildPartitionPacketOptions,
): ReviewPacket[] {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const graphEdges = collectGraphEdges(options.graphBundle);
  const clusters = partitionTaskGraph(options.graph, {
    contextTokenBudget: options.contextTokenBudget,
    riskMassBudget: options.riskMassBudget ?? DEFAULT_RISK_MASS_BUDGET,
    promptOverheadTokens: ESTIMATED_PACKET_PROMPT_TOKENS,
  });

  const packets: ReviewPacket[] = [];
  let packetIndex = 0;
  for (const cluster of clusters) {
    const clusterTasks = cluster.task_ids
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is AuditTask => task !== undefined)
      .sort(compareTasksForPacket);
    if (clusterTasks.length === 0) continue;
    packets.push({
      ...buildPacket(
        clusterTasks,
        packetIndex,
        options.lineIndex,
        options.sizeIndex,
        graphEdges,
        options.graphBundle,
      ),
      routing_risk: cluster.routing_risk,
    });
    packetIndex += 1;
  }

  return orderReviewPackets(packets, options.continuityScores);
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

export function buildAuditPlanMetrics(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions & { generatedAt?: Date } = {},
): AuditPlanMetrics {
  const planningData = buildReviewPacketPlanningData(tasks, options);
  return computeAuditPlanMetrics(planningData, tasks, options.lineIndex, options.generatedAt);
}
