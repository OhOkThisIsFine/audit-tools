import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  AUDIT_TOOLS_DIRNAME,
  headCommit,
  commandLeavesDeclaredShape,
  FindingSchema,
  SUBMISSION_ISSUE_CODES,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  appendSubmissionEvent,
  compareCodeUnits,
  contentSha256,
  hasExactKeys,
  hostHandoffResultPath,
  idsAreStrictlyAscending,
  isCommit,
  isGitRepo,
  isRecord,
  isSha256,
  normalizeRepoPath,
  parseAllWorkloadItems,
  parseCommandString,
  parseWorkloadEnvelope,
  promptSha256,
  readSubmissionDocument,
  readSubmissionLedger,
  repoRelativePath,
  resolveContainedPath,
  resolveHostHandoffPaths,
  resultIdentityIsBound,
  runTrackedAsync,
  sameStrings,
  scanBoundSubmission,
  stringArray,
  spawnSyncHidden,
  stableStringify,
  writeJsonFile,
  type SubmissionIssue,
  type SubmissionLedgerEvent,
  type SubmissionScanMessages,
} from "audit-tools/shared";
import type { RemediationState } from "../../state/store.js";
import {
  RemediationHostHandoffRecordSchema,
  RemediationPlanSchema,
  isClarificationCategory,
  type RemediationBlock,
  type RemediationHostHandoffRecord,
  type RemediationItemState,
  type RemediationPlan,
} from "../../state/types.js";
import {
  ITEM_STATUSES,
  isTerminalStatus,
  isVerifiedCompleteStatus,
} from "../../state/itemStatus.js";

import {
  REMEDIATION_HOST_DECISION_CONTRACT_VERSION as DECISION_CONTRACT_VERSION,
  REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_CONTRACT_VERSION,
  REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION as WORKLOAD_CONTRACT_VERSION,
} from "../types.js";

const STATE_CONTRACT_VERSION = "remediate-code-state/v1alpha1" as const;
const HANDOFF_RECORD_CONTRACT_VERSION =
  "remediation-host-handoff-record/v1alpha1" as const;

export type UnsupportedRetiredRemediationState = "unsupported_retired_state";

export type CurrentRemediationHostState = RemediationState & {
  readonly contract_version: typeof STATE_CONTRACT_VERSION;
  readonly status: "implementing";
  readonly plan: RemediationPlan;
  readonly items: Record<string, RemediationItemState>;
};

export interface RemediationHostWorkItem {
  readonly id: string;
  readonly finding_ids: readonly string[];
  readonly allowed_files: readonly string[];
  readonly baseline_commit: string;
  readonly prompt: {
    readonly text: string;
    readonly sha256: string;
  };
  readonly required_tests: readonly string[];
  readonly result_path: string;
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
] as const;

export type RemediationIssueCode = (typeof REMEDIATION_ISSUE_CODES)[number];

export type RemediationHostIngestIssue = SubmissionIssue<RemediationIssueCode>;

export interface RemediationHostIngestSummary {
  readonly accepted_count: number;
  readonly completed_work_item_ids: readonly string[];
  readonly pending_work_item_ids: readonly string[];
  readonly issues: readonly RemediationHostIngestIssue[];
  readonly state_changed: boolean;
  readonly state: CurrentRemediationHostState;
}

interface BoundaryPaths {
  readonly root: string;
  readonly artifactsDir: string;
  readonly workloadPath: string;
  readonly resultDir: string;
}

interface RemediationHostResult {
  readonly contract_version: typeof RESULT_CONTRACT_VERSION;
  readonly result_id: string;
  readonly run_id: string;
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly changed_files: readonly string[];
  readonly commit_evidence: {
    readonly before: string;
    readonly after: string;
  };
  readonly test_evidence: readonly {
    readonly command: string;
    readonly status: "passed";
  }[];
  readonly worktree_evidence: {
    readonly baseline_commit: string;
    readonly changed_files: readonly string[];
  };
  readonly acceptance: { readonly status: "accepted" };
  readonly merge: { readonly status: "merged" };
}

interface RemediationHostDecision {
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

const CURRENT_STATE_KEYS = new Set([
  "applied_edit_surface",
  "clarifications",
  "closing_context",
  "closing_plan",
  "contract_version",
  "items",
  "host_handoff",
  "plan",
  "plan_coverage",
  "run_start_dirty",
  "started_at",
  "status",
  "step_count",
]);

const CURRENT_ITEM_KEYS = new Set([
  "block_id",
  "clarification_context",
  "completed_at",
  "failure_context",
  "failure_reason",
  "host_result_evidence",
  "finding_id",
  "incomplete_coverage_attempts",
  "last_successful_step",
  "mechanical_verification",
  "rework_count",
  "started_at",
  "status",
]);

function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => known.has(key));
}

function parseCurrentState(value: unknown): CurrentRemediationHostState | null {
  if (
    !isRecord(value) ||
    !hasOnlyKnownKeys(value, CURRENT_STATE_KEYS) ||
    value.contract_version !== STATE_CONTRACT_VERSION ||
    value.status !== "implementing"
  ) {
    return null;
  }

  const parsedPlan = RemediationPlanSchema.safeParse(value.plan);
  if (!parsedPlan.success || !isRecord(value.items)) return null;
  const stateItems = value.items;

  if (value.host_handoff !== undefined) {
    const parsedHandoff = RemediationHostHandoffRecordSchema.safeParse(
      value.host_handoff,
    );
    if (!parsedHandoff.success) return null;
    const ids = parsedHandoff.data.work_item_ids;
    if (
      new Set(ids).size !== ids.length ||
      ids.some(
        (id, index) => index > 0 && compareCodeUnits(ids[index - 1]!, id) >= 0,
      )
    ) {
      return null;
    }
  }

  const blockById = new Map<string, RemediationBlock>();
  for (const block of parsedPlan.data.blocks) {
    if (blockById.has(block.block_id)) return null;
    blockById.set(block.block_id, block);
  }

  const knownStatuses = new Set<string>(ITEM_STATUSES);
  for (const [findingId, item] of Object.entries(stateItems)) {
    if (
      !isRecord(item) ||
      !hasOnlyKnownKeys(item, CURRENT_ITEM_KEYS) ||
      item.finding_id !== findingId ||
      typeof item.block_id !== "string" ||
      !knownStatuses.has(String(item.status))
    ) {
      return null;
    }
    const block = blockById.get(item.block_id);
    if (!block || !block.items.includes(findingId)) return null;
  }

  for (const block of parsedPlan.data.blocks) {
    if (
      block.items.some((findingId) => {
        const item = stateItems[findingId];
        return !isRecord(item) || item.block_id !== block.block_id;
      })
    ) {
      return null;
    }
  }

  return value as unknown as CurrentRemediationHostState;
}

function normalizeDeclaredPath(root: string, candidate: string, label: string): string {
  if (candidate.length === 0 || isAbsolute(candidate)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  return repoRelativePath(root, candidate, label);
}

/**
 * A block that arrived outside the shape this boundary CONSUMES.
 *
 * The producer half of the write-scope contract is owned upstream
 * (artifact:normalized-block-write-scope). This is the consumer half, and it
 * exists because absorbing a malformed block is worse than refusing it: an
 * absolute or escaping `touched_files` entry silently widens what a host may
 * write, and a shell-chained `targeted_command` is executed verbatim. Both are
 * producer bugs, and a boundary that normalizes them away means neither ever
 * surfaces. The refusal is CLASSIFIED (`block_contract_invalid`) and names the
 * block, so the bug is attributable to the module that wrote it.
 */
class BlockContractError extends Error {
  constructor(
    readonly blockId: string,
    readonly detail: string,
  ) {
    super(
      `block '${blockId}' is outside the normalized write-scope contract: ${detail}`,
    );
    this.name = "BlockContractError";
  }
}

/**
 * Refuse a block whose declared write scope or commands leave the consumed
 * shape. Throws {@link BlockContractError}; callers turn it into a classified
 * issue. Runs BEFORE anything is built from the block, so a refused block never
 * becomes a work item and its commands never run.
 *
 * COVERS THE HANDOFF BOUNDARY ONLY — state the uncovered half rather than let
 * the covered half read as a close. `reverifyBlockedItemAgainstTree` in
 * `src/remediate/phases/triage.ts` spawns the SAME `block.targeted_commands`
 * through `shell: true` with no gate in front of it, so a command this boundary
 * would refuse still reaches a shell on the triage path. Routing that spawn
 * through this gate is tracked as backlog work, not covered here.
 */
function assertBlockContract(root: string, block: RemediationBlock): void {
  for (const raw of block.touched_files) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new BlockContractError(
        block.block_id,
        "touched_files carries an empty entry",
      );
    }
    if (isAbsolute(raw)) {
      throw new BlockContractError(
        block.block_id,
        `touched_files entry ${JSON.stringify(raw)} is absolute, not repository-relative`,
      );
    }
    let normalized: string;
    try {
      normalized = repoRelativePath(root, raw, `${block.block_id}.touched_files[]`);
    } catch {
      throw new BlockContractError(
        block.block_id,
        `touched_files entry ${JSON.stringify(raw)} does not resolve beneath the repository root`,
      );
    }
    if (normalized !== raw) {
      throw new BlockContractError(
        block.block_id,
        `touched_files entry ${JSON.stringify(raw)} is not in normalized repo-relative form ` +
          `(${JSON.stringify(normalized)})`,
      );
    }
  }
  for (const command of block.targeted_commands ?? []) {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new BlockContractError(
        block.block_id,
        "targeted_commands carries an empty command",
      );
    }
    // THE declared-command-shape rule (`audit-tools/shared`), not a local copy:
    // the producer that promotes these commands and the triage path that also
    // spawns them ask the same predicate, so a command cannot clear one boundary
    // and dead-end at another.
    if (commandLeavesDeclaredShape(command)) {
      throw new BlockContractError(
        block.block_id,
        `targeted_command ${JSON.stringify(command)} leaves the declared shape — it chains, ` +
          "redirects or substitutes, and this boundary executes commands verbatim through a shell",
      );
    }
  }
}

