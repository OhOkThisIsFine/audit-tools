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
  | "collect_clarifications"
  | "classify_impl_risks"
  | "preview_implement"
  | "dispatch_implement"
  | "implement_rolling_sequential"
  | "collect_triage"
  | "close_run"
  | "present_report"
  | "input_conflict"
  | "unhandled_state"
  | "zero_documentable_findings";

import type {
  StepStatus,
  DispatchModelHint,
  AccessDeclaration,
} from "@audit-tools/shared";

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
  AccessDeclaration,
} from "@audit-tools/shared";

export interface DispatchPlanItem {
  task_id: string;
  finding_id?: string;
  block_id?: string;
  prompt_path: string;
  result_path: string;
  artifact_paths?: Record<string, string>;
  model_hint?: DispatchModelHint;
  access?: AccessDeclaration;
}

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
  status: "resolved" | "blocked";
  evidence?: string[];
  failure_reason?: string;
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

export const REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION =
  "remediate-code-dispatch-quota/v1alpha2" as const;

export type { HostConcurrencyLimitSource, HostConcurrencyLimit } from "@audit-tools/shared";
export type {
  LimitSource,
  LimitConfidence,
  ResolvedLimits,
  BackoffState,
  WaveBindingCap,
  DispatchCapacityPoolSummary,
} from "@audit-tools/shared";
export type { QuotaUsageSnapshot } from "@audit-tools/shared";

import type {
  HostConcurrencyLimit,
  LimitSource,
  LimitConfidence,
  ResolvedLimits,
  BackoffState,
  QuotaUsageSnapshot,
  WaveBindingCap,
  DispatchCapacityPoolSummary,
} from "@audit-tools/shared";

export interface RemediationDispatchQuota {
  contract_version:
    | typeof REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION
    | "remediate-code-dispatch-quota/v1alpha1";
  run_id: string;
  phase: DispatchPhase;
  host_concurrency_limit: HostConcurrencyLimit | null;
  max_concurrent_agents: number;
  estimated_wave_tokens: number;
  model: string | null;
  confidence: LimitConfidence;
  source: LimitSource;
  resolved_limits: ResolvedLimits;
  cooldown_until: string | null;
  binding_cap?: WaveBindingCap;
  capacity_pools?: DispatchCapacityPoolSummary[];
  quota_source_snapshot?: QuotaUsageSnapshot | null;
  backoff_state?: BackoffState | null;
}
