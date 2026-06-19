import { z } from "zod";

export const FLOW_COVERAGE_STATUSES = [
  "pending",
  "partial",
  "complete",
] as const;
export const FlowCoverageStatusSchema = z.enum(FLOW_COVERAGE_STATUSES);
export type FlowCoverageStatus = z.infer<typeof FlowCoverageStatusSchema>;

/** Coverage for one critical flow across the lenses the audit expects to see. */
export const FlowCoverageRecordSchema = z
  .object({
    flow_id: z.string(),
    paths: z.array(z.string()),
    // Producer emits custom lens names too, so these stay free strings (the old
    // JSON schema's canonical-lens $ref was over-strict).
    required_lenses: z.array(z.string()),
    completed_lenses: z.array(z.string()),
    status: FlowCoverageStatusSchema,
    notes: z.array(z.string()).optional(),
  })
  .strict();
export type FlowCoverageRecord = z.infer<typeof FlowCoverageRecordSchema>;

/** Aggregated flow coverage written beside the critical flow manifest. */
export const FlowCoverageManifestSchema = z
  .object({
    flows: z.array(FlowCoverageRecordSchema),
  })
  .strict();
export type FlowCoverageManifest = z.infer<typeof FlowCoverageManifestSchema>;
