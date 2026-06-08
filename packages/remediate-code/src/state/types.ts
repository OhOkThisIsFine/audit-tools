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
  goal_id?: string;
  source?: string;
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

/**
 * Canonical names of the bounded remediation steps. Defined as named constants
 * (rather than bare string literals scattered across the phases) so the
 * implement phase, the validator, and the item-spec contract share one source
 * of truth for these magic strings.
 */
export const REMEDIATION_STEP = {
  DOCUMENT: "Document",
  WRITE_TESTS: "Write Tests",
  REFACTOR_CODE: "Refactor Code",
  VERIFY_AGAINST_TESTS: "Verify Code Against Tests",
  VERIFY_AGAINST_DOCUMENTATION: "Verify Code Against Documentation",
} as const;

export type RemediationStepName =
  (typeof REMEDIATION_STEP)[keyof typeof REMEDIATION_STEP];

export interface ItemSpec {
  finding_id: string;
  concrete_change: string;
  no_change?: boolean;
  /**
   * Repo-relative paths the fix will create or modify, as declared by the
   * document worker. The document phase can correct or extend the finding's
   * pre-document affected_files (e.g. when the real fix lives elsewhere); block
   * access is recomputed from this union so the implementer may write them.
   */
  touched_files?: string[];
  tests_to_write: {
    name: string;
    assertions: string[];
  }[];
  not_applicable_steps: {
    step: RemediationStepName;
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
  reason?: string[];
}

export interface TriageBatch {
  items: {
    finding_id: string;
    failure_reason: string;
    last_successful_step: string;
  }[];
}

export interface CoverageLedgerEntry {
  finding_id: string;
  title?: string;
  disposition: "planned" | "folded_into" | "dropped_no_evidence";
  block_id?: string;
  folded_into?: string;
  rationale?: string;
}

export interface CoverageLedger {
  contract_version: "remediate-code-coverage/v1alpha1";
  plan_id: string;
  source_finding_count: number;
  planned_count: number;
  folded_count: number;
  dropped_count: number;
  entries: CoverageLedgerEntry[];
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
  /** ISO-8601 timestamp when this item first left pending. */
  started_at?: string;
  /** ISO-8601 timestamp when this item most recently reached a terminal status. */
  completed_at?: string;
}
