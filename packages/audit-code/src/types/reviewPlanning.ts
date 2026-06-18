import { z } from "zod";
import { GraphEdgeSchema } from "@audit-tools/shared";

const PrioritySchema = z.enum(["high", "medium", "low"]);
const PrimaryGapSchema = z.enum([
  "missing_internal_edges",
  "unexplained_files",
  "partial_cohesion",
]);

export const ReviewPacketGraphEdgeSchema = GraphEdgeSchema.pick({
  from: true,
  to: true,
  kind: true,
  confidence: true,
  reason: true,
});
export type ReviewPacketGraphEdge = z.infer<typeof ReviewPacketGraphEdgeSchema>;

export const ReviewPacketQualitySchema = z.object({
  cohesion_score: z.number(),
  internal_edge_count: z.number(),
  boundary_edge_count: z.number(),
  unexplained_file_count: z.number(),
});
export type ReviewPacketQuality = z.infer<typeof ReviewPacketQualitySchema>;

export const WeaklyExplainedPacketSampleSchema = z.object({
  packet_id: z.string(),
  primary_gap: PrimaryGapSchema,
  file_count: z.number(),
  sample_file_paths: z.array(z.string()),
  cohesion_score: z.number(),
  internal_edge_count: z.number(),
  boundary_edge_count: z.number(),
  unexplained_file_count: z.number(),
});
export type WeaklyExplainedPacketSample = z.infer<
  typeof WeaklyExplainedPacketSampleSchema
>;

export const ReviewPacketSchema = z.object({
  packet_id: z.string(),
  task_ids: z.array(z.string()),
  unit_ids: z.array(z.string()),
  pass_ids: z.array(z.string()),
  lenses: z.array(z.string()),
  file_paths: z.array(z.string()),
  file_line_counts: z.record(z.string(), z.number()),
  total_lines: z.number(),
  priority: PrioritySchema,
  tags: z.array(z.string()).optional(),
  entrypoints: z.array(z.string()).optional(),
  key_edges: z.array(ReviewPacketGraphEdgeSchema).optional(),
  boundary_files: z.array(z.string()).optional(),
  quality: ReviewPacketQualitySchema,
  rationale: z.string(),
  estimated_tokens: z.number(),
  /**
   * Max member risk (in [0,1]) from the just-in-time graph partition — the
   * signal that routes this packet to a relative model rank. Present only on
   * dispatch-time packets built via `buildReviewPacketsFromPartition`; the
   * plan-time builder has no partition and leaves it unset.
   */
  routing_risk: z.number().optional(),
});
export type ReviewPacket = z.infer<typeof ReviewPacketSchema>;

/**
 * Aggregate quality signals for a planned set of review packets — cohesion,
 * boundary-crossing counts, and the weakly-explained-packet diagnostics. Promoted
 * from an inline anonymous object on {@link AuditPlanMetrics} so it can be named
 * and referenced.
 */
export const PacketQualitySchema = z.object({
  average_cohesion_score: z.number().min(0).max(1),
  boundary_crossing_count: z.number(),
  merge_edge_kind_counts: z.record(z.string(), z.number()),
  boundary_edge_kind_counts: z.record(z.string(), z.number()),
  orphan_task_count: z.number(),
  high_fan_in_file_count: z.number(),
  high_fan_out_file_count: z.number(),
  // Keyed by PrimaryGap at runtime; typed as a full string-record so values are
  // non-optional (z.record(enum, …) infers a Partial record).
  weakly_explained_gap_counts: z.record(z.string(), z.number()),
  weakly_explained_file_extension_counts: z.record(z.string(), z.number()),
  weakly_explained_packet_count: z.number(),
  weakly_explained_packet_ids: z.array(z.string()),
  weakly_explained_packet_samples: z.array(WeaklyExplainedPacketSampleSchema),
  largest_unexplained_packet_id: z.string().optional(),
  largest_unexplained_packet_files: z.number(),
});
export type PacketQuality = z.infer<typeof PacketQualitySchema>;

export const AuditPlanMetricsSchema = z.object({
  generated_at: z.string(),
  task_count: z.number(),
  packet_count: z.number(),
  estimated_agent_reduction: z.number(),
  estimated_agent_reduction_ratio: z.number(),
  unique_file_count: z.number(),
  task_file_reference_count: z.number(),
  repeated_file_reference_count: z.number(),
  total_task_lines: z.number(),
  total_packet_lines: z.number(),
  repeated_line_reference_count: z.number(),
  min_task_lines: z.number(),
  max_task_lines: z.number(),
  average_task_lines: z.number(),
  largest_task_id: z.string().optional(),
  largest_packet_id: z.string().optional(),
  lens_task_counts: z.record(z.string(), z.number()),
  // Keyed by priority at runtime; full string-record (see gap-counts note).
  priority_task_counts: z.record(z.string(), z.number()),
  packet_quality: PacketQualitySchema,
  packet_size: z.object({
    single_task_packets: z.number(),
    multi_task_packets: z.number(),
    max_tasks_per_packet: z.number(),
    max_files_per_packet: z.number(),
  }),
});
export type AuditPlanMetrics = z.infer<typeof AuditPlanMetricsSchema>;
