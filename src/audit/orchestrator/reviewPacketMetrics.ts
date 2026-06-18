import type { AuditTask } from "../types.js";
import type {
  AuditPlanMetrics,
  ReviewPacket,
  WeaklyExplainedPacketSample,
} from "../types/reviewPlanning.js";
import type { GraphEdge } from "audit-tools/shared";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";
import {
  HIGH_FAN_DEGREE_THRESHOLD,
  buildGraphDegreeIndex,
  isConcreteGraphEdge,
  isPacketExpansionEdge,
  buildFileToGroupKeys,
} from "./reviewPacketGraphEdges.js";
import { roundQuality } from "./reviewPacketGraphContext.js";

// Audit-plan quality metrics: packet cohesion, weakly-explained packet
// analysis, edge-kind breakdowns. buildAuditPlanMetrics is the single entry
// point; all helpers below are module-private.

const MAX_WEAK_PACKET_SAMPLES = 12;
const MAX_WEAK_PACKET_SAMPLE_FILES = 8;
const WEAK_PACKET_GAP_ORDER: WeaklyExplainedPacketSample["primary_gap"][] = [
  "missing_internal_edges",
  "unexplained_files",
  "partial_cohesion",
];

// --- types shared with reviewPackets (re-declared locally to avoid circular dep) ---

interface ReviewPacketPlanningData {
  graphEdges: GraphEdge[];
  groups: Map<string, AuditTask[]>;
  planningGraphEdges: GraphEdge[];
  packets: ReviewPacket[];
}

// --- private helpers ---

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

// --- public entry point ---

/**
 * Compute AuditPlanMetrics from pre-built planning data.
 * Called by buildAuditPlanMetrics in reviewPackets.ts after it runs the
 * planning pass; not intended for direct use outside this module pair.
 */
export function computeAuditPlanMetrics(
  planningData: ReviewPacketPlanningData,
  tasks: AuditTask[],
  lineIndex?: Record<string, number>,
  generatedAt?: Date,
): AuditPlanMetrics {
  const { graphEdges, groups, packets, planningGraphEdges } = planningData;
  const taskLineCounts = tasks.map((task) => taskLineCount(task, lineIndex));
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
    generated_at: (generatedAt ?? new Date()).toISOString(),
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
