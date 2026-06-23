// A6 — the audit-code wrapper CLI response envelope, single-sourced as zod.
//
// `audit-code next-step` (the .mjs wrapper) emits this JSON contract to the host
// agent. It has no other TypeScript producer, so the schema lives here as the
// single source of truth and the wrapper contract test validates against it
// directly (replacing the former hand-authored audit-code-v1alpha1.schema.json).

import { z } from "zod";

const AuditStateStatusSchema = z.enum([
  "not_started",
  "active",
  "blocked",
  "complete",
]);

const ObligationViewSchema = z
  .object({
    id: z.string(),
    state: z.enum(["missing", "present", "stale", "blocked", "satisfied"]),
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

const ActiveReviewRunSchema = z
  .object({
    run_id: z.string(),
    task_path: z.string(),
    prompt_path: z.string(),
    pending_audit_tasks_path: z.string().optional(),
    audit_results_path: z.string(),
    worker_command: z.array(z.string()).min(1),
  })
  .strict();

const HandoffArtifactPathsSchema = z
  .object({
    incoming_dir: z.string(),
    operator_handoff_json: z.string(),
    operator_handoff_markdown: z.string(),
    session_config: z.string(),
    run_ledger: z.string(),
    current_task: z.string().nullable(),
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
    provider: z.string().nullable(),
    summary: z.string(),
    pending_obligations: z.array(z.string()),
    suggested_inputs: z.array(SuggestedInputSchema),
    suggested_commands: z.array(z.string()),
    interactive_provider_hint: z.string().nullable(),
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

export type AuditCodeResponse = z.infer<typeof AuditCodeResponseSchema>;
