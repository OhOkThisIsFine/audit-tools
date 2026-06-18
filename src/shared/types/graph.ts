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
  })
  .strict();
export type GraphBundle = z.infer<typeof GraphBundleSchema>;
