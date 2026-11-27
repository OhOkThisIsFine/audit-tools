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
    // An argv identifies a shared command, not a test that proves this task's check.
    // sites-pinned: tests/audit/schema-contracts.test.ts
    evidence_requirements: z.array(z.string()).optional(),
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
    // sites-pinned: tests/audit/runtime-validation-source.test.ts
    verification: z.object({
      source_key: z.string().min(1),
      observations: z.array(z.string().trim().min(1)).min(1),
    }).strict().optional(),
  })
  .strict();

/** Persisted runtime validation outcomes keyed by generated task id. */
export const RuntimeValidationReportSchema = z
  .object({
    results: z.array(RuntimeValidationResultSchema),
  })
  .strict();
export type RuntimeValidationReport = z.infer<
  typeof RuntimeValidationReportSchema
>;
