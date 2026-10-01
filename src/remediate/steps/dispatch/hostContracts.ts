// sites-pinned: tests/remediate/host-handoff.test.ts, tests/remediate/host-handoff-corroboration.test.ts
import { SUBMISSION_ISSUE_CODES, WORKLOAD_ISSUE_CODES, type LaneDemand, type SubmissionIssue, type WorkItemOutcome } from "audit-tools/shared";
import { REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../state/store.js";
import type { RemediationPlan, RemediationItemState, RemediationHostHandoffRecord, ConformanceReviewBinding } from "../../state/types.js";
import { REMEDIATION_HOST_DECISION_CONTRACT_VERSION as DECISION_CONTRACT_VERSION, REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_CONTRACT_VERSION, REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION as WORKLOAD_CONTRACT_VERSION } from "../types.js";

export const CONFORMANCE_REVIEW_ISSUES = [
  "conformance_review_required", "conformance_review_unavailable", "conformance_review_insufficient",
] as const;
export type ConformanceReviewIssueCode = (typeof CONFORMANCE_REVIEW_ISSUES)[number];

export type UnsupportedRetiredRemediationState = "unsupported_retired_state";

export type CurrentRemediationHostState = RemediationState & {
  readonly contract_version: typeof REMEDIATION_STATE_CONTRACT_VERSION;
  readonly status: "implementing";
  readonly plan: RemediationPlan;
  readonly items: Record<string, RemediationItemState>;
};

export interface RemediationHostWorkItem {
  readonly id: string;
  readonly source_finding_ids: readonly string[];
  readonly allowed_files: readonly string[];
  readonly baseline_commit: string;
  /**
   * The contract obligation ids this item's landed work must satisfy — the
   * sorted, deduplicated union of `contract_obligation_ids` over the block's
   * findings (what promotion mints from each DAG node's
   * `satisfies_obligations`). Empty for a plan without contract overlays. The
   * result's `obligation_evidence` must cover exactly this set.
   */
  readonly obligation_ids: readonly string[];
  readonly prompt: {
    readonly text: string;
    readonly sha256: string;
  };
  readonly required_tests: readonly string[];
  readonly result_path: string;
  /**
   * The lane's demand ranking (size / complexity / risk) — the same shared
   * shape the audit draw emits, so a host matching a backend to work reads one
   * vocabulary from both halves of the pipeline. Names DEMAND only: never a
   * backend, provider, model or tier (see `LaneDemandSchema`).
   */
  readonly demand: LaneDemand;
  readonly token_estimate: number;
}

export interface RemediationHostWorkload {
  readonly contract_version: typeof WORKLOAD_CONTRACT_VERSION;
  readonly run_id: string;
  readonly work_items: readonly RemediationHostWorkItem[];
}

export interface PreparedRemediationHostHandoff {
  readonly workload: RemediationHostWorkload;
  readonly workload_path: string;
  readonly conformance_review: ConformanceReviewBinding;
  /** Persist this in RemediationState before exposing the workload to the host. */
  readonly handoff_record: RemediationHostHandoffRecord;
}

/**
 * Remediation's issue vocabulary: the SHARED submission codes plus this draw's
 * own domain corroboration codes.
 *
 * The submission half is imported, never restated — a submission that is
 * missing, unparseable, contract-invalid, or a duplicate identity means exactly
 * the same thing on both sides of the pipeline, and the two used to spell it
 * differently (`result_missing` here, a bare `null` in the audit ingest). The
 * git/worktree/test half stays here: audit has no analogue and dragging
 * `commit_not_landed` into the shared core would suggest it could emit one.
 */
export const REMEDIATION_ISSUE_CODES = [
  ...SUBMISSION_ISSUE_CODES,
  "workload_missing",
  "workload_invalid",
  "trusted_binding_missing",
  "commit_missing",
  "commit_not_landed",
  "baseline_not_ancestor",
  "changed_files_mismatch",
  "run_start_dirty_overlap",
  "required_test_failed",
  /**
   * A required test exceeded its deadline. DISTINCT from `required_test_failed`
   * by code alone: a hung suite and a genuine red are different facts about the
   * work, and telling them apart must not require parsing a joined message.
   */
  "required_test_timed_out",
  /**
   * A required test produced more output than the capture buffer holds, so the
   * runner killed it. NOT a verdict on the tests: the child was terminated by
   * the capture cap, and whether the suite would have passed is unknown. It has
   * its own code because it was previously indistinguishable from a hang — node
   * kills an over-buffer child with a signal, which the old discriminator read
   * as a deadline miss.
   */
  "required_test_output_overflow",
  /**
   * A plan block declares a dependency id that exists in NO block of the plan.
   * The block is unschedulable — never level 0 — and the producer bug is named
   * rather than absorbed.
   */
  "dependency_missing",
  /**
   * A block arrived outside the normalized write-scope / declared-command shape
   * this boundary consumes (artifact:normalized-block-write-scope). Refused, not
   * silently normalized: a silently sorted, deduped or re-rooted write scope
   * hides the producer bug and widens what a host may touch.
   */
  "block_contract_invalid",
  /**
   * A recovery-mode acceptance could not be marked on the submission ledger, so
   * it was refused. An acceptance that used the relaxation MUST stay
   * distinguishable from a clean one; an unrecordable mark is a refusal, never
   * a silent acceptance.
   */
  "recovery_unrecorded",
  /**
   * The repository HEAD moved between the recovery verb's unlocked test phase
   * and its locked write phase, so the pre-computed test verdicts describe a
   * tree that is no longer current. The whole recovery aborts.
   */
  "tree_moved_between_phases",
  /**
   * The run's own WORKLOAD BINDING changed between the recovery verb's unlocked
   * test phase and its locked write phase — the sibling of
   * `tree_moved_between_phases` for a concurrent state writer that settles items
   * and re-mints the binding without moving a commit. The pre-computed verdicts
   * describe work that is no longer pending, so the whole recovery aborts.
   */
  "state_moved_between_phases",
  /**
   * The work item's baseline commit is not in this repository, so nothing can
   * be corroborated against it. The run's recorded state is at fault, not the
   * result.
   */
  "baseline_missing",
  /**
   * The work item's baseline commit exists but is no longer an ancestor of HEAD
   * (history was rewritten under the run). The spawn-free `recover-ingest` verb
   * is the named repair; no worker can make it.
   */
  "baseline_orphaned",
  /**
   * `landed_commit` names a commit that cannot be this item's landed work: the
   * baseline itself, or a commit whose diff against the baseline is empty.
   */
  "landed_commit_invalid",
  /**
   * A result names a work item that the persisted workload binds but that is no
   * longer pending (it settled, or its dependencies are not complete).
   */
  "work_item_not_eligible",
  // `workload_stale` is shared with the audit draw: its meaning and its remedy
  // live beside `WORKLOAD_ISSUE_CODES`.
  ...WORKLOAD_ISSUE_CODES,
  ...CONFORMANCE_REVIEW_ISSUES,
] as const;

export type RemediationIssueCode = (typeof REMEDIATION_ISSUE_CODES)[number];

export type RemediationHostIngestIssue = SubmissionIssue<RemediationIssueCode> & { readonly review_request_path?: string };

export interface RemediationHostIngestSummary {
  readonly accepted_count: number;
  readonly completed_work_item_ids: readonly string[];
  readonly pending_work_item_ids: readonly string[];
  readonly issues: readonly RemediationHostIngestIssue[];
  /**
   * Every work item this ingest OBSERVED, by the outcome it observed — so a
   * caller never has to re-derive progress from the issue list, where an item
   * with no result file and an item whose write succeeded but whose result is
   * missing both used to read as the same absence.
   *
   * Keyed by work item id; content-sorted on insertion so a re-ingest of an
   * unchanged frontier produces byte-identical content.
   */
  readonly work_item_outcomes: ReadonlyMap<string, WorkItemOutcome>;
  readonly state_changed: boolean;
  readonly state: CurrentRemediationHostState;
}

export interface RemediationHostResult {
  readonly contract_version: typeof RESULT_CONTRACT_VERSION;
  readonly result_id: string;
  readonly run_id: string;
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  /**
   * The full id of the one commit that carries this item's edits, on HEAD.
   * The ONLY fact about the work the host states (v1alpha3, owner review of
   * prompt 20, 2026-09-18): the changed files come from git, the tests from the
   * tool's own rerun of `required_tests`, and the landing from ancestry — so a
   * host is never asked to restate what the tool derives and then checks.
   */
  readonly landed_commit: string;
  /**
   * Cited evidence per satisfied contract obligation — the evidence-coverage
   * floor between "received" and "accepted". Must cover exactly the work
   * item's bound `obligation_ids` (empty when none are bound); each entry
   * cites at least one non-empty string. Coverage is validated mechanically at
   * ingestion; judging the citations' semantic sufficiency is the per-run
   * conformance review's job, never this parser's.
   */
  readonly obligation_evidence: readonly {
    readonly obligation_id: string;
    readonly evidence: readonly string[];
  }[];
}

export interface RemediationHostDecision {
  readonly contract_version: typeof DECISION_CONTRACT_VERSION;
  readonly result_id: string;
  readonly run_id: string;
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly outcome:
    | { readonly status: "resolved_no_change"; readonly evidence: readonly string[] }
    | { readonly status: "blocked"; readonly failure_reason: string }
    | {
        readonly status: "needs_clarification";
        readonly question: string;
        readonly category?: string;
      };
}
