import { z } from "zod";
import { CLOSING_ACTIONS } from "./closingActions.js";
import type { RemediationItemStatus } from "./itemStatus.js";

// `Finding` is the canonical machine contract owned by audit-tools/shared.
// The remediator consumes the auditor's `audit-findings.json` directly, so it
// uses the shared shape verbatim rather than a divergent local copy. Imported
// (so it is in scope for the types below) and re-exported for existing callers.
import type {
  Finding,
  RemediationOutcome,
  MechanicalVerification,
} from "audit-tools/shared";
import { FindingSchema, FindingThemeSchema } from "audit-tools/shared";
export type { Finding };

// `Evidence` is a brand-new export of `src/shared/types/remediationOutcome.ts`
// (CDC-25/CDC-28), not yet re-exported through the `audit-tools/shared` barrel
// (`src/shared/index.ts` — outside this module's file_scope and this work
// item's allowed_files). Imported by its real relative path rather than
// through the barrel; both resolve the same source file, and
// `check:depgraph`'s `shared-imports-no-orchestrator` rule only forbids the
// opposite direction (`src/shared` importing `src/remediate`), so a
// `src/remediate` module reaching down into `src/shared` this way is exactly
// the allowed direction.
import type { Evidence } from "../../shared/types/remediationOutcome.js";
// Local usage (RemediationItemState.disposition_override below) alongside the
// existing re-export-only statement further down this file, which does not by
// itself bring the name into this module's local scope.
import type { PerFindingDisposition } from "./disposition.js";

