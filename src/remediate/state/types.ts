import type { AcceptedConformanceReview } from "../../shared/types/reviewIndependence.js";
import { ExecutableChangePlanSchema, ExecutionRequestSchema } from "../../shared/types/executionPlan.js";
import { PlanCounterexampleSchema } from "../contractPipeline/executionPlan.js";
export type { ExecutionRequirement, ExecutionUnit, ExecutionRequest } from "../../shared/types/executionPlan.js";
// sites-pinned: tests/remediate/audit-read-plan-stamp.test.ts
import { z } from "zod";
import { CLOSING_ACTIONS } from "audit-tools/shared";
import type { RemediationItemStatus } from "./itemStatus.js";

// `Finding` is the canonical machine contract owned by audit-tools/shared.
// The remediator consumes the auditor's `audit-findings.json` directly, so it
// uses the shared shape verbatim rather than a divergent local copy. Imported
// (so it is in scope for the types below) and re-exported for existing callers.
import type {
  Finding,
  RemediationOutcome,
} from "audit-tools/shared";
import { AuditReadSchema, FindingSchema } from "audit-tools/shared";
export type { Finding };

import { EvidenceSchema, MechanicalVerificationSchema } from "../../shared/types/remediationOutcome.js";
import { PER_FINDING_DISPOSITIONS } from "./disposition.js";

/** One reviewed semantic plan, carrying immutable source provenance. */
export const RemediationPlanSchema = ExecutableChangePlanSchema.extend({
  goal_id: z.string().optional(),
  source: z.string().optional(),
  findings: z.array(FindingSchema),
  request: ExecutionRequestSchema.optional(),
  review_revision_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  review_counterexamples: z.array(PlanCounterexampleSchema).default([]),
  project_type: z.string(),
  test_command: z.string().optional(),
  e2e_command: z.string().optional(),
  test_command_source: z.enum(["project_facts", "explicit"]).optional(),
  e2e_command_source: z.enum(["project_facts", "explicit"]).optional(),
  candidate_closing_actions: z.array(z.enum(CLOSING_ACTIONS)),
  audit_read: AuditReadSchema.nullable().optional(),
}).strict();
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;

export const SourceVerificationSchema = z.object({
  disposition_override: z.enum(PER_FINDING_DISPOSITIONS).optional(),
  evidence: EvidenceSchema.optional(),
  recorded_by_module: z.string().min(1).optional(),
  mechanical_verification: MechanicalVerificationSchema.optional(),
  review_revision_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  head_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u).nullable().optional(),
}).strict();
export type SourceVerification = z.infer<typeof SourceVerificationSchema>;

export interface FindingDisposition {
  status: "ignored" | "declined";
  reason: string;
}

/**
 * Tool-owned binding for one emitted host workload. The host may write result
 * files, but it must not be able to rewrite the workload and then make the
 * rewritten prompt/baseline self-consistent. Persisting this digest in the
 * normal remediation state gives ingestion an independent value to verify.
 */
export const REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA1 =
  "remediation-host-handoff-record/v1alpha1" as const;
export const REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2 =
  "remediation-host-handoff-record/v1alpha2" as const;
export const REMEDIATION_HOST_SCOPE_SEMANTICS =
  "explicit-directory-markers/v1" as const;

export const ConformanceReviewBindingSchema = z.object({
  run_id: z.string().min(1),
  enabled: z.boolean(),
  checkpoint_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
}).strict();
export type ConformanceReviewBinding = z.infer<typeof ConformanceReviewBindingSchema>;

const RemediationHostHandoffBindingFields = {
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  baseline_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  workload_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Enforces persistence of the tool-minted required-review snapshot alongside this handoff. */
  conformance_policy_sha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  work_item_ids: z.array(z.string()).min(1),

};

const ExplicitScopeRemediationHostHandoffRecordSchema = z
  .object({
    contract_version: z.literal(REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2),
    scope_semantics: z.literal(REMEDIATION_HOST_SCOPE_SEMANTICS),
    ...RemediationHostHandoffBindingFields,
  })
  .strict();

export const RemediationHostHandoffRecordSchema = ExplicitScopeRemediationHostHandoffRecordSchema;
export type RemediationHostHandoffRecord = z.infer<
  typeof RemediationHostHandoffRecordSchema
>;

export const ClarificationRequestSchema = z
  .object({
    unit_id: z.string(),
    category: z.enum([
      "public_contract",
      "behavioral_semantics",
      "scope_of_fix",
      "dependency_introduction",
      "compatibility_policy",
      "intent_vs_symptom",
      "issue_appropriateness",
    ]),
    description: z.string(),
    options: z.array(z.string()).optional(),
  })
  .strict();
export type ClarificationRequest = z.infer<typeof ClarificationRequestSchema>;

