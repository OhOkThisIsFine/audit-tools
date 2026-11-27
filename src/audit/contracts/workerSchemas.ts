// Worker-facing contract schemas derived from the canonical zod sources.

//
// sites-pinned: tests/checked-in-artifacts.test.mjs
//   Each site of this file is pinned by the named tests; `npm run check:sites-pinned`
//   derives the sites from the staged diff and refuses an unbound one.

import { z } from "zod";
import {
  AUDIT_FINDING_QUOTE_OR_DECLARATION_RULE,
  FindingSchema,
  FindingLocationObjectSchema,
  LensSchema,
  ReviewSubmissionSchema,
} from "audit-tools/shared";
import {
  AuditTaskSchema,
  AuditResultSchema,
  AuditVerificationSchema,
} from "../types.js";
import { AuditCodeResponseSchema } from "./wrapperResponse.js";

const NONBLANK_LOCATION_TEXT = /\S/;
const LOCATION_EVIDENCE_FIELDS = ["quoted_text", "no_quotable_span"] as const;

export const WorkerFindingLocationSchema = FindingLocationObjectSchema.omit({
  line_start: true,
  line_end: true,
})
  .strict()
  // The audit draw's grounding rule. The portable renderer below uses the
  // same fields and nonblank predicate; the dispatch prompt shares the refusal text.
  //
  // It is on the WORKER projection and not on the shared location schema on
  // purpose: a remediator plan finding is re-minted from graph nodes, so it has
  // no reviewer who could quote a span or declare that none exists.
  .superRefine((location, ctx) => {
    const [quoted, declared] = LOCATION_EVIDENCE_FIELDS.map(field => NONBLANK_LOCATION_TEXT.test(location[field] ?? ""));
    if (quoted === declared) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [quoted ? "no_quotable_span" : "quoted_text"],
        message: AUDIT_FINDING_QUOTE_OR_DECLARATION_RULE,
      });
    }
  });

// `grounding`, `verification_status`, `severity_downgraded_from`,
// `evidence_lane` and `lead_lineage` are OMITTED, not merely left un-extended:
// each is a TOOL-owned verdict — the re-check of the worker's quote (computed at
// ingest by the retired audit adapter's ingestAuditHostResults), the defect-presence claim derived at
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
 * the retired audit adapter's parseFindings (which walks this same table) is what tells the worker the
 * field is not its to send, and why. Two lists would let a field be omitted from
 * the schema and never refused, or refused with the wrong reason; the table and
 * the `.omit` below are the same set, and legacy tests/audit/schema-contracts.test.ts
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
  question_review_sources:
    "question_review_sources is derived from accepted question submissions and must not be supplied",
} as const satisfies Partial<Record<keyof typeof FindingSchema.shape, string>>;

type ToolOwnedFindingField = keyof typeof WORKER_REFUSED_FINDING_VERDICTS;
const TOOL_OWNED_FINDING_FIELDS = Object.keys(WORKER_REFUSED_FINDING_VERDICTS) as ToolOwnedFindingField[];
const workerFindingOmitMask = Object.fromEntries(
  TOOL_OWNED_FINDING_FIELDS.map((field) => [field, true]),
) as Record<ToolOwnedFindingField, true>;

export const WorkerFindingSchema = FindingSchema.omit(workerFindingOmitMask)
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
  { schema: z.ZodType; title: string }
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
  "review_submission.schema.json": {
    schema: ReviewSubmissionSchema,
    title: "Question Review Submission",
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
    omitted: TOOL_OWNED_FINDING_FIELDS,
    requiredOverride: ["evidence", "affected_files"],
    added: [],
    message:
      "a FIELD was added to or dropped from the shared FindingSchema without updating the worker " +
      "projection in the SAME change — run `npm run generate-schemas` and commit the rendered " +
      "schema/ file. Add tool-owned fields to WORKER_REFUSED_FINDING_VERDICTS; " +
      "for worker-facing fields, extend the projection.",
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
  const generated = z.toJSONSchema(entry.schema, {
    target: "draft-07",
    io: "input",
    // Refinements are not projected automatically. Preserve the portable
    // nonblank-evidence XOR wherever this input schema is embedded.
    override: ({ zodSchema, jsonSchema }) => {
      // The portable worker contract has always rejected undeclared keys
      // even in nested plain objects whose runtime parser strips them.
      if (zodSchema instanceof z.ZodObject && jsonSchema.additionalProperties === undefined) {
        jsonSchema.additionalProperties = false;
      }
      if (zodSchema === WorkerFindingLocationSchema) {
        jsonSchema.oneOf = LOCATION_EVIDENCE_FIELDS.map(field => ({
          required: [field],
          properties: { [field]: { pattern: NONBLANK_LOCATION_TEXT.source } },
        }));
      }
    },
  });
  delete generated.$schema;
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: filename,
    title: entry.title,
    ...generated,
  };
}
