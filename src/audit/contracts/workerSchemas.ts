// A6 — worker-facing contract schemas, derived from the canonical zod sources.
//
// The worker-facing JSON schemas shipped to dispatch workers (finding.schema.json,
// lens.schema.json, audit_task.schema.json, audit_result.schema.json,
// audit_results.schema.json) are STRICTER projections of the base contract zod
// schemas: a worker MUST provide evidence, cite at least one affected file, use a
// canonical lens, and emit no extra keys. Those constraints live here as explicit
// refinements of the single-source base schemas (`audit-tools/shared` for the
// finding/lens vocabulary, `../types.js` for audit task/result), so the JSON
// schemas can be GENERATED from them and never drift from the TypeScript types.
//
// `renderWorkerJsonSchema` emits the committed JSON; the drift-guard test
// (tests/worker-schema-generation.test.mjs) regenerates and compares.

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  FindingSchema,
  FindingLocationSchema,
  FindingGroundingSchema,
  LensSchema,
} from "audit-tools/shared";
import {
  AuditTaskSchema,
  AuditResultSchema,
  AuditVerificationSchema,
} from "../types.js";

/** A cited span as a worker must emit it: bounded line numbers, no extra keys. */
export const WorkerFindingLocationSchema = FindingLocationSchema.extend({
  line_start: z.number().int().min(1).optional(),
  line_end: z.number().int().min(1).optional(),
}).strict();

/**
 * A finding as a dispatch worker must emit it. Stricter than the pipeline
 * {@link FindingSchema}: a canonical lens, a non-empty category, at least one
 * affected file, non-empty evidence, and no unknown keys.
 */
export const WorkerFindingSchema = FindingSchema.extend({
  category: z.string().min(1),
  lens: LensSchema,
  affected_files: z.array(WorkerFindingLocationSchema).min(1),
  evidence: z.array(z.string()).min(1),
  reproduction: z.array(z.string()).min(1).optional(),
  related_findings: z.array(z.string()).min(1).optional(),
  grounding: FindingGroundingSchema.strict().optional(),
}).strict();

/** An audit task as it appears in worker contracts (canonical lens, bounded ranges). */
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
        .strict(),
    )
    .optional(),
  token_estimate: z.number().min(0).optional(),
  risk_estimate: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).min(1).optional(),
}).strict();

const WorkerAuditVerificationSchema = AuditVerificationSchema.extend({
  followup_tasks: z.array(WorkerAuditTaskSchema).optional(),
}).strict();

/**
 * One AuditResult as a worker must emit it. Note `followup_tasks` is a string[]
 * of task ids at the top level (the prior hand-written schema wrongly typed it as
 * AuditTask[] — corrected here by single-sourcing from the TS type).
 */
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
  followup_tasks: z.array(z.string()).optional(),
  verification: WorkerAuditVerificationSchema.optional(),
  submitted_at: z.string().datetime().optional(),
}).strict();

/** The full worker submission: a non-empty array of AuditResults. */
export const WorkerAuditResultsSchema = z.array(WorkerAuditResultSchema).min(1);

/**
 * Registry of the worker-facing JSON schema files and the zod source each is
 * generated from. The keys are the committed filenames under `schemas/`.
 */
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

/**
 * Render the committed JSON-schema document for a worker-facing schema file.
 * Self-contained (refs inlined) so a worker can validate against the single file.
 */
export function renderWorkerJsonSchema(filename: string): Record<string, unknown> {
  const entry = WORKER_SCHEMA_SOURCES[filename];
  if (!entry) {
    throw new Error(`No worker schema source registered for "${filename}"`);
  }
  const generated = zodToJsonSchema(entry.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  // zod-to-json-schema emits a top-level `$schema`; normalize the document head
  // to the stable identity fields the prior hand-authored schemas carried.
  delete generated.$schema;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: filename,
    title: entry.title,
    ...generated,
  };
}
