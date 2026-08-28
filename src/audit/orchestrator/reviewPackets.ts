import type { AuditTask } from "../types.js";
import type {
  AuditPlanMetrics,
  ReviewPacket,
} from "../types/reviewPlanning.js";
import type { GraphBundle, GraphEdge } from "audit-tools/shared";
import {
  collectGraphEdges,
  compareCodeUnits,
  hashContent,
} from "audit-tools/shared";
import { priorityRank, sortLenses } from "./auditTaskUtils.js";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";
import {
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  sizeIndexFromManifest,
  fileGroupContentTokens,
  estimateTaskGroupTokens,
} from "./reviewPacketSizing.js";
import { buildPacketGraphContext } from "./reviewPacketGraphContext.js";
import { sanitizeSegment } from "./selectiveDeepening/shared.js";
import {
  buildTaskCoherencePartition,
  type GraphPacket,
} from "./partitionTaskGraph.js";
import {
  buildTaskAffinityGraph,
  type TaskAffinityGraph,
} from "./taskAffinityGraph.js";
import { computeAuditPlanMetrics } from "./reviewPacketMetrics.js";
import type { ReviewPacketPlanningData } from "./reviewPacketShared.js";
import { normalizePriority, lineCountForPath } from "./reviewPacketShared.js";

export { normalizeGraphPath };
export {
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PACKET_PROMPT_TOKENS,
  sizeIndexFromManifest,
  estimateTaskGroupTokens,
};

export interface BuildReviewPacketOptions {
  graphBundle?: GraphBundle;
  lineIndex?: Record<string, number>;
  sizeIndex?: Record<string, number>;
  continuityScores?: Map<string, number>;
  [presentationInput: string]: unknown;
}

function canonicalTasks(tasks: readonly AuditTask[]): AuditTask[] {
  return [...tasks].sort((left, right) =>
    compareCodeUnits(left.task_id, right.task_id),
  );
}

function packetIdFor(tasks: readonly AuditTask[], packetIndex: number): string {
  const unit = sanitizeSegment(tasks[0]?.unit_id ?? "review");
  const lenses = sortLenses(tasks.map((task) => task.lens)).join("-");
  // Routed through the shared hash home with an explicit length — the inline
  // createHash chain truncated by a bare slice is the banned construction.
  const hash = hashContent(
    tasks.map((task) => task.task_id).join("\u0000"),
    { length: 10 },
  );
  return `${unit}:${lenses}:packet-${packetIndex + 1}-${hash}`;
}

/** Canonical component order; optional presentation inputs cannot reorder it. */
export function orderReviewPackets(
  packets: ReviewPacket[],
  ..._ignored: readonly unknown[]
): ReviewPacket[] {
  return packets.sort((left, right) =>
    compareCodeUnits(left.task_ids[0] ?? "", right.task_ids[0] ?? ""),
  );
}

/** Materialize one already-selected component into report/prompt metadata. */
export function buildPacket(
  inputTasks: AuditTask[],
  packetIndex: number,
  lineIndex?: Record<string, number>,
  sizeIndex?: Record<string, number>,
  graphEdges: GraphEdge[] = [],
  graphBundle?: GraphBundle,
): ReviewPacket {
  const tasks = canonicalTasks(inputTasks);
  if (tasks.length === 0) {
    throw new Error("Cannot materialize an empty review-packet component.");
  }
  const filePaths = [
    ...new Set(tasks.flatMap((task) => task.file_paths)),
  ].sort(compareCodeUnits);
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
  ].sort(compareCodeUnits);
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
    unit_ids: [...new Set(tasks.map((task) => task.unit_id))].sort(
      compareCodeUnits,
    ),
    pass_ids: [...new Set(tasks.map((task) => task.pass_id))].sort(
      compareCodeUnits,
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
    estimated_tokens:
      ESTIMATED_PACKET_PROMPT_TOKENS +
      fileGroupContentTokens(filePaths, tasks, sizeIndex, lineIndex),
  };
}

function planningDataFromProjection(
  tasks: AuditTask[],
  graph: TaskAffinityGraph,
  options: BuildReviewPacketOptions,
): ReviewPacketPlanningData {
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const graphEdges = collectGraphEdges(options.graphBundle);
  const projection = buildTaskCoherencePartition(graph);
  const groups = new Map<string, AuditTask[]>();
  const packets: ReviewPacket[] = [];

  for (const [index, component] of projection.packets.entries()) {
    const componentTasks = component.task_ids.map((taskId) => {
      const task = taskById.get(taskId);
      if (!task) {
        throw new Error(
          `Task-affinity component references missing audit task '${taskId}'.`,
        );
      }
      return task;
    });
    groups.set(component.task_ids[0] ?? `component-${index + 1}`, componentTasks);
    packets.push(
      materializeProjectedPacket(
        componentTasks,
        component,
        index,
        graphEdges,
        options,
      ),
    );
  }

  return {
    graphEdges,
    groups,
    planningGraphEdges: graphEdges,
    packets: orderReviewPackets(packets),
  };
}

function materializeProjectedPacket(
  tasks: AuditTask[],
  component: GraphPacket,
  index: number,
  graphEdges: GraphEdge[],
  options: BuildReviewPacketOptions,
): ReviewPacket {
  return {
    ...buildPacket(
      tasks,
      index,
      options.lineIndex,
      options.sizeIndex,
      graphEdges,
      options.graphBundle,
    ),
    risk_score: component.risk_score,
  };
}

/**
 * Project tasks onto the affinity graph and derive the full packetization
 * (packets + the graph edges the packets were cut against). `buildAuditPlanMetrics`
 * is the production consumer; exported so packetization can be asserted at its own
 * seam rather than through the metrics projection that wraps it.
 */
export function buildReviewPacketPlanningData(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions = {},
): ReviewPacketPlanningData {
  const graph = buildTaskAffinityGraph(tasks, {
    graphBundle: options.graphBundle,
  });
  return planningDataFromProjection(tasks, graph, options);
}

export function buildAuditPlanMetrics(
  tasks: AuditTask[],
  options: BuildReviewPacketOptions & { generatedAt?: Date } = {},
): AuditPlanMetrics {
  const planningData = buildReviewPacketPlanningData(tasks, options);
  return computeAuditPlanMetrics(
    planningData,
    tasks,
    options.lineIndex,
    options.generatedAt,
  );
}
