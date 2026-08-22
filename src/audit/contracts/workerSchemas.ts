// Worker-facing contract schemas derived from the canonical zod sources.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  FindingSchema,
  FindingLocationObjectSchema,
  LensSchema,
  refineFindingLocationLines,
} from "audit-tools/shared";
import {
  AuditTaskSchema,
  AuditResultSchema,
  AuditVerificationSchema,
} from "../types.js";

export const WorkerFindingLocationSchema =
  FindingLocationObjectSchema.strict().superRefine(refineFindingLocationLines);

// `grounding` is OMITTED, not merely left un-extended: it is the tool's own
// re-check of the worker's quote (computed at ingest by `ingestAuditHostResults`),
// so the worker-facing contract must not advertise it. `.extend` inherits the
// parent's optional field, so the omit is what makes the trailing `.strict()`
// — and the generated `additionalProperties: false` — reject a supplied verdict.
export const WorkerFindingSchema = FindingSchema.omit({ grounding: true })
  .extend({
    category: z.string().min(1),
    // Optionality itself is stated by the prompt renderer (`… is optional:`);
    // the describe text states only WHAT happens when omitted.
    lens: LensSchema.describe(
      "defaults from the enclosing AuditResult lens when omitted.",
    ).optional(),
    affected_files: z.array(WorkerFindingLocationSchema).min(1),
    evidence: z.array(z.string()).min(1),
    reproduction: z.array(z.string()).min(1).optional(),
    related_findings: z.array(z.string()).min(1).optional(),
  })
  .strict();

/** One finding as the strict projection parses it (ingestion's parse output). */
export type WorkerFinding = z.infer<typeof WorkerFindingSchema>;

export const WorkerAuditTaskSchema = AuditTaskSchema.extend({
  lens: LensSchema,
  file_paths: z.array(z.string()).min(1),
  file_line_counts: z.record(z.string(), z.number().int().min(0)).optional(),
  line_ranges: z
    .array(
      z
        .object({
          path: z.string(),
          start: z.number().int().min(1),
          end: z.number().int().min(1),
        })
        .strict()
        .refine((range) => range.end >= range.start, {
          message: "line range end must be >= start",
          path: ["end"],
        }),
    )
    .optional(),
  token_estimate: z.number().min(0).optional(),
  risk_estimate: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).min(1).optional(),
}).strict();

const WorkerAuditVerificationSchema = AuditVerificationSchema.extend({
  followup_tasks: z.array(WorkerAuditTaskSchema).optional(),
}).strict();

export const WorkerAuditResultSchema = AuditResultSchema.extend({
  lens: LensSchema,
  file_coverage: z
    .array(
      z
        .object({ path: z.string(), total_lines: z.number().int().min(0) })
        .strict(),
    )
    .min(1),
  findings: z.array(WorkerFindingSchema),
  reviewed_clean: z.boolean().optional(),
  followup_tasks: z.array(z.string()).optional(),
  verification: WorkerAuditVerificationSchema.optional(),
  submitted_at: z.string().datetime().optional(),
}).strict();

export const WorkerAuditResultsSchema = z.array(WorkerAuditResultSchema).min(1);

export const WORKER_SCHEMA_SOURCES: Record<
  string,
  { schema: z.ZodTypeAny; title: string }
> = {
  "lens.schema.json": { schema: LensSchema, title: "Lens" },
  "finding.schema.json": { schema: WorkerFindingSchema, title: "Audit Finding" },
  "audit_task.schema.json": { schema: WorkerAuditTaskSchema, title: "Audit Task" },
  "audit_result.schema.json": {
    schema: WorkerAuditResultSchema,
    title: "Audit Result",
  },
  "audit_results.schema.json": {
    schema: WorkerAuditResultsSchema,
    title: "Audit Results",
  },
};

export function renderWorkerJsonSchema(
  filename: string,
): Record<string, unknown> {
  const entry = WORKER_SCHEMA_SOURCES[filename];
  if (!entry) {
    throw new Error(`No worker schema source registered for "${filename}"`);
  }
  const generated = zodToJsonSchema(entry.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  delete generated.$schema;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: filename,
    title: entry.title,
    ...generated,
  };
}