/**
 * Every block of the plan that cannot be scheduled, with the reason, as
 * classified ingest issues. Two producer bugs live here: a dependency id that
 * resolves to no block (unschedulable forever — see `hostDependencyLevels`),
 * and a block outside the consumed write-scope/command shape.
 *
 * The scanned set is BOUND ∪ UNSETTLED, and it is that union because those are
 * exactly the blocks something else re-derives:
 *   - UNSETTLED (any item not terminal) — the blocks still to be scheduled. A
 *     settled block's historical shape is not this ingest's business, and
 *     reporting it would turn every later ingest into a repeat of the same noise.
 *   - BOUND (`block_id` in `host_handoff.work_item_ids`, WHATEVER its items'
 *     statuses) — because `parseWorkItem` re-derives every bound item through
 *     `buildWorkItem` regardless of status. A status filter alone therefore
 *     scanned a DIFFERENT set than the one that can throw: a bound block whose
 *     items had all reached terminal still failed the workload parse when its
 *     contract was malformed, and surfaced as a bare `workload_invalid` naming no
 *     block. Scanning the union is what makes "the block that broke the parse is
 *     always named" true rather than usually true.
 */
function planBlockIssues(
  root: string,
  state: CurrentRemediationHostState,
): RemediationHostIngestIssue[] {
  const blockIds = new Set(state.plan.blocks.map((block) => block.block_id));
  const boundIds = new Set(state.host_handoff?.work_item_ids ?? []);
  const issues: RemediationHostIngestIssue[] = [];
  for (const block of state.plan.blocks) {
    const unsettled = block.items.some((findingId) => {
      const status = state.items[findingId]?.status;
      return status !== undefined && !isTerminalStatus(status);
    });
    if (!unsettled && !boundIds.has(block.block_id)) continue;
    const missing = (block.dependencies ?? []).filter(
      (dependencyId) => !blockIds.has(dependencyId),
    );
    if (missing.length > 0) {
      issues.push({
        code: "dependency_missing",
        work_item_id: block.block_id,
        message:
          `block '${block.block_id}' declares ${missing.length === 1 ? "a dependency" : "dependencies"} ` +
          `${missing.map((id) => `'${id}'`).join(", ")} present in no block of the plan, so it can ` +
          "never be dependency-verified and is never scheduled",
      });
      continue;
    }
    try {
      assertBlockContract(root, block);
    } catch (error) {
      if (!(error instanceof BlockContractError)) throw error;
      issues.push({
        code: "block_contract_invalid",
        work_item_id: block.block_id,
        message: error.message,
      });
    }
  }
  return issues;
}

/**
 * The classified "cannot prepare" message for a producer defect that reached the
 * build path as a throw. Aggregates the whole plan scan so an operator sees
 * EVERY malformed block, not just the first one the builder tripped on.
 *
 * The THROWER is attributed by name, not by whether the scan happened to find
 * anything. Falling back only on an EMPTY scan silently dropped the raised error
 * whenever the scan named some OTHER block — a plan with one ghost dependency
 * elsewhere was enough to make the message describe a block that did not throw
 * and omit the one that did.
 */
function cannotPrepareMessage(
  root: string,
  state: CurrentRemediationHostState,
  raised: BlockContractError,
): string {
  const scanned = planBlockIssues(root, state);
  const messages = scanned.map((issue) => issue.message);
  if (!scanned.some((issue) => issue.work_item_id === raised.blockId)) {
    messages.push(raised.message);
  }
  return `Cannot prepare a remediation host workload: ${messages.join("; ")}`;
}

function resolveBoundaryPaths(
  params: Parameters<typeof resolveHostHandoffPaths>[0],
): BoundaryPaths {
  // The remediate draw's run dir carries the `implement` lane segment — its
  // runs directory also holds triage/closing lanes — which the core takes as a
  // parameter rather than a fork.
  const core = resolveHostHandoffPaths({
    ...params,
    runDirSegments: ["implement"],
    runIdLabel: "remediation host run id",
  });
  return {
    root: core.root,
    artifactsDir: core.artifactsDir,
    workloadPath: core.workloadPath,
    resultDir: core.resultDir,
  };
}

/**
 * The bound path for one work item's submission — the SHARED rule, not a local
 * copy of it. This and its audit twin were byte-equivalent private helpers; a
 * divergence between them would have been silent on both sides.
 */
function resultPathFor(paths: BoundaryPaths, workItemId: string): string {
  return hostHandoffResultPath(
    {
      root: paths.root,
      artifactsDir: paths.artifactsDir,
      runDir: paths.workloadPath.slice(0, paths.workloadPath.length - "host-workload.json".length - 1),
      resultDir: paths.resultDir,
      workloadPath: paths.workloadPath,
    },
    workItemId,
  );
}

/**
 * Resolve the submission validator the INGEST applies to one work item, plus
 * the directory that work item's submission is bound to.
 *
 * The hand-recovery verb draws from this rather than carrying a check of its
 * own: `parseResult` is the ingest's contract gate, so a rescued submission has
 * to satisfy exactly what a host-written one would. Everything downstream of
 * the shape gate — git corroboration, write-scope, the required-test rerun —
 * still runs at the next ingest, so recovery lands a submission, it does not
 * accept one.
 *
 * Returns `null` when there is no live workload naming that work item; a lane
 * with no contract to check against must never read as "passes".
 */
export async function remediationSubmissionBinding(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly workItemId: string;
}): Promise<{
  readonly submissionDir: string;
  readonly validate: (value: unknown) => SubmissionIssue | null;
} | null> {
  const paths = resolveBoundaryPaths(params);
  const read = await readSubmissionDocument(paths.workloadPath);
  if (read.kind !== "value" || !isRecord(read.value)) return null;
  const workload = read.value;
  if (
    workload.contract_version !== WORKLOAD_CONTRACT_VERSION ||
    workload.run_id !== params.runId ||
    !Array.isArray(workload.work_items)
  ) {
    return null;
  }
  const workItem = workload.work_items.find(
    (item): item is RemediationHostWorkItem =>
      isRecord(item) && item.id === params.workItemId,
  );
  if (workItem === undefined) return null;
  return {
    submissionDir: paths.resultDir,
    validate: (value: unknown): SubmissionIssue | null => {
      const parsed = parseResult(value, params.runId, workItem);
      return parsed.ok
        ? null
        : { code: "submission_contract_invalid", message: parsed.reason };
    },
  };
}

/** Absolute result-file path owned by the current host-handoff boundary. */
export function remediationHostResultFilePath(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly workItemId: string;
}): string {
  const paths = resolveBoundaryPaths(params);
  return resolveContainedPath(
    paths.root,
    resultPathFor(paths, params.workItemId),
    `result path for ${params.workItemId}`,
  );
}

/**
 * Pure dependency/phase partitioning shared by next-step and the host workload
 * boundary. Only level zero is safe to emit before the host has landed and
 * verified its prerequisites.
 */
export function hostDependencyLevels(
  state: Pick<RemediationState, "plan" | "items">,
): RemediationBlock[][] {
  const plan = state.plan;
  const items = state.items;
  if (!plan || !items) return [];

  const blockById = new Map(plan.blocks.map((block) => [block.block_id, block]));
  const pendingBlocks = plan.blocks.filter((block) =>
    block.items.some((findingId) => items[findingId]?.status === "pending"),
  );
  const isVerifiedNow = (block: RemediationBlock): boolean =>
    block.items.every((findingId) =>
      isVerifiedCompleteStatus(items[findingId]?.status),
    );
  const isPending = (block: RemediationBlock): boolean =>
    block.items.some((findingId) => items[findingId]?.status === "pending");
  const phaseOf = (block: RemediationBlock): number => block.phase_ordinal ?? 0;
  const lowerPhaseBlocks = (phase: number): RemediationBlock[] =>
    plan.blocks.filter((block) => phaseOf(block) < phase);
  const phaseBarrierClear = (phase: number): boolean =>
    lowerPhaseBlocks(phase).every(isVerifiedNow);
  const phaseBarrierUnsatisfiable = (phase: number): boolean =>
    lowerPhaseBlocks(phase).some(
      (block) => !isVerifiedNow(block) && !isPending(block),
    );
  const permanentlyIneligible = (block: RemediationBlock): boolean => {
    for (const dependencyId of block.dependencies ?? []) {
      const dependency = blockById.get(dependencyId);
      // An id that resolves to NO block is not a harmless declaration — it is a
      // prerequisite that can never be verified, so the block can never become
      // eligible. Guarding on `dependency &&` skipped exactly this case, which
      // is the second half of the same hole as the readiness predicate below:
      // closing only one leaves the block reaching the host anyway.
      if (dependency === undefined) return true;
      if (!isVerifiedNow(dependency) && !isPending(dependency)) {
        return true;
      }
    }
    return phaseBarrierUnsatisfiable(phaseOf(block));
  };

  const levels: RemediationBlock[][] = [];
  const placed = new Set<string>();
  let remaining = pendingBlocks.filter((block) => !permanentlyIneligible(block));
  while (remaining.length > 0) {
    const ready = remaining.filter(
      (block) =>
        phaseBarrierClear(phaseOf(block)) &&
        (block.dependencies ?? []).every((dependencyId) => {
          const dependency = blockById.get(dependencyId);
          // DEPENDENCY READINESS REQUIRES EXISTENCE. `!dependency` used to read
          // as "satisfied", so a plan naming a block that does not exist had its
          // dependent placed at level 0 and dispatched with the prerequisite
          // never verified — silently, because no other check looks at it.
          if (dependency === undefined) return false;
          if (isVerifiedNow(dependency)) return true;
          return dependency.items.every(
            (findingId) =>
              isVerifiedCompleteStatus(items[findingId]?.status) ||
              (items[findingId]?.status === "pending" &&
                placed.has(dependency.block_id)),
          );
        }),
    );
    if (ready.length === 0) break;
    levels.push(ready);
    for (const block of ready) placed.add(block.block_id);
    remaining = remaining.filter((block) => !placed.has(block.block_id));
  }
  return levels;
}

