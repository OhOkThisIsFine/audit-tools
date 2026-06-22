import { z } from "zod";

export const GraphEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    kind: z.string().optional(),
    direction: z.enum(["directed", "undirected"]).optional(),
    confidence: z.number().min(0).max(1).optional(),
    reason: z.string().optional(),
  })
  .strict();
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const RouteEdgeSchema = z
  .object({
    path: z.string(),
    handler: z.string(),
    method: z.string().optional(),
  })
  .strict();
export type RouteEdge = z.infer<typeof RouteEdgeSchema>;

/**
 * Per-node structural measure (one of complexity / duplication). `value` is the
 * raw metric, `measure` names the concrete algorithm used (so consumers never
 * guess units), and `reach` records the scope of source the measure actually
 * covered — currently only `'js-ts-effective'` (computed over JS/TS source).
 */
export const NodeMetricSchema = z
  .object({
    value: z.number(),
    measure: z.string(),
    reach: z.literal("js-ts-effective"),
  })
  .strict();
export type NodeMetric = z.infer<typeof NodeMetricSchema>;

/**
 * Optional per-node (repo-path keyed) structural metrics computed at graph-build
 * time, where the file source is available. Absent for non-js/ts files (never
 * zero-filled). Each metric is independently optional. Declared as an explicit
 * optional Zod field (not a catchall) so a `.strict()` bundle WITHOUT
 * `node_metrics` still parses, while an unknown sibling key is rejected.
 */
export const NodeMetricsSchema = z.record(
  z.string(),
  z
    .object({
      complexity: NodeMetricSchema.optional(),
      duplication: NodeMetricSchema.optional(),
    })
    .strict(),
);
export type NodeMetrics = z.infer<typeof NodeMetricsSchema>;

export const GraphBundleSchema = z
  .object({
    graphs: z
      .object({
        imports: z.array(GraphEdgeSchema).optional(),
        calls: z.array(GraphEdgeSchema).optional(),
        references: z.array(GraphEdgeSchema).optional(),
        routes: z.array(RouteEdgeSchema).optional(),
      })
      // Graph categories are open-ended: new analyzers may add edge sets.
      .catchall(z.unknown()),
    /**
     * Provenance for the optional graph-enrichment pass: the ids of the language
     * analyzers whose edges were merged into this bundle (empty/absent when only
     * the deterministic regex floor was used). See Phase 5 analyzer seam.
     */
    analyzers_used: z.array(z.string()).optional(),
    /**
     * Optional per-node structural metrics (complexity / duplication) computed at
     * graph-build time over js/ts source. Explicit optional field so legacy
     * bundles without it still parse under `.strict()`.
     */
    node_metrics: NodeMetricsSchema.optional(),
  })
  .strict();
export type GraphBundle = z.infer<typeof GraphBundleSchema>;
