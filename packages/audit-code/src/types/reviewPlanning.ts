import type { AuditTask, Lens } from "../types.js";
import type { GraphEdge } from "./graph.js";

export interface ReviewPacketGraphEdge
  extends Pick<GraphEdge, "from" | "to" | "kind" | "confidence" | "reason"> {}

export interface ReviewPacketQuality {
  cohesion_score: number;
  internal_edge_count: number;
  boundary_edge_count: number;
  unexplained_file_count: number;
}

export interface WeaklyExplainedPacketSample {
  packet_id: string;
  primary_gap:
    | "missing_internal_edges"
    | "unexplained_files"
    | "partial_cohesion";
  file_count: number;
  sample_file_paths: string[];
  cohesion_score: number;
  internal_edge_count: number;
  boundary_edge_count: number;
  unexplained_file_count: number;
}

export interface ReviewPacket {
  packet_id: string;
  task_ids: string[];
  unit_ids: string[];
  pass_ids: string[];
  lenses: Lens[];
  file_paths: string[];
  file_line_counts: Record<string, number>;
  total_lines: number;
  priority: NonNullable<AuditTask["priority"]>;
  tags?: string[];
  entrypoints?: string[];
  key_edges?: ReviewPacketGraphEdge[];
  boundary_files?: string[];
  quality: ReviewPacketQuality;
  rationale: string;
  estimated_tokens: number;
}

export interface AuditPlanMetrics {
  generated_at: string;
  task_count: number;
  packet_count: number;
  estimated_agent_reduction: number;
  estimated_agent_reduction_ratio: number;
  unique_file_count: number;
  task_file_reference_count: number;
  repeated_file_reference_count: number;
  total_task_lines: number;
  total_packet_lines: number;
  repeated_line_reference_count: number;
  min_task_lines: number;
  max_task_lines: number;
  average_task_lines: number;
  largest_task_id?: string;
  largest_packet_id?: string;
  lens_task_counts: Partial<Record<Lens, number>>;
  priority_task_counts: Record<NonNullable<AuditTask["priority"]>, number>;
  packet_quality: {
    average_cohesion_score: number;
    boundary_crossing_count: number;
    merge_edge_kind_counts: Record<string, number>;
    boundary_edge_kind_counts: Record<string, number>;
    orphan_task_count: number;
    high_fan_in_file_count: number;
    high_fan_out_file_count: number;
    weakly_explained_gap_counts: Record<
      WeaklyExplainedPacketSample["primary_gap"],
      number
    >;
    weakly_explained_file_extension_counts: Record<string, number>;
    weakly_explained_packet_count: number;
    weakly_explained_packet_ids: string[];
    weakly_explained_packet_samples: WeaklyExplainedPacketSample[];
    largest_unexplained_packet_id?: string;
    largest_unexplained_packet_files: number;
  };
  packet_size: {
    single_task_packets: number;
    multi_task_packets: number;
    max_tasks_per_packet: number;
    max_files_per_packet: number;
  };
}
