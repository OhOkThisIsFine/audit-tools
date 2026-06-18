import { z } from "zod";

export const FlowConfidenceLevelSchema = z.enum(["high", "low"]);
export const FLOW_CONFIDENCE_LEVELS = FlowConfidenceLevelSchema.options;
export type FlowConfidenceLevel = z.infer<typeof FlowConfidenceLevelSchema>;

/** A critical user or system flow that must be covered by the audit. */
export const CriticalFlowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    entrypoints: z.array(z.string()),
    paths: z.array(z.string()),
    concerns: z.array(z.string()),
    confidence: FlowConfidenceLevelSchema.optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict();
export type CriticalFlow = z.infer<typeof CriticalFlowSchema>;

/** The set of critical flows inferred from intake artifacts. */
export const CriticalFlowManifestSchema = z
  .object({
    flows: z.array(CriticalFlowSchema),
    fallback_required: z.boolean().optional(),
  })
  .strict();
export type CriticalFlowManifest = z.infer<typeof CriticalFlowManifestSchema>;
