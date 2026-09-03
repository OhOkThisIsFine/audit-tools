// A6 — the audit-code wrapper CLI response envelope, single-sourced as zod.
//
// `audit-code next-step` (the .mjs wrapper) emits this JSON contract to the
// host agent. This module is its single source of truth: the wrapper contract
// test (tests/audit/wrapper-response-contract.test.ts) validates real
// builder-assembled envelopes against it, the review-run loader derives its
// `ActiveReviewRun` runtime guard from `ActiveReviewRunSchema`, and
// `WORKER_SCHEMA_SOURCES` renders it as the GENERATED
// schemas/audit-code-v1alpha1.schema.json projection.

import { z } from "zod";
import { ObligationStateSchema } from "audit-tools/shared";

const AuditStateStatusSchema = z.enum([
  "not_started",
  "active",
  "blocked",
  "complete",
]);

// The obligation state vocabulary is DERIVED, never re-listed. This projection
// ships as schemas/audit-code-v1alpha1.schema.json — the contract a host
// validates a wrapper response against — and a hand copy of the five state
// names meant a widened union produced persisted `audit_state.json` obligations
// the SHIPPED schema would refuse, silently, with no cross-check test relating
// the two enums. Same drift class as the hand-copied lens list
// (`src/shared/types/lens.ts`), one contract over.
const ObligationViewSchema = z
  .object({
    id: z.string(),
    state: ObligationStateSchema,
    reason: z.string().optional(),
  })
  .strict();

const AuditStateViewSchema = z
  .object({
    status: AuditStateStatusSchema,
    last_executor: z.string().optional(),
    last_obligation: z.string().optional(),
    blockers: z.array(z.string()).optional(),
    obligations: z.array(ObligationViewSchema),
  })
  .strict();

const SuggestedInputSchema = z
  .object({
    flag: z.enum([
      "--results",
      "--batch-results",
      "--updates",
      "--external-analyzer-results",
    ]),
    suggested_path: z.string(),
    description: z.string(),
  })
  .strict();

export const ActiveReviewRunSchema = z
  .object({
    contract_version: z.literal("audit-review-run/v1alpha1"),
    run_id: z.string(),
    review_run_path: z.string(),
    pending_audit_tasks_path: z.string(),
    host_workload_path: z.string(),
    host_result_map_path: z.string(),
  })
  .strict();

/** The persisted review-run manifest shape, derived from its zod source. */
export type ActiveReviewRun = z.infer<typeof ActiveReviewRunSchema>;

const HandoffArtifactPathsSchema = z
  .object({
    operator_inputs_dir: z.string(),
    operator_handoff_json: z.string(),
    operator_handoff_markdown: z.string(),
    session_config: z.string(),
    run_ledger: z.string(),
    current_review_run: z.string().nullable(),
    current_prompt: z.string().nullable(),
    current_tasks: z.string().nullable(),
    audit_tasks: z.string().nullable(),
    runtime_validation_tasks: z.string().nullable(),
    friction_record: z.string(),
  })
  .strict();

const HandoffSchema = z
  .object({
    status: AuditStateStatusSchema,
    repo_root: z.string(),
    artifacts_dir: z.string(),
    summary: z.string(),
    pending_obligations: z.array(z.string()),
    suggested_inputs: z.array(SuggestedInputSchema),
    suggested_commands: z.array(z.string()),
    active_review_run: ActiveReviewRunSchema.optional(),
    artifact_paths: HandoffArtifactPathsSchema,
    quick_start: z.string().optional(),
    file_map: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const AuditCodeResponseSchema = z
  .object({
    contract_version: z.literal("audit-code/v1alpha1"),
    audit_state: AuditStateViewSchema,
    selected_obligation: z.string().nullable(),
    selected_executor: z.string().nullable(),
    progress_made: z.boolean(),
    artifacts_written: z.array(z.string()),
    progress_summary: z.string(),
    next_likely_step: z.string().nullable(),
    handoff: HandoffSchema.optional(),
  })
  .strict();