function buildPrompt(item: {
  readonly blockId: string;
  readonly findingIds: readonly string[];
  readonly assignments: readonly Record<string, unknown>[];
  readonly allowedFiles: readonly string[];
  readonly baselineCommit: string;
  readonly requiredTests: readonly string[];
  readonly resultPath: string;
}): string {
  const assignment = stableStringify({
    allowed_files: item.allowedFiles,
    assignments: item.assignments,
    baseline_commit: item.baselineCommit,
    finding_ids: item.findingIds,
    id: item.blockId,
    required_tests: item.requiredTests,
    result_path: item.resultPath,
  });
  return [
    "Implement the bounded remediation work item below.",
    "The host owns execution choices. For every assignment, apply the finding and item instructions exactly, including any clarified scope or retry context.",
    "Keep every edit within allowed_files, run every required test, land one attributable commit whose changed-file set is exact, and write one JSON result at result_path.",
    `Assignment: ${assignment}`,
    "The result must use remediation-host-result/v1alpha1 and contain exactly contract_version, result_id, run_id, work_item_id, prompt_sha256, changed_files, commit_evidence, test_evidence, worktree_evidence, acceptance, and merge.",
    "Bind commit_evidence.before and worktree_evidence.baseline_commit to baseline_commit; report only passed required tests; acceptance.status must be accepted and merge.status must be merged.",
    "If no edit should land, write remediation-host-decision/v1alpha1 instead with exactly contract_version, result_id, run_id, work_item_id, prompt_sha256, outcome. outcome must be one of: {status: resolved_no_change, evidence: [non-empty strings]}, {status: blocked, failure_reason: non-empty string}, or {status: needs_clarification, question: non-empty string, optional category}.",
  ].join("\n");
}

function buildFindingAssignments(
  state: CurrentRemediationHostState,
  block: RemediationBlock,
): Record<string, unknown>[] {
  return block.items.map((findingId) => {
    const finding = state.plan.findings.find((entry) => entry.id === findingId);
    const item = state.items[findingId];
    if (!finding || !item) {
      throw new Error(
        `Host work item ${block.block_id} references unknown finding ${findingId}`,
      );
    }
    return {
      finding: FindingSchema.parse(finding),
      ...(item.clarification_context
        ? { clarification_context: item.clarification_context }
        : {}),
      ...(item.failure_context
        ? { failure_context: item.failure_context }
        : {}),
    };
  });
}

function buildWorkItem(
  paths: BoundaryPaths,
  block: RemediationBlock,
  baselineCommit: string,
  state: CurrentRemediationHostState,
): RemediationHostWorkItem {
  // The consumed-shape gate runs FIRST: a block outside the write-scope /
  // command contract must never become a work item, so nothing downstream can
  // dispatch it or execute its commands.
  assertBlockContract(paths.root, block);
  const allowedFiles = [...new Set(block.touched_files)].map((path) =>
    normalizeDeclaredPath(paths.root, path, `${block.block_id}.touched_files[]`),
  ).sort(compareCodeUnits);
  const resultPath = resultPathFor(paths, block.block_id);
  const requiredTests = [...(block.targeted_commands ?? [])];
  const assignments = buildFindingAssignments(state, block);
  const promptText = buildPrompt({
    blockId: block.block_id,
    findingIds: block.items,
    assignments,
    allowedFiles,
    baselineCommit,
    requiredTests,
    resultPath,
  });
  return {
    id: block.block_id,
    finding_ids: [...block.items],
    allowed_files: allowedFiles,
    baseline_commit: baselineCommit,
    prompt: { text: promptText, sha256: promptSha256(promptText) },
    required_tests: requiredTests,
    result_path: resultPath,
    token_estimate: block.token_estimate ?? 0,
  };
}

function buildCanonicalWorkload(params: {
  readonly paths: BoundaryPaths;
  readonly state: CurrentRemediationHostState;
  readonly runId: string;
  readonly baselineCommit: string;
  readonly workItemIds?: readonly string[];
}): RemediationHostWorkload {
  const requestedIds = params.workItemIds
    ? new Set(params.workItemIds)
    : null;
  const sourceBlocks = requestedIds
    ? params.state.plan.blocks.filter((block) => requestedIds.has(block.block_id))
    : hostDependencyLevels(params.state)[0] ?? [];
  const blocks = [...sourceBlocks].sort((left, right) =>
    compareCodeUnits(left.block_id, right.block_id),
  );
  if (
    requestedIds &&
    (blocks.length !== requestedIds.size ||
      blocks.some((block) => !requestedIds.has(block.block_id)))
  ) {
    throw new Error("Trusted remediation host workload references an unknown block");
  }
  return {
    contract_version: WORKLOAD_CONTRACT_VERSION,
    run_id: params.runId,
    work_items: blocks.map((block) =>
      buildWorkItem(params.paths, block, params.baselineCommit, params.state),
    ),
  };
}

function parseWorkItem(
  value: unknown,
  paths: BoundaryPaths,
  state: CurrentRemediationHostState,
  expectedBaselineCommit?: string,
): RemediationHostWorkItem | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "allowed_files",
      "baseline_commit",
      "finding_ids",
      "id",
      "prompt",
      "required_tests",
      "result_path",
      "token_estimate",
    ]) ||
    typeof value.id !== "string" ||
    !isCommit(value.baseline_commit) ||
    !Array.isArray(value.finding_ids) ||
    !value.finding_ids.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.allowed_files) ||
    !value.allowed_files.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.required_tests) ||
    !value.required_tests.every((entry) => typeof entry === "string") ||
    typeof value.result_path !== "string" ||
    !Number.isInteger(value.token_estimate) ||
    Number(value.token_estimate) < 0 ||
    !isRecord(value.prompt) ||
    !hasExactKeys(value.prompt, ["sha256", "text"]) ||
    typeof value.prompt.text !== "string" ||
    !isSha256(value.prompt.sha256) ||
    promptSha256(value.prompt.text) !== value.prompt.sha256
  ) {
    return null;
  }

  const block = state.plan.blocks.find((candidate) => candidate.block_id === value.id);
  if (!block) return null;
  let expected: RemediationHostWorkItem;
  try {
    expected = buildWorkItem(
      paths,
      block,
      expectedBaselineCommit ?? value.baseline_commit,
      state,
    );
  } catch {
    return null;
  }
  return stableStringify(value) === stableStringify(expected)
    ? (value as unknown as RemediationHostWorkItem)
    : null;
}

function parseWorkload(
  value: unknown,
  paths: BoundaryPaths,
  runId: string,
  state: CurrentRemediationHostState,
): RemediationHostWorkload | null {
  // Envelope (keys, contract version, run id, items array) is the CORE's check.
  const envelope = parseWorkloadEnvelope(value, {
    contractVersion: WORKLOAD_CONTRACT_VERSION,
    runId,
  });
  if (!envelope.ok) return null;
  const binding = state.host_handoff;
  if (
    binding &&
    (binding.run_id !== runId ||
      contentSha256(value as unknown as RemediationHostWorkload) !==
        binding.workload_sha256)
  ) {
    return null;
  }
  const workItems = parseAllWorkloadItems(envelope.rawItems, (item) =>
    parseWorkItem(item, paths, state, binding?.baseline_commit),
  );
  if (workItems === null) return null;
  const ids = workItems.map((item) => item.id);
  // Strictly ascending covers BOTH "sorted" and "duplicate-free" — the two
  // properties the byte-for-byte re-derivation comparison needs.
  if (
    !idsAreStrictlyAscending(ids) ||
    (binding !== undefined && !sameStrings(ids, binding.work_item_ids))
  ) {
    return null;
  }
  return value as unknown as RemediationHostWorkload;
}

type ParsedHostResult =
  | {
      readonly ok: true;
      readonly kind: "landed";
      readonly result: RemediationHostResult;
    }
  | {
      readonly ok: true;
      readonly kind: "decision";
      readonly result: RemediationHostDecision;
    }
  | { readonly ok: false; readonly reason: string };

function invalidResult(reason: string): ParsedHostResult {
  return { ok: false, reason };
}

/** A submission this draw's contract gate accepted — landed edit or decision. */
type AcceptedHostResult = Extract<ParsedHostResult, { readonly ok: true }>;

/**
 * This draw's refusal vocabulary for {@link scanBoundSubmission}. The scan owns
 * the sequence (containment, read, classify, duplicate check); the words are
 * this lane's, because they address a host repairing a pending work item rather
 * than an audit submission. `contractInvalid` passes `parseResult`'s own reason
 * through untouched — the hand-recovery lane is pinned to that exact text.
 */
const remediationScanMessages: SubmissionScanMessages = {
  missing: () => "no result file exists for this pending work item",
  malformed: (detail) => `result JSON could not be parsed: ${detail}`,
  contractInvalid: (detail) => detail,
  duplicate: (resultId) => `result_id ${resultId} is duplicated in this workload`,
};