/**
 * A worker's open question, carried ON the paused item
 * (`RemediationItemState.clarification_question`). The item is the ONE home of
 * the question: the clarification round lists every item whose status is
 * `needs_clarification`, so answering some questions can never erase the
 * others. A separate run-level question list used to be a second copy; clearing
 * it after a partial answer left the unanswered items with no question to show.
 */
export type ClarificationQuestion = Omit<ClarificationRequest, "unit_id">;

/** The canonical clarification categories (single-sourced from the schema). */
export const CLARIFICATION_CATEGORIES =
  ClarificationRequestSchema.shape.category.options;
export type ClarificationCategory = ClarificationRequest["category"];

/** Narrow an arbitrary value to a canonical clarification category. */
export function isClarificationCategory(
  value: unknown,
): value is ClarificationCategory {
  return (
    typeof value === "string" &&
    (CLARIFICATION_CATEGORIES as readonly string[]).includes(value)
  );
}

export const ClosingActionPreviewSchema = z
  .object({
    /** Approval is for this action, never an interchangeable close label. */
    action: z.enum(CLOSING_ACTIONS),
    custom_command: z.array(z.string()).optional(),
    /** Repo-relative paths that would be staged for the commit. */
    files: z.array(z.string()),
    /** Generated commit message derived from item summaries / finding titles. */
    commit_message: z.string(),
    /**
     * Currently-dirty repo-relative paths that are NEITHER in the run's edit
     * surface manifest nor a tool deliverable — pre-existing/unrelated user
     * changes `collectStagingFiles` deliberately leaves untouched (never staged,
     * never committed). Surfaced so the host can tell the user what was left
     * alone. Absent/omitted when there is nothing to report.
     */
    leftover_files: z.array(z.string()).optional(),
  })
  .strict();

export const ClosingPlanSchema = z
  .object({
    action: z.enum(CLOSING_ACTIONS),
    custom_command: z.array(z.string()).optional(),
    /**
     * When true, the host has explicitly confirmed the closing action preview and
     * the close phase may proceed to execute git/publish commands without an
     * additional confirmation prompt.
     */
    pre_authorized: z.boolean().optional(),
    /**
     * Set by the close phase before executing actions that require user
     * confirmation. Contains the staged file list and generated commit message so
     * the host can present them to the user. Cleared once the action executes.
     */
    closing_action_preview: ClosingActionPreviewSchema.optional(),
  })
  .strict();
export type ClosingPlan = z.infer<typeof ClosingPlanSchema>;

export interface CoverageLedgerEntry {
  finding_id: string;
  title?: string;
  disposition:
    | "planned"
    | "folded_into"
    | "dropped_no_evidence"
    | "dropped_by_checkpoint"
    | "dropped_phantom_paths"
    | "declined_by_review";
  unit_ids?: string[];
  folded_into?: string;
  rationale?: string;
  /** Phantom (non-existent) cited paths the grounding pass stripped. */
  phantom_paths_removed?: string[];
  /** Whether the finding's evidence cites a real repo path (extracted findings only). */
  evidence_grounded?: boolean;
  /**
   * Full original Finding payload (the shared `Finding` type, verbatim). Carried
   * for never-planned findings so the outcomes contract can record what was
   * dropped — without it the payload is lost once state.json is deleted at close.
   */
  finding?: Finding;
}

export interface CoverageLedger {
  contract_version: "remediate-code-coverage/v1alpha1";
  plan_id: string;
  source_finding_count: number;
  planned_count: number;
  folded_count: number;
  dropped_count: number;
  /** Findings excluded by the intent checkpoint (filters / excluded scope). */
  checkpoint_dropped_count: number;
  /** Findings dropped because every cited path was phantom (after one repair attempt). */
  phantom_dropped_count: number;
  /**
   * Findings the user disapproved at the review-approval gate (excluded from the
   * pipeline before planning). Optional + kept SEPARATE from the source-disposition
   * reconciliation (planned+folded+dropped+checkpoint+phantom === source_finding_count):
   * declined findings are never part of the planned source/node set, they are an
   * upstream exclusion, so they are counted here and appended as extra entries.
   */
  declined_review_count?: number;
  entries: CoverageLedgerEntry[];
}

/**
 * Retry-oriented final status of an outcomes item. Coarser than
 * `RemediationOutcomeStatus`: `fixed` covers resolved / verified-no-change,
 * `failed` covers blocked and force-closed non-terminal items, `skipped`
 * covers deemed-inappropriate items, `ignored` covers user-ignored items.
 */
export type RemediationOutcomeFinalStatus =
  | "fixed"
  | "failed"
  | "ignored"
  | "skipped"
  | "pending"
  | "deferred";

/**
 * One fully self-describing entry per finding in `remediation-outcomes.json`.
 * Extends the shared per-finding outcome so the file is retryable on its own:
 * close deletes state.json, so every payload a retry needs must be here.
 *
 * Runtime invariants (enforced by the close phase, not expressible in TS):
 * - `reason` is always a non-empty string when `final_status` is `skipped` or
 *   `ignored`.
 * - `original_state` is present exactly when the run was force-closed while
 *   this item was still non-terminal; such items get `final_status: "failed"`
 *   and a `reason` saying they were force-closed.
 */
