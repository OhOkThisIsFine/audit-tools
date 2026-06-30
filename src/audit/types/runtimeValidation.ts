import { z } from "zod";

export const RuntimeValidationKindSchema = z.enum([
  "unit-risk-check",
  "critical-flow-check",
]);

export const RuntimeValidationPrioritySchema = z.enum(["high", "medium", "low"]);

export const RuntimeValidationStatusSchema = z.enum([
  "pending",
  "confirmed",
  "not_confirmed",
  "inconclusive",
  "not_required",
]);
export type RuntimeValidationStatus = z.infer<
  typeof RuntimeValidationStatusSchema
>;

/** A deterministic runtime check queued after static review highlights risk. */
export const RuntimeValidationTaskSchema = z
  .object({
    id: z.string(),
    kind: RuntimeValidationKindSchema,
    target_paths: z.array(z.string()).min(1),
    reason: z.string(),
    priority: RuntimeValidationPrioritySchema,
    command: z.array(z.string()).optional(),
    suggested_checks: z.array(z.string()).optional(),
    source_artifacts: z.array(z.string()).optional(),
  })
  .strict();
export type RuntimeValidationTask = z.infer<typeof RuntimeValidationTaskSchema>;

/** Planner output for the runtime validation stage. */
export const RuntimeValidationTaskManifestSchema = z
  .object({
    tasks: z.array(RuntimeValidationTaskSchema),
  })
  .strict();
export type RuntimeValidationTaskManifest = z.infer<
  typeof RuntimeValidationTaskManifestSchema
>;

/** Result recorded after a runtime validation task runs or is intentionally skipped. */
export const RuntimeValidationResultSchema = z
  .object({
    task_id: z.string(),
    status: RuntimeValidationStatusSchema,
    summary: z.string(),
    evidence: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
  })
  .strict();
export type RuntimeValidationResult = z.infer<
  typeof RuntimeValidationResultSchema
>;

/** Persisted runtime validation outcomes keyed by generated task id. */
export const RuntimeValidationReportSchema = z
  .object({
    results: z.array(RuntimeValidationResultSchema),
  })
  .strict();
export type RuntimeValidationReport = z.infer<
  typeof RuntimeValidationReportSchema
>;
