import type { AuditTask } from "../types.js";
import type { ReviewPacket } from "../types/reviewPlanning.js";
import type { GraphEdge } from "audit-tools/shared";

// The module BELOW both reviewPackets.ts and reviewPacketMetrics.ts. Packets
// imports metrics (one direction), so metrics could not import back — which is
// why the planning-data shape and these two task-field accessors had been
// re-declared byte-identically in each. Single-sourced here instead, so the
// pair cannot drift.

/** The planning intermediate reviewPackets builds and reviewPacketMetrics scores. */
export interface ReviewPacketPlanningData {
  graphEdges: GraphEdge[];
  groups: Map<string, AuditTask[]>;
  planningGraphEdges: GraphEdge[];
  packets: ReviewPacket[];
}

/** Normalize an AuditTask priority; absent → "low". */
export function normalizePriority(
  priority: AuditTask["priority"],
): NonNullable<AuditTask["priority"]> {
  return priority ?? "low";
}

/** Line count for one path: the task's own counts first, then the shared index. */
export function lineCountForPath(
  task: AuditTask,
  path: string,
  lineIndex?: Record<string, number>,
): number {
  return task.file_line_counts?.[path] ?? lineIndex?.[path] ?? 0;
}
