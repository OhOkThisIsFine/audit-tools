import type { ClosingAction } from "./closingActions.js";
import type { RemediationItemStatus } from "./itemStatus.js";

// `Finding` is the canonical machine contract owned by @audit-tools/shared.
// The remediator consumes the auditor's `audit-findings.json` directly, so it
// uses the shared shape verbatim rather than a divergent local copy. Imported
// (so it is in scope for the types below) and re-exported for existing callers.
import type { Finding, FindingTheme, RemediationOutcome } from "@audit-tools/shared";
export type { Finding };

export interface RemediationBlock {
  block_id: string;
  items: string[];
  parallel_safe: boolean;
  dependencies?: string[];
  /**
   * Commands to run as a post-merge verification gate after this block's
   * worktree branch is merged into the main tree. When present, these are
   * preferred over `RemediationPlan.test_command` for the gate check.
   */
  targeted_commands?: string[];
  /**
   * Repo-relative paths that this block's implementation is expected to touch.
   * Used by `attributePostMergeFailure` to identify which merged blocks share
   * an implicated surface when the post-merge gate fails.
   */
  touched_files?: string[];
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

export interface ClosingActionPreview {
  /** Repo-relative paths that would be staged for the commit. */
  files: string[];
  /** Generated commit message derived from item summaries / finding titles. */
  commit_message: string;
}

export interface ClosingPlan {
  action: ClosingAction;
  custom_command?: string[];
  /**
   * When true, the host has explicitly confirmed the closing action preview and
   * the close phase may proceed to execute git/publish commands without an
   * additional confirmation prompt.
   */
  pre_authorized?: boolean;
  /**
   * Set by the close phase before executing actions that require user
   * confirmation. Contains the staged file list and generated commit message so
   * the host can present them to the user. Cleared once the action executes.
   */
  closing_action_preview?: ClosingActionPreview;
}

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
  block_id?: string;
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
  | "skipped";

/**
 * Typed subset of `ItemSpec` carried on each outcomes item — the documented
 * fields a retry needs without re-running the document phase.
 */
export interface ItemSpecSummary
  extends Pick<ItemSpec, "concrete_change" | "no_change" | "touched_files"> {
  /** Names of the tests the document phase specified (`ItemSpec.tests_to_write[].name`). */
  tests_to_write: string[];
}

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
  /** Summary of the documented `ItemSpec`; absent when never documented. */
  item_spec?: ItemSpecSummary;
  /** Owning block id (`RemediationBlock.block_id`). */
  block_id: RemediationBlock["block_id"];
  /** The owning block's dependency block ids (`RemediationBlock.dependencies`). */
  block_dependencies: string[];
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

// ── Per-finding / per-node coverage ledger (N-coverage-ledger) ───────────────

/**
 * How the denominator for this ledger was derived. Determines what counts as
 * "complete" and drives the `assertLedgerComplete` gate (INV-CL-05).
 *
 * - `finding_enumeration`: structured_audit source — every finding-id from
 *   `finding-enumeration.json` must appear exactly once among the items.
 * - `dag_node`: document / non-enumerable source — every promoted
 *   implementation-DAG node must reach a terminal disposition.
 */
export type PerFindingDenominatorKind = "finding_enumeration" | "dag_node";

/**
 * Disposition of a single finding or DAG-node within the per-finding ledger.
 * Only terminal dispositions count toward coverage (INV-CL-05 fail-closed rule).
 */
export type PerFindingDisposition =
  | "resolved"
  | "resolved_no_change"
  | "ignored"
  | "deemed_inappropriate"
  | "force_closed_unresolved";

/** Single entry in `PerFindingCoverageLedger.entries`. */
export interface PerFindingLedgerEntry {
  /** Finding id (structured_audit) or promoted DAG-node id (document source). */
  id: string;
  disposition: PerFindingDisposition;
}

/**
 * Per-finding / per-node coverage ledger — source_type-aware denominator.
 *
 * For `structured_audit` sources the denominator is the complete
 * `finding-enumeration.json` set; for document / non-enumerable sources the
 * denominator is the set of promoted implementation-DAG nodes.  A 0/0 ledger
 * is INCOMPLETE (fail-closed) — zero denominator never counts as vacuously
 * complete (INV-CL-05).
 */
export interface PerFindingCoverageLedger {
  /** Discriminates structured vs. document/non-enumerable sources. */
  denominator_kind: PerFindingDenominatorKind;
  /** Total items expected (finding-enumeration count or promoted-node count). */
  denominator: number;
  /** Items that reached a terminal disposition (len(entries) after build). */
  covered: number;
  entries: PerFindingLedgerEntry[];
}

export interface RemediationItemState {
  finding_id: string;
  status: RemediationItemStatus;
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
  /** User's clarification answer, carried from applyClarificationResolution into the implement prompt. */
  clarification_context?: string;
  /**
   * The failure context (failure_reason + last_successful_step) captured at
   * the time this item was queued for retry. Carried into re-dispatch prompts
   * so the worker knows what failed previously and avoids identical attempts.
   */
  failure_context?: string;
  /**
   * Times this item was sent back for rework due to infrastructure failures
   * (quota, rate-limit, EPERM, timeout, tool crash, provider error). Split from
   * `rework_count` so the two failure classes can have independent retry budgets.
   */
  infra_rework_count?: number;
}