export const RemediationBlockSchema = z
  .object({
    block_id: z.string(),
    items: z.array(z.string()),
    /**
     * Whether this block may run concurrently with its peers. First-class on the
     * block contract (not derived host-side) so the scheduler reads one source.
     */
    parallel_safe: z.boolean(),
    /**
     * Block ids that must complete before this block runs. First-class (the
     * serialized schema-first chain head, CE-001): producers emit it, the
     * scheduler consumes it. Optional — absence means no upstream dependency.
     */
    dependencies: z.array(z.string()).optional(),
    /**
     * Commands to run as a post-merge verification gate after this block's
     * worktree branch is merged into the main tree. When present, these are
     * preferred over `RemediationPlan.test_command` for the gate check.
     */
    targeted_commands: z.array(z.string()).optional(),
    /**
     * Repo-relative paths that this block's implementation is expected to touch.
     * First-class and REQUIRED (an empty array is allowed, an omitted field is
     * rejected by `validateRemediationBlock` — which the state LOAD gate
     * delegates to, so the requirement holds on every path a block reaches a
     * consumer through): the file-ownership-disjoint scheduler and
     * `blockResolvedItemsOnCombinedFailure` both read it, so a block with no declared
     * surface is a producer bug, not an implicit empty.
     */
    touched_files: z.array(z.string()),
    /**
     * 0-based foundations→consumers phase ordinal (auto-phasing, T3). Derived
     * mechanically at promotion from the persisted phase cut (the module a block's
     * obligations belong to). The host handoff treats it as a hard barrier: a
     * block is never emitted until every lower-ordinal block is verified-complete,
     * giving a per-phase whole-repo green checkpoint. Optional — absent (or all
     * blocks sharing one ordinal) means a single phase, i.e. no barrier.
     */
    phase_ordinal: z.number().int().nonnegative().optional(),
    /**
     * Whether the blocks sharing a co-file (same touched path) may still run in
     * parallel because their edit regions are disjoint. Additive + optional:
     * absence is equivalent to `false` (co-file blocks serialize by default), and
     * a pre-existing block with no such key still validates. Deliberately a bare
     * boolean — no WriteRegion / WriteAnchor / anchor apparatus lives on the block.
     */
    cofile_parallel_safe: z.boolean().optional(),
    /**
     * Deterministic advisory size derived from this block's unique physical
     * files. It is metadata for the host, never a backend-fit claim.
     */
    token_estimate: z.number().int().nonnegative().optional(),
    /**
     * The APPROVED finalized module contract(s) this block implements
     * (open-bugs.md:474). Attached VERBATIM at promotion by resolving each DAG
     * node's obligation-id slugs against `finalized_module_contracts`, and
     * carried into the sha-bound dispatch prompt so a worker conforms to the
     * approved interface instead of inventing a locally plausible one that
     * contradicts it. Optional — a plan from outside the contract pipeline has
     * no module contracts.
     */
    module_contracts: z
      .array(
        z
          .object({
            module: z.string(),
            contract: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type RemediationBlock = z.infer<typeof RemediationBlockSchema>;

export const RemediationPlanSchema = z
  .object({
    plan_id: z.string(),
    goal_id: z.string().optional(),
    source: z.string().optional(),
    findings: z.array(FindingSchema),
    blocks: z.array(RemediationBlockSchema),
    project_type: z.string(),
    test_command: z.string().optional(),
    e2e_command: z.string().optional(),
    candidate_closing_actions: z.array(z.enum(CLOSING_ACTIONS)),
    block_strategy: z
      .enum(["test_graph", "git_cocommit", "file_overlap", "manual"])
      .optional(),
    /** Synthesis themes carried from audit-findings.json (Phase 6/7 fix hints). */
    themes: z.array(FindingThemeSchema).optional(),
  })
  .strict();
export type RemediationPlan = z.infer<typeof RemediationPlanSchema>;

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

const RemediationHostHandoffBindingFields = {
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
  baseline_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
  workload_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  work_item_ids: z.array(z.string()).min(1),
};

const LegacyRemediationHostHandoffRecordSchema = z
  .object({
    contract_version: z.literal(REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA1),
    ...RemediationHostHandoffBindingFields,
  })
  .strict();

const ExplicitScopeRemediationHostHandoffRecordSchema = z
  .object({
    contract_version: z.literal(REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2),
    scope_semantics: z.literal(REMEDIATION_HOST_SCOPE_SEMANTICS),
    ...RemediationHostHandoffBindingFields,
  })
  .strict();

export const RemediationHostHandoffRecordSchema = z.discriminatedUnion(
  "contract_version",
  [
    LegacyRemediationHostHandoffRecordSchema,
    ExplicitScopeRemediationHostHandoffRecordSchema,
  ],
);
export type RemediationHostHandoffRecord = z.infer<
  typeof RemediationHostHandoffRecordSchema
>;

export const ClarificationRequestSchema = z
  .object({
    finding_id: z.string(),
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

// Defined in ./disposition.js (below both this module and itemStatus.ts, which
// needs it — importing it from here closed a type-only cycle). Re-exported so
// existing importers are unchanged.
export type { PerFindingDisposition } from "./disposition.js";

export interface RemediationItemState {
  finding_id: string;
  status: RemediationItemStatus;
  block_id: string;
  last_successful_step?: string;
  failure_reason?: string;
  /** Prompt-bound evidence supplied for a verified no-change host outcome. */
  host_result_evidence?: string[];
  /**
   * Item C — close-gate mechanical re-verify verdict for an analyzer-born
   * finding (set by `verifyAnalyzerLeads`; copied into the outcomes contract).
   */
  mechanical_verification?: MechanicalVerification;
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
   * Times a worker returned a block result that did NOT cover this still-pending
   * finding — i.e. silently omitted its `item_results` entry (E2). Bounds the
   * incomplete-coverage re-dispatch so the run converges (blocks the finding once
   * the cap is hit) instead of re-dispatching the same worker indefinitely.
   */
  incomplete_coverage_attempts?: number;
  /**
   * CDC-25/CDC-26 — SOURCE-SIDE SHAPE. The per-finding verification-evidence
   * triple (file/line/mechanism) a producing module RECORDS onto this item at
   * its OWN phase (INV-COVERAGE's "evidence producer" half) before the single
   * run-terminal `runClosePhase` PERSISTS it (INV-ISC-EVIDENCE-EMITTED). A
   * runtime data flow through this already-existing state item, not a
   * build-phase dependency: no cross-phase artifact token is minted for it.
   * This field lives here — inside item-status-partition-and-close's own
   * file_scope — and is therefore owned BY SCOPE, not by a clause 1(c)
   * declaration (that channel is only for a file outside every module's
   * file_scope, as `src/shared/types/remediationOutcome.ts` needed one for the
   * matching widened record shape). No other module edits this file.
   */
  evidence?: Evidence;
  /**
   * CDC-25 — which module recorded {@link evidence} (and, where set,
   * {@link disposition_override}) for this finding. Carried byte-exact into the
   * emitted outcome record's `recorded_by_module` (the ATTRIBUTION ROUND-TRIP)
   * so the 26 INV-COVERAGE joins' condition (3) can still tell which module
   * closed which id — the writer must never re-derive this or drop it.
   */
  recorded_by_module?: string;
  /**
   * CDC-25 — a producing module's own-phase determination that this finding's
   * true disposition is `verified_already_fixed` or `refuted` rather than the
   * disposition ordinarily derived from {@link status} alone.
   * `RemediationItemStatus` stays a closed 12-member enum with no
   * `verified_already_fixed`/`refuted` values of its own; the two new
   * `PerFindingDisposition` members are reached ONLY through this explicit
   * override (see `resolveDisposition` in `itemStatus.ts`), and only honoured
   * by the writer when this item's {@link status} is terminal and its
   * {@link evidence} triple is complete (INV-ISC-EVIDENCE-EMITTED) — an
   * incomplete triple makes the writer refuse the override and fall back to a
   * non-terminal, force-closed outcome instead of a green close on assertion
   * alone.
   */
  disposition_override?: PerFindingDisposition;
}
