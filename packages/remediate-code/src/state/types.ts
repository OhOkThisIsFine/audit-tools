import type { ClosingAction } from "./closingActions.js";

// `Finding` is the canonical machine contract owned by @audit-tools/shared.
// The remediator consumes the auditor's `audit-findings.json` directly, so it
// uses the shared shape verbatim rather than a divergent local copy. Imported
// (so it is in scope for the types below) and re-exported for existing callers.
import type { Finding, FindingTheme } from "@audit-tools/shared";
export type { Finding };

export interface RemediationBlock {
  block_id: string;
  items: string[];
  parallel_safe: boolean;
  dependencies?: string[];
}

export interface RemediationPlan {
  plan_id: string;
  findings: Finding[];
  blocks: RemediationBlock[];
  project_type: string;
  test_command?: string;
  e2e_command?: string;
  candidate_closing_actions: ClosingAction[];
  block_strategy?: "test_graph" | "git_cocommit" | "file_overlap" | "manual";
  /** Synthesis themes carried from audit-findings.json (Phase 6/7 fix hints). */
  themes?: FindingTheme[];
}

export interface ItemSpec {
  finding_id: string;
  concrete_change: string;
  no_change?: boolean;
  tests_to_write: {
    name: string;
    assertions: string[];
  }[];
  not_applicable_steps: {
    step:
      | "Document"
      | "Write Tests"
      | "Refactor Code"
      | "Verify Code Against Tests"
      | "Verify Code Against Documentation";
    rationale: string;
  }[];
}

export interface ClarificationRequest {
  finding_id: string;
  category:
    | "public_contract"
    | "behavioral_semantics"
    | "scope_of_fix"
    | "dependency_introduction"
    | "compatibility_policy"
    | "intent_vs_symptom"
    | "issue_appropriateness";
  description: string;
  options?: string[];
}

export interface ClosingPlan {
  action: ClosingAction;
  custom_command?: string[];
}

export interface TestSpec {
  finding_id: string;
  test_file: string;
  test_name: string;
  assertions: string[];
  status: "pending" | "written" | "failing" | "passing";
}

export interface VerificationResult {
  finding_id: string;
  passed: boolean;
  reason?: string;
}

export interface TriageBatch {
  items: {
    finding_id: string;
    failure_reason: string;
    last_successful_step: string;
  }[];
}

export interface RemediationItemState {
  finding_id: string;
  status:
    | "pending"
    | "documented"
    | "tested"
    | "tested_successfully"
    | "refactored"
    | "verified"
    | "resolved"
    | "resolved_no_change"
    | "blocked"
    | "deemed_inappropriate"
    | "ignored";
  block_id: string;
  item_spec?: ItemSpec;
  last_successful_step?: string;
  failure_reason?: string;
  /** Times this item was sent back for rework via triage (Phase 7B outcomes). */
  rework_count?: number;
}