function parseResult(
  value: unknown,
  runId: string,
  workItem: RemediationHostWorkItem,
): ParsedHostResult {
  if (isRecord(value) && value.contract_version === DECISION_CONTRACT_VERSION) {
    if (
      !hasExactKeys(value, [
        "contract_version",
        "result_id",
        "run_id",
        "work_item_id",
        "prompt_sha256",
        "outcome",
      ]) ||
      !resultIdentityIsBound(value, {
        runId,
        workItemId: workItem.id,
        promptSha256: workItem.prompt.sha256,
      }) ||
      !isRecord(value.outcome) ||
      typeof value.outcome.status !== "string"
    ) {
      return invalidResult(
        "decision must match the exact current run, work-item, and prompt binding",
      );
    }
    const outcome = value.outcome;
    if (outcome.status === "resolved_no_change") {
      const evidence = stringArray(outcome.evidence);
      if (
        !hasExactKeys(outcome, ["status", "evidence"]) ||
        !evidence ||
        evidence.length === 0 ||
        evidence.some((entry) => entry.trim().length === 0)
      ) {
        return invalidResult(
          "resolved_no_change requires a non-empty evidence string array",
        );
      }
    } else if (outcome.status === "blocked") {
      if (
        !hasExactKeys(outcome, ["status", "failure_reason"]) ||
        typeof outcome.failure_reason !== "string" ||
        outcome.failure_reason.trim().length === 0
      ) {
        return invalidResult("blocked requires a non-empty failure_reason");
      }
    } else if (outcome.status === "needs_clarification") {
      if (
        !hasOnlyKnownKeys(
          outcome,
          new Set(["status", "question", "category"]),
        ) ||
        typeof outcome.question !== "string" ||
        outcome.question.trim().length === 0 ||
        (outcome.category !== undefined &&
          !isClarificationCategory(outcome.category))
      ) {
        return invalidResult(
          "needs_clarification requires a non-empty question and optional canonical category",
        );
      }
    } else {
      return invalidResult(
        "decision outcome.status must be resolved_no_change, blocked, or needs_clarification",
      );
    }
    return {
      ok: true,
      kind: "decision",
      result: value as unknown as RemediationHostDecision,
    };
  }

  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "acceptance",
      "changed_files",
      "commit_evidence",
      "contract_version",
      "merge",
      "prompt_sha256",
      "result_id",
      "run_id",
      "test_evidence",
      "work_item_id",
      "worktree_evidence",
    ]) ||
    value.contract_version !== RESULT_CONTRACT_VERSION ||
    !resultIdentityIsBound(value, {
      runId,
      workItemId: workItem.id,
      promptSha256: workItem.prompt.sha256,
    })
  ) {
    return invalidResult(
      "result must match the exact current contract, run, work-item, and prompt binding",
    );
  }

  const changedFiles = stringArray(value.changed_files);
  if (
    !changedFiles ||
    changedFiles.length === 0 ||
    new Set(changedFiles).size !== changedFiles.length ||
    !sameStrings([...changedFiles].sort(compareCodeUnits), changedFiles) ||
    changedFiles.some((path) => !workItem.allowed_files.includes(path))
  ) {
    return invalidResult(
      "changed_files must be a non-empty, sorted, unique subset of allowed_files",
    );
  }

  if (
    !isRecord(value.commit_evidence) ||
    !hasExactKeys(value.commit_evidence, ["after", "before"]) ||
    value.commit_evidence.before !== workItem.baseline_commit ||
    !isCommit(value.commit_evidence.after) ||
    value.commit_evidence.after === value.commit_evidence.before
  ) {
    return invalidResult(
      "commit_evidence must bind the workload baseline to a distinct full commit id",
    );
  }

  if (
    !Array.isArray(value.test_evidence) ||
    value.test_evidence.length !== workItem.required_tests.length
  ) {
    return invalidResult(
      "test_evidence must contain exactly one entry for every required test",
    );
  }
  for (const [index, evidence] of value.test_evidence.entries()) {
    if (
      !isRecord(evidence) ||
      !hasExactKeys(evidence, ["command", "status"]) ||
      evidence.command !== workItem.required_tests[index] ||
      evidence.status !== "passed"
    ) {
      return invalidResult(
        `test_evidence[${index}] must echo the bound command with status passed`,
      );
    }
  }

  if (
    !isRecord(value.worktree_evidence) ||
    !hasExactKeys(value.worktree_evidence, ["baseline_commit", "changed_files"]) ||
    value.worktree_evidence.baseline_commit !== workItem.baseline_commit
  ) {
    return invalidResult(
      "worktree_evidence must bind the workload baseline and changed-file list",
    );
  }
  const worktreeFiles = stringArray(value.worktree_evidence.changed_files);
  if (!worktreeFiles || !sameStrings(worktreeFiles, changedFiles)) {
    return invalidResult(
      "worktree_evidence.changed_files must exactly equal changed_files",
    );
  }

  if (
    !isRecord(value.acceptance) ||
    !hasExactKeys(value.acceptance, ["status"]) ||
    value.acceptance.status !== "accepted" ||
    !isRecord(value.merge) ||
    !hasExactKeys(value.merge, ["status"]) ||
    value.merge.status !== "merged"
  ) {
    return invalidResult(
      "acceptance and merge must both attest a completed landing",
    );
  }

  return {
    ok: true,
    kind: "landed",
    result: value as unknown as RemediationHostResult,
  };
}

type CorroboratedHostResult =
  | {
      readonly ok: true;
      readonly changedFiles: readonly string[];
      /**
       * True only when the baseline→landed ancestry check was WAIVED under an
       * orphaned baseline. The caller must record the acceptance on the
       * submission ledger before it lands.
       */
      readonly usedRecovery: boolean;
    }
  | {
      readonly ok: false;
      readonly code: RemediationHostIngestIssue["code"];
      readonly message: string;
    };

function gitCommitExists(root: string, commit: string): boolean {
  const result = spawnSyncHidden(
    "git",
    ["rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
    { cwd: root, encoding: "utf8", shell: false },
  );
  return !result.error && result.status === 0;
}

// INV-WTS-3 (landed-node ancestry): a landed node's commit must be an ancestor
// of the ref it claims to have landed on. `git merge-base --is-ancestor` exits 0
// exactly when that holds.
function gitCommitIsAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = spawnSyncHidden(
    "git",
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: root, encoding: "utf8", shell: false },
  );
  return !result.error && result.status === 0;
}

/**
 * Is this commit ORPHANED — unreachable from anything the repository still
 * keeps?
 *
 * "Not an ancestor of HEAD" is NOT orphanhood. A baseline sitting on an
 * unmerged `feature` branch while the work landed on trunk fails the ancestry
 * test exactly like a rewritten-away commit does, and treating that as orphaned
 * would hand the relaxation to the ordinary cross-branch case — precisely the
 * stale-worker situation the ancestry check exists to catch.
 *
 * So orphanhood is the CONJUNCTION of two probes: `git for-each-ref --contains`
 * lists every branch/tag/remote ref whose history contains the commit (empty
 * output = no live ref keeps it), and the HEAD ancestry check rides alongside
 * it because a detached HEAD is not a ref `for-each-ref` enumerates and would
 * otherwise scan clean. A failed scan is not evidence of orphanhood — it fails
 * closed, so a git that cannot answer never unlocks the relaxation.
 */
