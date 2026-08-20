export const REMEDIATION_STEP_CONTRACT_VERSION =
  "remediate-code-step/v1alpha1" as const;

export const REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION =
  "remediate-code-dispatch-plan/v1alpha1" as const;

export const REMEDIATION_WORKER_RESULT_CONTRACT_VERSION =
  "remediate-code-worker-result/v1alpha1" as const;

// ── The LIVE host-handoff wire contracts ────────────────────────────────────
//
// Single-sourced here rather than kept private to the host-handoff module,
// because the artifact validator has to recognize the very documents the
// handoff mints. While these lived in one module the validator could only scan
// for names nothing writes, which is precisely how its discovery filters came
// to match zero files on every live run.

export const REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION =
  "remediation-host-workload/v1alpha1" as const;

export const REMEDIATION_HOST_RESULT_CONTRACT_VERSION =
  "remediation-host-result/v1alpha1" as const;

export const REMEDIATION_HOST_DECISION_CONTRACT_VERSION =
  "remediation-host-decision/v1alpha1" as const;

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

import type { StepStatus, AccessDeclaration } from "audit-tools/shared";

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

export const REMEDIATION_CLOSING_RESULT_CONTRACT_VERSION =
  "remediate-code-closing-result/v1alpha1" as const;
