import { z } from "zod";
import { AnalyzerSettingSchema } from "audit-tools/shared";
import { AnalyzerResolutionSchema } from "../extractors/analyzers/types.js";

// Marker artifact recording the outcome of the optional Phase 5 graph-enrichment
// pass. Its presence (and freshness against `graph_bundle.json`) satisfies the
// `graph_enrichment_current` obligation; the merged analyzer edges themselves
// live in `graph_bundle.json` (with `analyzers_used[]` provenance).

export const AnalyzerCapabilityStatusSchema = z.enum(["applied", "omitted"]);

export const AnalyzerCapabilityEntrySchema = z
  .object({
    id: z.string().min(1),
    resolution: AnalyzerResolutionSchema,
    setting: AnalyzerSettingSchema,
    edges_added: z.number().int().min(0),
    routes_added: z.number().int().min(0),
    note: z.string().optional(),
  })
  .strict();
export type AnalyzerCapabilityEntry = z.infer<
  typeof AnalyzerCapabilityEntrySchema
>;

export const AnalyzerCapabilityRecordSchema = z
  .object({
    /** `applied` when ≥1 analyzer contributed edges/routes; `omitted` otherwise. */
    status: AnalyzerCapabilityStatusSchema,
    analyzers: z.array(AnalyzerCapabilityEntrySchema),
  })
  .strict();
export type AnalyzerCapabilityRecord = z.infer<
  typeof AnalyzerCapabilityRecordSchema
>;