function gitCommitIsOrphaned(root: string, commit: string): boolean {
  if (gitCommitIsAncestor(root, commit, "HEAD")) return false;
  const result = spawnSyncHidden(
    "git",
    ["for-each-ref", "--contains", commit, "--format=%(refname)"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.error || result.status !== 0) return false;
  return (result.stdout ?? "").trim().length === 0;
}

function gitChangedFilesOfCommit(
  root: string,
  commit: string,
): readonly string[] | null {
  const result = spawnSyncHidden(
    "git",
    [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      commit,
    ],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.error || result.status !== 0) return null;
  return [...new Set((result.stdout ?? "").split("\0").filter(Boolean))].sort(
    compareCodeUnits,
  );
}

/**
 * Every repo-relative path the tree shows as touched since `baseline` — the
 * commits baseline→HEAD, the working tree's own deviation from HEAD (staged and
 * unstaged alike), and the untracked files git considers repository content.
 *
 * All three legs are needed to falsify a no-change claim, and they enumerate the
 * three ways a host can have edited: committed (leg 1), edited a TRACKED file
 * and left it uncommitted (leg 2), and CREATED a file (leg 3). A new `src/*.ts`
 * is a real edit and the most natural shape a remediation takes; without leg 3
 * the cheapest way to smuggle one past a no-change claim was simply never to
 * `git add` it. `null` means git could not answer, which callers must treat as
 * "cannot corroborate" rather than as "nothing changed".
 *
 * The untracked leg honours `--exclude-standard`, so it enumerates only what git
 * itself treats as content — a repo's `.gitignore`d build and coverage output is
 * already invisible to it. Two exemptions cover the remainder, both ground
 * truth rather than the host's word:
 *
 *  - THIS TOOL'S OWN ARTIFACT TREE ({@link AUDIT_TOOLS_DIRNAME}) is subtracted
 *    here, explicitly. In a real repository the tool writes a managed
 *    `.gitignore` block covering it, so it never reaches this probe at all; the
 *    explicit subtraction is what makes that independent of whether the block
 *    has been written yet, so a bare root (a fixture, a first run) cannot
 *    manufacture a false refusal out of the tool's own workload, prompt and
 *    result documents.
 *  - PRE-EXISTING untracked strays are excused by the caller's `excusedPaths`,
 *    for free: `run_start_dirty` is captured from `stagedAndUntracked` before
 *    any remediation edit exists, so it already enumerates untracked files.
 *    What survives both is an untracked file that appeared DURING the run — the
 *    only untracked class that can be this host's edit.
 */
function gitChangedFilesSince(
  root: string,
  baseline: string,
): readonly string[] | null {
  const files = new Set<string>();
  for (const args of [
    // baseline → HEAD: what the host committed.
    ["diff", "--name-only", "-z", baseline, "HEAD"],
    // HEAD → working tree: what the host edited and did not commit.
    ["diff", "--name-only", "-z", "HEAD"],
    // Never added: what the host CREATED. `--exclude-standard` keeps git's own
    // ignore rules authoritative.
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    const probe = spawnSyncHidden("git", args, {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    if (probe.error || probe.status !== 0) return null;
    for (const file of (probe.stdout ?? "").split("\0").filter(Boolean)) {
      if (isAuditToolsArtifactPath(file)) continue;
      files.add(file);
    }
  }
  return [...files].sort(compareCodeUnits);
}

/** Whether a repo-relative path lives inside this tool's own artifact tree. */
function isAuditToolsArtifactPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return (
    normalized === AUDIT_TOOLS_DIRNAME ||
    normalized.startsWith(`${AUDIT_TOOLS_DIRNAME}/`)
  );
}

/**
 * Corroborate an explicit `resolved_no_change` decision against the repository.
 *
 * A no-change decision used to be accepted on its evidence STRINGS alone, with
 * only the required tests re-run — so a host that had in fact edited and then
 * declared "nothing to do" was recorded as verified-no-change, and the edit
 * rode into the run unattributed. The claim is mechanically falsifiable, so it
 * is FALSIFIED.
 *
 * The scope of the falsification is the FULL write-scope corroboration every
 * other acceptance path gets, NOT a narrowing to this item's `allowed_files`.
 * `corroborateHostResult` refuses a landed commit that touched anything outside
 * `allowed_files`; a no-change decision that narrowed the check to files INSIDE
 * `allowed_files` would be the inverse rule — the out-of-scope edit, the more
 * serious of the two, would be the one silently admitted. So EVERY path the
 * tree shows as moved since the workload baseline refuses the claim.
 *
 * `excusedPaths` is the only exemption, and it is ground truth rather than the
 * host's word: `run_start_dirty` (already dirty before the run began, so not
 * evidence that this host edited anything — and because it is captured from
 * `stagedAndUntracked`, it excuses pre-existing UNTRACKED strays too) unioned
 * with the accepted edit surface — `applied_edit_surface` plus whatever this
 * same ingest has already corroborated and accepted, so a sibling work item's
 * legitimately landed files do not falsify this item's claim.
 *
 * Fails CLOSED, like every other corroboration here: a git that cannot answer
 * refuses the claim rather than admitting it.
 */
function corroborateNoChangeClaim(params: {
  readonly root: string;
  readonly workItem: RemediationHostWorkItem;
  /** Repo-relative paths whose movement is already accounted for. */
  readonly excusedPaths: ReadonlySet<string>;
}):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: RemediationHostIngestIssue["code"];
      readonly message: string;
    } {
  const { root, workItem, excusedPaths } = params;
  if (!isGitRepo(root)) return { ok: true };
  const baseline = workItem.baseline_commit;
  if (!gitCommitExists(root, baseline)) {
    return {
      ok: false,
      code: "commit_missing",
      message:
        "resolved_no_change cannot be corroborated: baseline_commit does not resolve to a real commit",
    };
  }
  const changed = gitChangedFilesSince(root, baseline);
  if (changed === null) {
    return {
      ok: false,
      code: "commit_missing",
      message:
        "resolved_no_change cannot be corroborated: git could not enumerate the changes since the workload baseline",
    };
  }
  const violating = changed.filter(
    (path) => !excusedPaths.has(normalizeRepoPath(path)),
  );
  if (violating.length > 0) {
    const inScope = violating.filter((path) =>
      workItem.allowed_files.includes(path),
    );
    const outOfScope = violating.filter(
      (path) => !workItem.allowed_files.includes(path),
    );
    return {
      ok: false,
      code: "changed_files_mismatch",
      message:
        "resolved_no_change is contradicted by the tree — these files changed since the " +
        `workload baseline: ${violating.join(", ")}` +
        (outOfScope.length > 0
          ? ` (outside the prompt-bound allowed_files: ${outOfScope.join(", ")}` +
            (inScope.length > 0 ? `; inside: ${inScope.join(", ")})` : ")")
          : ""),
    };
  }
  return { ok: true };
}

/**
 * Pre-computed required-test verdicts, keyed by `root` + command: `null` =
 * green, a string = the failure detail.
 *
 * This is the recovery path's ANSWER TABLE, not a lazy cache. A required-test
 * rerun is a `spawnSync`, which blocks the event loop for its whole duration —
 * so running one inside the state lock would starve the lock's own heartbeat
 * timer and let a second acquirer reclaim the lock as stale mid-hold. The
 * recovery verb therefore runs every distinct command ONCE, up front and
 * unlocked ({@link precomputeRecoveryTestVerdicts}), and hands the finished
 * table to the locked phase, which only ever READS it.
 *
 * Two consequences are deliberate. A command absent from the table is treated
 * as FAILED, never spawned — fail-closed is the only answer that keeps the
 * no-spawn-under-the-lock property mechanical rather than remembered. And the
 * table is recovery-only: a `targeted_command` is host-authored and need not be
 * idempotent (one that appends to a log, bumps a counter, or is flaky produces
 * a genuinely different second run), so collapsing spawns is a behavior change.
 * The normal lane passes `null` and stays byte-identical to the pre-recovery
 * behavior — every command spawns once per work item, exactly as before.
 */
export type RemediationRequiredTestVerdicts = ReadonlyMap<
  string,
  RequiredTestFailure | null
>;

/**
 * A required-test rerun that did not pass, CLASSIFIED.
 *
 * `outcome` is the whole point. A suite that exceeded its deadline, a suite that
 * outran the capture buffer, and a suite that returned non-zero are different
 * facts — the first two are environment signals, only the last is the work being
 * wrong — and they used to arrive as one joined string (`"<cmd> (exit 1)"` /
 * `"<cmd> (ETIMEDOUT)"`) that a caller could only tell apart by parsing prose.
 * Output was not captured at all (`stdio: "ignore"`), so an operator staring at
 * a red ingest had nothing to read.
 *
 * `output_overflow` is separate from `timed_out` because node kills BOTH an
 * over-deadline and an over-`maxBuffer` child with a signal: a discriminator
 * that read `signal !== null` as "the deadline fired" reported a command that
 * was running fine and merely verbose as a hang. `output_overflow` does
 * NOT claim the tests were fine — see {@link describeRequiredTestFailure}; the
 * verdict is simply unknown, because a child killed mid-stream may equally have
 * been on its way to exit 3.
 */
export interface RequiredTestFailure {
  readonly command: string;
  readonly outcome: "failed" | "timed_out" | "output_overflow" | "spawn_error";
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The signal that killed the child, when one did and the runner's own caps did
   * not (an operator `kill`, an OOM reaper). Absent on every other outcome —
   * there is no signal to report — which is why it is optional rather than
   * `string | null`: a caller that reads it gets a name or nothing, never a
   * placeholder to special-case.
   */
  readonly signal?: string;
}

/**
 * Per-command deadline. A required test is host-authored and may legitimately be
 * a full suite, so the bound is generous; what changed is that hitting it is now
 * a NAMED outcome instead of an unlabelled failure string.
 */
const REQUIRED_TEST_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Captured output is bounded and TAIL-biased: a failing suite's verdict is at
 * the end, and an unbounded capture would put a whole test log into state and
 * into every rendered issue.
 */
const CAPTURED_OUTPUT_LIMIT = 4_000;

/**
 * The spawn's raw capture buffer. Exceeding it does not truncate — node KILLS
 * the child — so the cap is a named constant the `output_overflow` message can
 * quote, rather than a literal buried in the spawn options.
 */
const REQUIRED_TEST_MAX_BUFFER_BYTES = 8 * 1_024 * 1_024;

function tail(value: string | undefined): string {
  const text = value ?? "";
  return text.length <= CAPTURED_OUTPUT_LIMIT
    ? text
    : `…${text.slice(text.length - CAPTURED_OUTPUT_LIMIT)}`;
}

/**
 * Render one classified failure for a host-facing issue message.
 *
 * `output_overflow` says the verdict is UNKNOWN, not that the tests were fine: a
 * child killed at the buffer cap may have been heading for exit 0 or exit 3, and
 * the runner cannot tell which. Either way the item is refused — the honest
 * report is "we could not find out", and it fails closed.
 *
 * A signal-killed child renders the SIGNAL, not `exit null`: `exit_code` is null
 * for every non-exit outcome, so printing it there described nothing.
 */
function describeRequiredTestFailure(failure: RequiredTestFailure): string {
  const head =
    failure.outcome === "timed_out"
      ? `${failure.command} (timed out)`
      : failure.outcome === "output_overflow"
        ? `${failure.command} (killed after exceeding the ${String(REQUIRED_TEST_MAX_BUFFER_BYTES)}-byte ` +
          "output buffer — the run ended at the capture cap, so whether the tests pass is UNKNOWN)"
        : failure.outcome === "spawn_error"
          ? `${failure.command} (could not be started)`
          : failure.exit_code === null
            ? `${failure.command} (terminated by ${failure.signal ?? "an unreported signal"})`
            : `${failure.command} (exit ${String(failure.exit_code)})`;
  const captured = [failure.stdout, failure.stderr]
    .filter((stream) => stream.trim().length > 0)
    .join("\n");
  return captured.length > 0 ? `${head}: ${captured}` : head;
}

/**
 * Length-prefixed so the root/command boundary is unambiguous for any path, and
 * printable so the source stays text (a raw separator byte would make the file
 * binary to git and invisible to grep). The root is part of the key because a
 * verdict is a fact about one command in one working tree, and nothing
 * guarantees a single process only ever ingests for one root.
 */
function requiredTestVerdictKey(root: string, command: string): string {
  return `${String(root.length)}:${root}:${command}`;
}

/**
 * The ONE place a required-test command is spawned.
 *
 * `timeoutMs` is a parameter so the deadline is exercisable: a hang is a
 * first-class outcome of this function, and an outcome that can only be reached
 * by waiting ten real minutes is an outcome nothing ever tests.
 */
export async function runRequiredTest(
  root: string,
  command: string,
  timeoutMs: number = REQUIRED_TEST_TIMEOUT_MS,
): Promise<RequiredTestFailure | null> {
  // AWAITED, never `spawnSync`: ingestion runs with the remediation state lock
  // held, and a synchronous child blocks the event loop for the whole suite —
  // starving the lock's mtime heartbeat until a LIVE lock is classified stale
  // and stolen mid-ingest.
  //
  // argv + `shell: false`, never a shell string. A required test is a workload
  // command that already cleared the declared-shape gate at the producer, so
  // splitting it is unambiguous, and dropping the shell removes the last place
  // an ingest hands a declared string to `sh`/`cmd.exe`. `resolveExecArgv`
  // inside the runner is what keeps the npm/npx shims resolvable on win32.
  const result = await runTrackedAsync(parseCommandString(command), {
    cwd: root,
    // Captured, not discarded: without it a red ingest reports that something
    // failed and nothing about why.
    encoding: "utf8",
    maxBuffer: REQUIRED_TEST_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stdout = tail(result.stdout);
  const stderr = tail(result.stderr);
  // The ERROR CODE discriminates, never `signal`. node kills an over-deadline
  // child AND an over-`maxBuffer` child, and an external `kill` sets `signal`
  // too — so `signal !== null` was true for three unrelated facts and reported
  // all of them as a hang, including a command killed purely for printing more
  // than the buffer holds.
  //
  // ASSUMPTION, stated: a deadline miss reports `ETIMEDOUT`. Verified on win32;
  // it is node's documented contract, not a platform quirk this code confirmed
  // everywhere. On a platform that killed a child at the deadline WITHOUT that
  // code, the case degrades to `spawn_error` — a less specific refusal, still a
  // refusal, so the fail direction holds and only the label is lost.
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") {
    return { command, outcome: "timed_out", exit_code: null, stdout, stderr };
  }
  if (code === "ENOBUFS") {
    return {
      command,
      outcome: "output_overflow",
      exit_code: null,
      stdout,
      stderr,
    };
  }
  if (result.error) {
    return {
      command,
      outcome: "spawn_error",
      exit_code: null,
      stdout,
      stderr: stderr.length > 0 ? stderr : result.error.message,
    };
  }
  // Killed by something outside this runner (an operator `kill`, an OOM reaper).
  // Reported as FAILED with the signal named: the command did not complete, and
  // calling it a deadline miss would attribute it to a bound this runner set.
  //
  // POSIX-ONLY IN PRACTICE, and UNTESTED for that reason: Windows has no signal
  // delivery to report here — a killed child surfaces as an ordinary non-zero
  // `status` with `signal` null — so this branch is unreachable on the platform
  // this repo runs its suites on, and no test exercises it. It is kept because
  // the runner is OS-agnostic by contract, not because it has been observed.
  if (result.signal !== null && result.signal !== undefined) {
    return {
      command,
      outcome: "failed",
      exit_code: null,
      stdout,
      stderr,
      signal: result.signal,
    };
  }
  if (result.status !== 0) {
    return {
      command,
      outcome: "failed",
      exit_code: result.status,
      stdout,
      stderr,
    };
  }
  return null;
}

async function rerunRequiredTests(
  root: string,
  commands: readonly string[],
  /** `null` on the normal lane — see {@link RemediationRequiredTestVerdicts}. */
  verdicts: RemediationRequiredTestVerdicts | null,
): Promise<readonly RequiredTestFailure[]> {
  const failures: RequiredTestFailure[] = [];
  for (const command of commands) {
    if (verdicts) {
      const verdict = verdicts.get(requiredTestVerdictKey(root, command));
      if (verdict === undefined) {
        failures.push({
          command,
          outcome: "spawn_error",
          exit_code: null,
          stdout: "",
          stderr:
            "no pre-computed verdict — refusing to spawn a test while the state lock is held",
        });
      } else if (verdict !== null) {
        failures.push(verdict);
      }
      continue;
    }
    const failure = await runRequiredTest(root, command);
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

/**
 * The classified issue for a set of required-test failures. An ENVIRONMENT fact
 * anywhere in the set wins over a red sibling, timeout first: a hung or
 * buffer-killed suite is the fact that explains the ingest, and burying it under
 * a sibling's exit code is exactly the conflation the code split exists to end.
 * Only a set where every failure is a genuine non-zero exit reads as
 * `required_test_failed`.
 */
function requiredTestIssue(
  workItem: RemediationHostWorkItem,
  failures: readonly RequiredTestFailure[],
): RemediationHostIngestIssue {
  return {
    code: failures.some((failure) => failure.outcome === "timed_out")
      ? "required_test_timed_out"
      : failures.some((failure) => failure.outcome === "output_overflow")
        ? "required_test_output_overflow"
        : "required_test_failed",
    work_item_id: workItem.id,
    result_path: workItem.result_path,
    message: `mechanical required-test rerun failed: ${failures
      .map(describeRequiredTestFailure)
      .join("; ")}`,
  };
}

/**
 * Run every required-test command a recovery ingest could need, ONCE each, and
 * return the finished verdict table. Call this OUTSIDE the state lock — that is
 * the entire point (see {@link RemediationRequiredTestVerdicts}).
 *
 * Candidates are the work items with at least one still-pending finding whose
 * result file is present and parses as JSON; an item with no result file is
 * refused before its tests would ever run, so spawning for it is pure cost. The
 * filter is deliberately generous otherwise — over-inclusion costs one spawn,
 * while under-inclusion becomes a fail-closed refusal of a good result.
 */
export async function precomputeRecoveryTestVerdicts(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly state: unknown;
}): Promise<RemediationRequiredTestVerdicts | UnsupportedRetiredRemediationState> {
  const state = parseCurrentState(params.state);
  if (!state) return "unsupported_retired_state";
  const paths = resolveBoundaryPaths(params);
  const verdicts = new Map<string, RequiredTestFailure | null>();

  const workloadRead = await readSubmissionDocument(paths.workloadPath);
  if (workloadRead.kind !== "value") return verdicts;
  const workload = parseWorkload(workloadRead.value, paths, params.runId, state);
  if (!workload) return verdicts;

  const commands: string[] = [];
  for (const workItem of workload.work_items) {
    const hasPending = workItem.finding_ids.some(
      (findingId) => state.items[findingId]?.status === "pending",
    );
    if (!hasPending) continue;
    const absoluteResultPath = resolveContainedPath(
      paths.root,
      workItem.result_path,
      `result path for ${workItem.id}`,
    );
    const resultRead = await readSubmissionDocument(absoluteResultPath);
    if (resultRead.kind !== "value") continue;
    for (const command of workItem.required_tests) {
      if (!commands.includes(command)) commands.push(command);
    }
  }
  for (const command of commands) {
    verdicts.set(
      requiredTestVerdictKey(paths.root, command),
      await runRequiredTest(paths.root, command),
    );
  }
  return verdicts;
}

async function corroborateHostResult(params: {
  readonly root: string;
  readonly state: CurrentRemediationHostState;
  readonly workItem: RemediationHostWorkItem;
  readonly result: RemediationHostResult;
  readonly verdicts: RemediationRequiredTestVerdicts | null;
  /** See `ingestRemediationHostResults`'s `recovery` option. */
  readonly recovery: boolean;
}): Promise<CorroboratedHostResult> {
  const { root, state, workItem, result, verdicts } = params;
  const baseline = workItem.baseline_commit;
  const landed = result.commit_evidence.after;
  let usedRecovery = false;
  if (!gitCommitExists(root, baseline) || !gitCommitExists(root, landed)) {
    return {
      ok: false,
      code: "commit_missing",
      message: "baseline_commit and commit_evidence.after must both resolve to real commits",
    };
  }
  if (!gitCommitIsAncestor(root, baseline, landed)) {
    if (!params.recovery) {
      return {
        ok: false,
        code: "baseline_not_ancestor",
        message: "the trusted workload baseline is not an ancestor of the claimed landed commit",
      };
    }
    // The relaxation is precondition-bound: it applies ONLY when the trusted
    // baseline is genuinely ORPHANED — contained by no ref AND unreachable from
    // HEAD (see gitCommitIsOrphaned). That is the one state in which no landed
    // commit could ever descend from it, so the item is unacceptable under
    // every preparable binding. A baseline the repository still keeps — on an
    // unmerged branch, a tag, a remote ref, or HEAD itself — is a HEALTHY
    // binding, and a landed commit that does not descend from it is exactly the
    // stale-worker case the ancestry check exists to catch; recovery refuses it
    // identically to the normal lane.
    if (!gitCommitIsOrphaned(root, baseline)) {
      return {
        ok: false,
        code: "baseline_not_ancestor",
        message:
          "the trusted workload baseline is not an ancestor of the claimed landed commit, " +
          "and the baseline is NOT orphaned (a ref still contains it, or it is reachable " +
          "from HEAD), so the stale-worker protection stands and recovery cannot waive it",
      };
    }
    usedRecovery = true;
  }
  if (!gitCommitIsAncestor(root, landed, "HEAD")) {
    return {
      ok: false,
      code: "commit_not_landed",
      message: "commit_evidence.after is not reachable from the repository HEAD",
    };
  }
  const actualFiles = gitChangedFilesOfCommit(root, landed);
  if (!actualFiles || !sameStrings(actualFiles, result.changed_files)) {
    return {
      ok: false,
      code: "changed_files_mismatch",
      message:
        "the landed commit's mechanically derived changed files do not exactly match changed_files",
    };
  }
  if (actualFiles.some((path) => !workItem.allowed_files.includes(path))) {
    return {
      ok: false,
      code: "changed_files_mismatch",
      message: "the landed commit changed a file outside the prompt-bound allowed_files",
    };
  }
  const runStartDirty = new Set(
    (state.run_start_dirty ?? []).map(normalizeRepoPath),
  );
  const dirtyOverlap = actualFiles.filter((path) =>
    runStartDirty.has(normalizeRepoPath(path)),
  );
  if (dirtyOverlap.length > 0) {
    return {
      ok: false,
      code: "run_start_dirty_overlap",
      message: `landed files overlap pre-existing run-start dirt: ${dirtyOverlap.join(", ")}`,
    };
  }
  const failedTests = await rerunRequiredTests(
    root,
    workItem.required_tests,
    verdicts,
  );
  if (failedTests.length > 0) {
    const issue = requiredTestIssue(workItem, failedTests);
    return { ok: false, code: issue.code, message: issue.message };
  }
  return { ok: true, changedFiles: actualFiles, usedRecovery };
}

export async function prepareRemediationHostHandoff(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly baselineCommit: string;
  readonly state: unknown;
}): Promise<PreparedRemediationHostHandoff | UnsupportedRetiredRemediationState> {
  const state = parseCurrentState(params.state);
  if (!state) return "unsupported_retired_state";
  if (!isCommit(params.baselineCommit)) {
    throw new Error("Remediation host baselineCommit must be a full commit id");
  }

  const paths = resolveBoundaryPaths(params);
  const existingRecord = state.host_handoff;
  if (existingRecord && existingRecord.run_id !== params.runId) {
    throw new Error("Trusted remediation host handoff belongs to another run");
  }
  if (!existingRecord && isGitRepo(paths.root)) {
    const currentHead = headCommit(paths.root);
    if (currentHead !== params.baselineCommit) {
      throw new Error(
        "Remediation host baselineCommit must equal the repository HEAD when the workload is created",
      );
    }
  }

  const baselineCommit = existingRecord?.baseline_commit ?? params.baselineCommit;
  let workload: RemediationHostWorkload;
  try {
    workload = buildCanonicalWorkload({
      paths,
      state,
      runId: params.runId,
      baselineCommit,
      ...(existingRecord
        ? { workItemIds: existingRecord.work_item_ids }
        : {}),
    });
  } catch (error) {
    // A malformed block ON the frontier reaches this as a raw BlockContractError
    // — an uncaught throw whose stack says nothing about which producer wrote the
    // bad block, and which every retry reproduces. Re-raised in the SAME
    // classified aggregate form the empty-workload branch below uses, so both
    // producer-defect exits read alike.
    if (!(error instanceof BlockContractError)) throw error;
    throw new Error(cannotPrepareMessage(paths.root, state, error));
  }
  if (workload.work_items.length === 0) {
    // Name the producer defect when it is the cause. An empty level 0 that is
    // really "every candidate block declares a prerequisite that does not
    // exist" used to surface as a bare "empty workload", sending the operator
    // to look at scheduling rather than at the plan.
    const blocked = planBlockIssues(paths.root, state);
    throw new Error(
      blocked.length === 0
        ? "Cannot prepare an empty remediation host workload"
        : `Cannot prepare a remediation host workload: ${blocked
            .map((issue) => issue.message)
            .join("; ")}`,
    );
  }
  const workloadDigest = contentSha256(workload);
  if (
    existingRecord &&
    existingRecord.workload_sha256 !== workloadDigest
  ) {
    throw new Error(
      "Trusted remediation host workload no longer matches the persisted state binding",
    );
  }
  const handoffRecord: RemediationHostHandoffRecord =
    existingRecord ?? {
      contract_version: HANDOFF_RECORD_CONTRACT_VERSION,
      run_id: params.runId,
      baseline_commit: baselineCommit,
      workload_sha256: workloadDigest,
      work_item_ids: workload.work_items.map((item) => item.id),
    };

  await mkdir(paths.resultDir, { recursive: true });
  await writeJsonFile(paths.workloadPath, workload);
  return {
    workload,
    workload_path: paths.workloadPath,
    handoff_record: handoffRecord,
  };
}

/**
 * Consume the host's landed results for the trusted workload.
 *
 * ## The `recovery` option, and what it actually buys
 *
 * A trusted binding can be stranded: a post-prepare `git commit --amend` (or
 * any history rewrite) re-mints the baseline the workload was bound to, leaving
 * it ORPHANED — contained by no ref and unreachable from HEAD. Every commit the
 * host then lands sits on the re-minted line, so `baseline → landed` ancestry is
 * false for all of them, and re-preparing does not help: a fresh binding must be
 * minted at HEAD, and HEAD is a DESCENDANT of the landed work. The items are
 * unacceptable under every preparable binding, with real, reachable,
 * correctly-scoped commits on disk.
 *
 * `recovery` waives ONE check — baseline→landed ancestry — and only when
 * the baseline is genuinely orphaned by BOTH probes in `gitCommitIsOrphaned`: no
 * branch/tag/remote ref contains it, and it is not reachable from HEAD. A
 * baseline the repository still keeps (an unmerged feature branch, a tag, a
 * remote ref) also fails the ancestry test when work lands elsewhere, and that
 * is the ordinary stale-worker case — recovery refuses it. Every other
 * corroboration check runs unchanged (the landed commit exists and is reachable
 * from HEAD; its mechanically derived changed files exactly equal
 * `changed_files` and lie within the prompt-bound `allowed_files`; no overlap
 * with run-start dirt; the required tests rerun green), `parseResult` stays
 * fully strict, and dependency/phase eligibility is enforced exactly as on the
 * normal lane.
 *
 * RESIDUAL RISK, stated plainly: under an orphaned baseline the evidence bar
 * drops to "the claimed commit is reachable from the current green HEAD and
 * matches this item's scope exactly". That CANNOT prove the work was built on
 * the trusted baseline — a commit landed from a stale or unrelated starting
 * tree satisfies it as long as its own file set stays in scope. Ancestry is the
 * check that would have caught that, and it is the one being waived. Which is
 * precisely why the relaxation costs an explicit operator verb, is gated on the
 * orphan precondition, and is marked `accepted_via_recovery` on the submission
 * ledger before the item lands — and why the normal lane keeps the full check.
 *
 * In recovery mode this function performs NO required-test spawn: the verdicts
 * arrive pre-computed on the `recovery` option, and a command missing from that
 * table is treated as failed. Its caller runs the tests first, unlocked — see
 * `recoverIngestHostResults`.
 */
export async function ingestRemediationHostResults(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly state: unknown;
  /**
   * Operator-explicit recovery mode (the `recover-ingest` verb). ABSENT on
   * every normal-lane call, where behavior is unchanged.
   *
   * It carries the pre-computed required-test verdicts rather than a bare
   * boolean so the no-spawn-while-locked property is structural: there is no
   * way to ask for recovery without having already run the tests outside the
   * lock. See {@link precomputeRecoveryTestVerdicts}.
   */
  readonly recovery?: {
    readonly requiredTestVerdicts: RemediationRequiredTestVerdicts;
  };
}): Promise<RemediationHostIngestSummary | UnsupportedRetiredRemediationState> {
  const state = parseCurrentState(params.state);
  if (!state) return "unsupported_retired_state";

  const paths = resolveBoundaryPaths(params);
  const nextState = structuredClone(state);
  const issues: RemediationHostIngestIssue[] = [];
  const workloadRead = await readSubmissionDocument(paths.workloadPath);
  if (workloadRead.kind !== "value") {
    if (state.host_handoff) {
      issues.push({
        code:
          workloadRead.kind === "missing"
            ? "workload_missing"
            : "workload_invalid",
        message:
          workloadRead.kind === "missing"
            ? "the persisted trusted handoff has no workload file"
            : `the workload file is not valid JSON: ${workloadRead.detail}`,
      });
    }
    return {
      accepted_count: 0,
      completed_work_item_ids: [],
      pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
      issues,
      state_changed: false,
      state: nextState,
    };
  }

  // Producer-side plan defects are reported BEFORE the workload is parsed: a
  // block with an unresolvable dependency or an unnormalized write scope makes
  // the whole workload fail to re-derive, and `workload_invalid` alone would
  // name the symptom while hiding which block caused it.
  //
  // REPORTED, never fatal. A defect in a NON-frontier block says nothing about a
  // frontier item's landed result, and refusing the whole ingest over one made
  // the run unadvanceable: every ingest returned zero acceptances, `next-step`
  // read `state_changed: false` and re-emitted the same items against the same
  // malformed plan, forever. The frontier's OWN defect is enforced elsewhere and
  // does not rely on this: `parseWorkItem` re-derives each bound work item
  // through `buildWorkItem`, whose `assertBlockContract` throws, so a malformed
  // bound block fails the workload parse and its commands never run.
  issues.push(...planBlockIssues(paths.root, state));

  if (isGitRepo(paths.root) && !state.host_handoff) {
    issues.push({
      code: "trusted_binding_missing",
      message:
        "a git-backed remediation workload requires the tool-owned host_handoff state binding",
    });
    return {
      accepted_count: 0,
      completed_work_item_ids: [],
      pending_work_item_ids: [],
      issues,
      state_changed: false,
      state: nextState,
    };
  }

  const workload = parseWorkload(
    workloadRead.value,
    paths,
    params.runId,
    state,
  );
  if (!workload) {
    // Accumulated, not replaced: when a block-contract defect is WHY the
    // canonical re-derivation failed, the block-attributed issue is the only
    // thing that names the cause.
    issues.push({
      code: "workload_invalid",
      message:
        "the workload does not match its canonical state shape and persisted digest binding",
    });
    return {
      accepted_count: 0,
      completed_work_item_ids: [],
      pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
      issues,
      state_changed: false,
      state: nextState,
    };
  }

  const eligibleIds = new Set(
    (hostDependencyLevels(state)[0] ?? []).map((block) => block.block_id),
  );
  const resultIds = new Set<string>();
  const completed: string[] = [];
  // Recovery-only answer table; the normal lane gets null and spawns exactly as
  // it always has. See RemediationRequiredTestVerdicts.
  const requiredTestVerdicts = params.recovery?.requiredTestVerdicts ?? null;
  // Lazily loaded on the first recovery-marked acceptance: the recovery marks
  // the ledger ALREADY carries. A crash between the append and the state write
  // leaves a mark whose item is still pending, and the natural response is to
  // re-run the verb — which must converge, not accumulate a second record of
  // the same acceptance.
  let recordedRecoveryMarks: SubmissionLedgerEvent[] | null = null;
  const landedFiles = new Set(nextState.applied_edit_surface ?? []);
  // Can this ingest be corroborated against ground truth AT ALL? A git root
  // supplies the tree; a persisted `host_handoff` supplies the trusted binding.
  // With NEITHER there is nothing to check a host's claim against, and the
  // remaining evidence is the host's own attestation — which is exactly the
  // claim under test. That branch is REFUSED for both result and decision
  // documents rather than admitted on the attestation alone.
  const canCorroborate =
    state.host_handoff !== undefined || isGitRepo(paths.root);
  for (const workItem of workload.work_items) {
    const pendingItems = workItem.finding_ids.filter(
      (findingId) => nextState.items[findingId]?.status === "pending",
    );
    if (pendingItems.length === 0) continue;
    if (!eligibleIds.has(workItem.id)) {
      issues.push({
        code: "submission_contract_invalid",
        work_item_id: workItem.id,
        result_path: workItem.result_path,
        message: "the work item is no longer dependency/phase eligible",
      });
      continue;
    }

    const scan = await scanBoundSubmission<AcceptedHostResult>({
      root: paths.root,
      artifactsDir: paths.artifactsDir,
      workItemId: workItem.id,
      resultPath: workItem.result_path,
      parse: (value) => {
        const result = parseResult(value, params.runId, workItem);
        return result.ok
          ? { ok: true, parsed: result }
          : { ok: false, detail: result.reason };
      },
      resultId: (result) => result.result.result_id,
      seen: (resultId) => resultIds.has(resultId),
      messages: remediationScanMessages,
    });
    if (!scan.ok) {
      issues.push(scan.issue);
      continue;
    }
    const parsed = scan.parsed;
    const resultId = parsed.result.result_id;

    resultIds.add(resultId);
    if (parsed.kind === "decision") {
      const result = parsed.result;
      const outcome = result.outcome;
      if (outcome.status === "resolved_no_change") {
        if (!canCorroborate) {
          issues.push({
            code: "trusted_binding_missing",
            work_item_id: workItem.id,
            result_path: workItem.result_path,
            message:
              "resolved_no_change needs a git root or a persisted host_handoff binding to corroborate the write scope against; attestation-only acceptance is refused",
          });
          continue;
        }
        const noChange = corroborateNoChangeClaim({
          root: paths.root,
          workItem,
          // Ground truth only: pre-existing dirt plus the edit surface this run
          // has already corroborated and accepted (`landedFiles` starts from
          // `applied_edit_surface` and grows as this same ingest accepts).
          excusedPaths: new Set([
            ...(state.run_start_dirty ?? []).map(normalizeRepoPath),
            ...[...landedFiles].map(normalizeRepoPath),
          ]),
        });
        if (!noChange.ok) {
          issues.push({
            code: noChange.code,
            work_item_id: workItem.id,
            result_path: workItem.result_path,
            message: noChange.message,
          });
          continue;
        }
        const failedTests = await rerunRequiredTests(
          paths.root,
          workItem.required_tests,
          requiredTestVerdicts,
        );
        if (failedTests.length > 0) {
          issues.push(requiredTestIssue(workItem, failedTests));
          continue;
        }
      }
      const now = new Date().toISOString();
      for (const findingId of pendingItems) {
        const item = nextState.items[findingId]!;
        item.started_at ??= now;
        if (outcome.status === "resolved_no_change") {
          item.status = "resolved_no_change";
          item.completed_at = now;
          item.host_result_evidence = [...outcome.evidence];
          delete item.failure_reason;
        } else if (outcome.status === "blocked") {
          item.status = "blocked";
          item.completed_at = now;
          item.failure_reason = outcome.failure_reason;
        } else {
          item.status = "needs_clarification";
          delete item.completed_at;
          item.failure_reason = outcome.question;
          const clarifications = nextState.clarifications ?? [];
          if (!clarifications.some((entry) => entry.finding_id === findingId)) {
            clarifications.push({
              finding_id: findingId,
              category: isClarificationCategory(outcome.category)
                ? outcome.category
                : "scope_of_fix",
              description: outcome.question,
            });
          }
          nextState.clarifications = clarifications;
        }
      }
      completed.push(workItem.id);
      continue;
    }

    const result = parsed.result;
    if (!canCorroborate) {
      issues.push({
        code: "trusted_binding_missing",
        work_item_id: workItem.id,
        result_path: workItem.result_path,
        message:
          "a landed result needs a git root or a persisted host_handoff binding to corroborate the write scope against; attestation-only acceptance is refused",
      });
      continue;
    }
    const corroborated = await corroborateHostResult({
      root: paths.root,
      state,
      workItem,
      result,
      verdicts: requiredTestVerdicts,
      recovery: params.recovery !== undefined,
    });
    if (!corroborated.ok) {
      issues.push({
        code: corroborated.code,
        work_item_id: workItem.id,
        result_path: workItem.result_path,
        message: corroborated.message,
      });
      continue;
    }
    if (corroborated.usedRecovery) {
      // No acceptance without a record. The mark goes down BEFORE the item is
      // marked resolved, and an append that throws refuses this item rather
      // than landing an acceptance the ledger cannot account for — the run
      // must never read as one that never drifted. The refusal is per item:
      // an unwritable ledger is not a reason to discard the whole ingest.
      try {
        recordedRecoveryMarks ??= (
          await readSubmissionLedger(paths.artifactsDir)
        ).filter((event) => event.kind === "accepted_via_recovery");
        // The mark's identity is (run, item, LANDED COMMIT), not just
        // (run, item): an item re-opened and later re-accepted from a
        // DIFFERENT landing is a different relaxed acceptance and earns its
        // own record. Only a retry of the SAME landing is a duplicate. The
        // landed sha is matched inside the message because the shared event
        // contract carries no commit field, and a 40-hex sha this writer
        // itself emitted is an unambiguous token to match on.
        const landedCommit = result.commit_evidence.after;
        const alreadyMarked = recordedRecoveryMarks.some(
          (event) =>
            event.run_id === params.runId &&
            event.submission_id === workItem.id &&
            (event.message ?? "").includes(landedCommit),
        );
        if (!alreadyMarked) {
          const event: SubmissionLedgerEvent = {
            contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
            run_id: params.runId,
            submission_id: workItem.id,
            lane: workItem.id,
            kind: "accepted_via_recovery",
            // Derived from what was actually probed, never asserted: the
            // baseline was found in no ref and unreachable from HEAD.
            message:
              `accepted under recovery: the trusted baseline ${workItem.baseline_commit} is ` +
              "contained by no ref and unreachable from HEAD, so landed commit " +
              `${landedCommit} was corroborated against HEAD and this ` +
              "item's bound scope instead of against baseline ancestry",
            recorded_at: new Date().toISOString(),
          };
          await appendSubmissionEvent(paths.artifactsDir, event);
          recordedRecoveryMarks.push(event);
        }
      } catch (error) {
        issues.push({
          code: "recovery_unrecorded",
          work_item_id: workItem.id,
          result_path: workItem.result_path,
          message:
            "the recovery acceptance could not be recorded on the submission ledger, so it " +
            `was refused: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
    const acceptedFiles = corroborated.changedFiles;
    const completedAt = new Date().toISOString();
    for (const findingId of pendingItems) {
      const item = nextState.items[findingId]!;
      item.status = "resolved";
      item.started_at ??= completedAt;
      item.completed_at = completedAt;
      delete item.failure_reason;
      delete item.host_result_evidence;
    }
    for (const changedFile of acceptedFiles) landedFiles.add(changedFile);
    completed.push(workItem.id);
  }

  if (completed.length > 0) {
    nextState.applied_edit_surface = [...landedFiles].sort(compareCodeUnits);
  }

  const pendingWorkItemIds = workload.work_items
    .filter((workItem) =>
      workItem.finding_ids.some(
        (findingId) => nextState.items[findingId]?.status === "pending",
      ),
    )
    .map((workItem) => workItem.id);
  let stateChanged = completed.length > 0;
  if (nextState.host_handoff && pendingWorkItemIds.length === 0) {
    delete nextState.host_handoff;
    stateChanged = true;
  }

  return {
    accepted_count: completed.length,
    completed_work_item_ids: completed,
    pending_work_item_ids: pendingWorkItemIds,
    issues,
    state_changed: stateChanged,
    state: nextState,
  };
}
