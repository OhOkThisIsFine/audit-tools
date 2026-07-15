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

/**
 * Host-authored critical-flow enrichment — the payload the LLM fallback pass
 * returns (and the durable upstream input the structure phase merges) when the
 * deterministic flow inference marked itself below the confidence bar
 * (`CriticalFlowManifest.fallback_required`). Additive: each flow either
 * upgrades an existing flow (reuse its exact `id`) or adds a new one.
 */
export const CriticalFlowFallbackResultSchema = z
  .object({
    flows: z.array(CriticalFlowSchema),
  })
  .strict();
export type CriticalFlowFallbackResult = z.infer<
  typeof CriticalFlowFallbackResultSchema
>;
