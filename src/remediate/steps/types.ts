export const REMEDIATION_STEP_CONTRACT_VERSION =
  "remediate-code-step/v1alpha1" as const;

export const REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION =
  "remediate-code-dispatch-plan/v1alpha1" as const;

export const REMEDIATION_WORKER_RESULT_CONTRACT_VERSION =
  "remediate-code-worker-result/v1alpha1" as const;

export type RemediationStepKind =
  | "confirm_intent"
  | "confirm_auto_discovered_input"
  | "confirm_resume_or_restart"
  | "locate_input"
  | "collect_starting_point"
  | "synthesize_intake"
  | "collect_intake_clarifications"
  | "contract_pipeline"
  | "lean_light_review"
  | "collect_review_approval"
  | "collect_clarifications"
  | "dispatch_implement"
  | "dispatch_implement_rolling"
  | "implement_rolling_sequential"
  | "quota_paused"
  | "phase_busy"
  | "collect_triage"
  | "close_run"
  | "present_report"
  | "input_conflict"
  | "unhandled_state"
  | "zero_documentable_findings"
  // Terminal-exit backstop (backlog: abnormal-exit no-step-contract): written by
  // the CLI when next-step dies on an unhandled error, so a stale prior step can
  // never read as a live instruction. Mirrors audit-code's "blocked" kind.
  | "blocked";

import type {
  StepStatus,
  DispatchModelHint,
  AccessDeclaration,
} from "audit-tools/shared";

// AccessDeclaration is single-sourced in audit-tools/shared; re-exported here
// (from the single import above) so existing importers of this module are
// unchanged. No local re-declaration / second `from "audit-tools/shared"`
// listing — that was the duplicate this consolidates.
export type { AccessDeclaration };

export type RemediationStepStatus = StepStatus;

export interface RemediationStep {
  contract_version: typeof REMEDIATION_STEP_CONTRACT_VERSION;
  step_kind: RemediationStepKind;
  status: RemediationStepStatus;
  prompt_path: string;
  run_id: string;
  repo_root: string;
  artifacts_dir: string;
  allowed_commands: string[];
  stop_condition: string;
  artifact_paths: Record<string, string>;
  access?: AccessDeclaration;
}

export type DispatchPhase = "document" | "implement";

export type {
  DispatchModelTier,
  DispatchModelHint,
} from "audit-tools/shared";

export interface DispatchPlanItem {
  task_id: string;
  finding_id?: string;
  block_id?: string;
  prompt_path: string;
  result_path: string;
  artifact_paths?: Record<string, string>;
  model_hint?: DispatchModelHint;
  access?: AccessDeclaration;
  /**
   * The node's estimated input-token cost — REQUIRED, and the ONE number every
   * fit gate reads (the hybrid frontier split, the in-process rolling engine,
   * and admission). Deliberately not optional and never defaulted: both gates
   * previously sized every node at a flat 2000, so neither could tell a large
   * node from a small one. A `?? <flat>` fallback here would silently reinstate
   * exactly that blindness for any producer that forgot to stamp it.
   *
   * Computed once by `prepareImplementDispatch` at the single point where the
   * rendered prompt exists on disk — a second derived number would desync the
   * plan from admission ("one node, one number").
   */
  estimated_input_tokens: number;
}

/**
 * A dispatch plan item before its token estimate is stamped on.
 * `estimateImplementSlotTokens` needs the RENDERED prompt on disk, so the
 * estimate cannot exist at item-construction time; the dispatch path completes
 * the draft immediately after writing the prompt, and the merge path — which
 * only needs identity and paths — consumes the draft as-is.
 */
export type DispatchPlanItemDraft = Omit<DispatchPlanItem, "estimated_input_tokens">;

export interface RemediationDispatchPlan {
  contract_version: typeof REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION;
  phase: DispatchPhase;
  run_id: string;
  repo_root: string;
  artifacts_dir: string;
  items: DispatchPlanItem[];
}

export interface ImplementWorkerItemResult {
  finding_id: string;
  status: "resolved" | "resolved_no_change" | "blocked" | "needs_clarification";
  evidence?: string[];
  failure_reason?: string;
  /**
   * Set with `status: "needs_clarification"` (note 3, part B): the scoping/
   * judgment question the worker hit, surfaced to the user as a real clarification
   * round rather than routed to triage as an execution failure. Optional
   * `clarification_category` narrows it to one of the canonical clarification
   * categories (defaults to `scope_of_fix`).
   */
  clarification_question?: string;
  clarification_category?: string;
}

export interface ImplementWorkerResult {
  contract_version: typeof REMEDIATION_WORKER_RESULT_CONTRACT_VERSION;
  phase: "implement";
  item_results: ImplementWorkerItemResult[];
  /**
   * Paths the worker edited outside its declared contract scope. Used by
   * `mergeImplementResults` to gate amendment claims through the ownership
   * registry: unowned paths are granted and added to the block's effective scope
   * for verification; owned/contended paths block the item and emit a seam
   * conflict event.
   */
  amended_files?: string[];
}

export const REMEDIATION_CLOSING_RESULT_CONTRACT_VERSION =
  "remediate-code-closing-result/v1alpha1" as const;

export type { HostConcurrencyLimitSource, HostConcurrencyLimit } from "audit-tools/shared";
export type {
  LimitSource,
  LimitConfidence,
  ResolvedLimits,
  BackoffState,
  WaveBindingCap,
  DispatchCapacityPoolSummary,
} from "audit-tools/shared";
export type { QuotaUsageSnapshot } from "audit-tools/shared";

import type {
  DispatchQuotaContract,
} from "audit-tools/shared";

/**
 * H5: alias of the SHARED dispatch-quota contract (per-mode fields `phase` /
 * `estimated_wave_tokens` are optional extensions of the one shape). Never a
 * second interface — the kept-in-parity fork is deleted.
 */
export type RemediationDispatchQuota = DispatchQuotaContract;