export interface RemediationOutcomeItem extends RemediationOutcome {
  /** Full original Finding payload (the shared `Finding` type, verbatim). */
  finding: Finding;
  /** Every execution unit addressing this original source finding. */
  unit_ids: string[];
  unit_dependencies: string[];
  /** Retry-oriented final status (see `RemediationOutcomeFinalStatus`). */
  final_status: RemediationOutcomeFinalStatus;
  /**
   * The non-terminal `RemediationItemState["status"]` this item was in when the
   * run was force-closed. Absent for items that reached a terminal status.
   */
  original_state?: RemediationItemState["status"];
}

/** Why a never-planned finding was dropped before remediation started. */
export type NeverPlannedDropReason =
  | "cross_lens_dedup"
  | "intent_checkpoint"
  | "no_evidence"
  | "phantom_paths"
  | "review_gate";

/**
 * Coverage-ledger entry as written into `remediation-outcomes.json`: the plan's
 * `CoverageLedgerEntry` enriched with a `drop_reason` discriminator and (for
 * never-planned findings) the full `Finding` payload instead of a bare id.
 */
export interface OutcomeCoverageEntry extends CoverageLedgerEntry {
  /** Set on never-planned findings (folded / checkpoint- / evidence- / phantom-dropped). */
  drop_reason?: NeverPlannedDropReason;
}

/** The outcomes file's coverage-ledger section (enriched entries). */
export interface OutcomeCoverageLedger extends Omit<CoverageLedger, "entries"> {
  entries: OutcomeCoverageEntry[];
}

// Defined in ./disposition.js (below both this module and itemStatus.ts, which
// needs it — importing it from here closed a type-only cycle). Re-exported so
// existing importers are unchanged.
export type { PerFindingDisposition } from "./disposition.js";

export interface RemediationItemState {
  unit_id: string;
  status: RemediationItemStatus;
  last_successful_step?: string;
  failure_reason?: string;
  /** Prompt-bound evidence supplied for a verified no-change host outcome. */
  host_result_evidence?: string[];
  /** Validated successful semantic review receipt, retained through final outcomes. */
  conformance_review?: AcceptedConformanceReview;
  /**
   * WHAT LANDED for this item, persisted at acceptance — the corroborated
   * worktree outcome, not the host's claim. The result's `landed_commit` was
   * verified reachable from HEAD, and its diff-tree — persisted as
   * {@link host_landed_files} — was verified to lie inside the item's
   * prompt-bound write scope, so this is ground truth by the time it is written.
   *
   * It is persisted PER ITEM so a later boundary — the outcomes contract, the
   * report — can attribute the landing to this item without re-running the
   * ingest's git probes. `applied_edit_surface` is the run-wide union of
   * {@link host_landed_files}; this is the per-item attribution that union
   * cannot express.
   *
   * ITS READER IS `hasLandedCommitFor` (`steps/dispatch/hostHandoff.ts`), which
   * asks whether ANY finding of a work item carries one. The ingest uses that
   * answer to tell PARTIAL PROGRESS from unfinished work: a refusal that is
   * "nothing is at the bound path" splits on it, so an item whose edits landed
   * but whose result file is missing is reported to the host rather than
   * disappearing as a bare missing-result line.
   */
  host_landed_commit?: string;
  /** Repo-relative, path-sorted files the landed commit changed (see above). */
  host_landed_files?: string[];
  /** Times this item was sent back for rework via triage (Phase 7B outcomes). */
  rework_count?: number;
  /** ISO-8601 timestamp when this item first left pending. */
  started_at?: string;
  /** ISO-8601 timestamp when this item most recently reached a terminal status. */
  completed_at?: string;
  /** User's clarification answer, carried from applyClarificationResolution into the implement prompt. */
  clarification_context?: string;
  /**
   * The worker's open question. Required while `status` is
   * `needs_clarification` (the state store refuses a paused item without one),
   * and removed when the answer is applied. See {@link ClarificationQuestion}.
   */
  clarification_question?: ClarificationQuestion;
  /**
   * The failure context (failure_reason + last_successful_step) captured at
   * the time this item was queued for retry. Carried into re-dispatch prompts
   * so the worker knows what failed previously and avoids identical attempts.
   */
  failure_context?: string;
  /**
   * Times a worker returned a block result that did NOT cover this still-pending
   * finding — i.e. silently omitted its `item_results` entry (E2). Bounds the
   * incomplete-coverage re-dispatch so the run converges (blocks the finding once
   * the cap is hit) instead of re-dispatching the same worker indefinitely.
   */
  incomplete_coverage_attempts?: number;
}
