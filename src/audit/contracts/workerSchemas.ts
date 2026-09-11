// Worker-facing contract schemas derived from the canonical zod sources.

//
// sites-pinned: tests/shared/contract-construction-sites.test.ts, tests/audit/schema-contracts.test.ts
//   Each site of this file is pinned by the named tests; `npm run check:sites-pinned`
//   derives the sites from the staged diff and refuses an unbound one.

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
import { AuditCodeResponseSchema } from "./wrapperResponse.js";

export const WorkerFindingLocationSchema =
  FindingLocationObjectSchema.strict().superRefine(refineFindingLocationLines);

// `grounding`, `verification_status`, `severity_downgraded_from`,
// `evidence_lane` and `lead_lineage` are OMITTED, not merely left un-extended:
// each is a TOOL-owned verdict — the re-check of the worker's quote (computed at
// ingest by `ingestAuditHostResults`), the defect-presence claim derived at
// conceptual ingest, the severity bar synthesis applies, the lane synthesis
// reads to decide whether a finding was ever asked for an `evidence` array, and
// the deterministic-producer lineage that is what makes a lead a LEAD — so the
// worker-facing contract must not advertise any of them. `.extend` inherits the
// parent's optional field, and `.strict()` rejects only UNKNOWN keys, so an
// inherited optional field would be silently ACCEPTED: the omit is what makes
// the trailing `.strict()` — and the generated `additionalProperties: false` —
// reject a supplied verdict.
/**
 * The fields the per-file projection omits: the field name AND the sentence
 * ingestion refuses it with, stated together because they are one fact about one
 * field.
 *
 * The omission makes a supplied key fail (`.strict()` → `additionalProperties:
 * false`), which reports a verdict as an UNRECOGNIZED KEY; the refusal in
 * `parseFindings` (which walks this same table) is what tells the worker the
 * field is not its to send, and why. Two lists would let a field be omitted from
 * the schema and never refused, or refused with the wrong reason; the table and
 * the `.omit` below are the same set, and `tests/audit/schema-contracts.test.ts`
 * pins them together mechanically.
 */
export const WORKER_REFUSED_FINDING_VERDICTS = {
  grounding: "grounding is tool-computed at ingest and must not be supplied",
  verification_status:
    "verification_status is tool-derived at ingest and must not be supplied",
  severity_downgraded_from:
    "severity_downgraded_from is tool-derived at ingest and must not be supplied",
  evidence_lane:
    "evidence_lane is tool-derived at ingest and must not be supplied",
  lead_lineage:
    "lead_lineage is stamped by the deterministic producer and must not be supplied",
} as const;

export const WorkerFindingSchema = FindingSchema.omit({
  grounding: true,
  verification_status: true,
  severity_downgraded_from: true,
  evidence_lane: true,
  lead_lineage: true,
})
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
        .object({
          path: z.string(),
          total_lines: z.number().int().min(0),
          reviewed_lines: z.number().int().min(0).optional(),
        })
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
  // The audit-code/v1alpha1 wrapper CLI response envelope (wrapperResponse.ts).
  "audit-code-v1alpha1.schema.json": {
    schema: AuditCodeResponseSchema,
    title: "Audit Code Response",
  },
};

/**
 * The differences a rendered schema may declare against its canonical contract.
 * Nothing here is implicit: a difference that is NOT declared is drift, and
 * `scripts/check-contract-sites.mjs` reds on it.
 *
 * `omitted` — the contract declares the field; this projection deliberately does
 * not (the tool-owned fields above, omitted so `.strict()` REJECTS a supplied
 * value rather than silently accepting an inherited optional one).
 *
 * `requiredOverride` / `added` — carried for the same reason and read by the
 * same gate. `requiredOverride` names a field whose required-ness this projection
 * sets differently (`finding.schema.json` requires `evidence` and
 * `affected_files` where the shared Finding leaves them optional — the asymmetry
 * `FindingEvidenceLaneSchema` documents); `added` names a field the projection
 * carries that the contract does not declare at all (the worker surface narrows
 * `lens` to `LensSchema` and adds `reviewed_lines`).
 *
 * The property SET is what the gate compares. Required-ness is deliberately not
 * compared against the BASE contract, because the worker projection is a
 * different contract that relaxes and strengthens on purpose — comparing it
 * would report a settled design decision as drift on every run.
 */
export const CONTRACT_SCHEMA_PRODUCERS: Record<
  string,
  {
    contract: string;
    omitted?: readonly string[];
    requiredOverride?: readonly string[];
    added?: readonly string[];
    message: string;
  }
> = {
  "schemas/finding.schema.json": {
    contract: "Finding",
    omitted: [
      "grounding",
      "verification_status",
      "severity_downgraded_from",
      "evidence_lane",
      "lead_lineage",
    ],
    requiredOverride: ["evidence", "affected_files"],
    added: [],
    message:
      "a FIELD was added to or dropped from the shared FindingSchema without updating the worker " +
      "projection in the SAME change — run `npm run generate-schemas` and commit the rendered " +
      "schema/ file. If the new field is TOOL-OWNED, add it to WorkerFindingSchema's `.omit`, to " +
      "WORKER_REFUSED_FINDING_VERDICTS, and to this pairing's `omitted` list; if it is " +
      "worker-facing, extend the projection.",
  },
  "schemas/audit_result.schema.json": {
    contract: "AuditResult",
    omitted: [],
    requiredOverride: [],
    added: [],
    message:
      "a FIELD was added to or dropped from the worker contract this schema renders — run " +
      "`npm run generate-schemas` and commit the rendered schema/ file in the SAME change as the " +
      "contract edit.",
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
