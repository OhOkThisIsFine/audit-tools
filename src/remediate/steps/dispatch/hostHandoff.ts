// sites-pinned: tests/remediate/host-handoff-corroboration.test.ts, tests/remediate/host-handoff.test.ts
//   host-handoff-corroboration: the bounded required-test failure message.
//   host-handoff: the "landing gates" block fails when the close-owns-the-gates prompt line
//   or the id-glossary write scope is reverted.
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  headCommit,
  commandLeavesDeclaredShape,
  FindingSchema,
  SUBMISSION_ISSUE_REMEDY,
  WORKLOAD_ISSUE_REMEDY,
  bindWorkerPrompt,
  deriveResultId,
  type IssueRemedy,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  appendSubmissionEvent,
  enrichMissingSubmissionIssues,
  isMissingObservation,
  type WorkItemOutcome,
  compareCodeUnits,
  contentSha256,
  declaredInvariantIds,
  deriveLaneDemand,
  discoverLandingGates,
  hasExactKeys,
  identityFailureDiagnostic,
  hostHandoffResultPath,
  idsAreStrictlyAscending,
  isCommit,
  isGitRepo,
  isRecord,
  isSha256,
  LaneDemandSchema,
  normalizeRepoPath,
  parseAllWorkloadItems,
  parseWorkloadEnvelope,
  readSubmissionDocument,
  readSubmissionLedger,
  readTrailingSubmissionRefusals,
  recoveryMarkMatches,
  recordHostResultOutcomes,
  repoRelativePath,
  resolveContainedPath,
  sameStrings,
  scanBoundSubmission,
  SEVERITIES,
  severityRank,
  stringArray,
  stableStringify,
  withGlossaryScope,
  writeJsonFile,
  type FindingSeverity,
  type IngestionCheckId,
  type SubmissionIssue,
  type SubmissionLedgerEvent,
  type SubmissionScanMessages,
} from "audit-tools/shared";
import {
  type RemediationState,
} from "../../state/store.js";
import {
  REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA1,
  REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2,
  REMEDIATION_HOST_SCOPE_SEMANTICS,
  isClarificationCategory,
  type RemediationBlock,
  type RemediationHostHandoffRecord,
} from "../../state/types.js";
import {
  isTerminalStatus,
  isVerifiedCompleteStatus,
} from "../../state/itemStatus.js";
import {
  recordIgnoredRootLogsPreInventory,
  readNewlyCreatedIgnoredRootLogs,
} from "../../../shared/submission/ignoredRootLogs.js";

import {
  REMEDIATION_HOST_DECISION_CONTRACT_VERSION as DECISION_CONTRACT_VERSION,
  REMEDIATION_HOST_RESULT_CONTRACT_VERSION as RESULT_CONTRACT_VERSION,
  REMEDIATION_HOST_WORKLOAD_CONTRACT_VERSION as WORKLOAD_CONTRACT_VERSION,
} from "../types.js";
import {
  type BoundaryPaths,
  type CurrentRemediationHostState,
  type UnsupportedRetiredRemediationState,
  type RemediationHostWorkItem,
  type RemediationHostWorkload,
  type RemediationHostResult,
  type RemediationHostIngestIssue,
  type RemediationIssueCode,
  parseCurrentState,
  resolveBoundaryPaths,
} from "./internal.js";
import {
  mintConformanceReview,
  parseConformanceVerdict,
  readLegacyConformanceReviewSelection,
  type ConformanceReviewRequest,
} from "./conformanceReview.js";
import {
  corroborateHostResult,
  corroborateNoChangeClaim,
} from "./corroboration.js";
import {
  requiredTestVerdictKey,
  runRequiredTest,
  type RequiredTestFailure,
  requiredTestIssue,
  rerunRequiredTests,
  type RemediationRequiredTestVerdicts,
} from "./requiredTests.js";
import { CannotPrepareWorkloadError } from "./marshal.js";

export { REMEDIATION_ISSUE_CODES } from "./internal.js";
export type { BoundaryPaths, CurrentRemediationHostState, UnsupportedRetiredRemediationState, RemediationHostWorkItem, RemediationHostWorkload, RemediationHostResult, RemediationHostIngestIssue, RemediationIssueCode } from "./internal.js";

export interface PreparedRemediationHostHandoff {
  readonly workload: RemediationHostWorkload;
  readonly workload_path: string;
  /** Persist this in RemediationState before exposing the workload to the host. */
  readonly handoff_record: RemediationHostHandoffRecord;
}

/**
 * What the host must DO about each remediation ingest code (owner review of
 * prompt 20, 2026-09-18). The `Record` over the whole union is the enforcement:
 * a code added above with no remedy here is a type error. Read `IssueRemedy`
 * for what the four remedies mean.
 */
const REMEDIATION_ISSUE_REMEDY: Readonly<Record<RemediationIssueCode, IssueRemedy>> = {
  ...SUBMISSION_ISSUE_REMEDY,
  ...WORKLOAD_ISSUE_REMEDY,
  // Here a duplicate is two result files carrying one result_id in the same
  // call, and NEITHER is accepted — so the item is still pending and the fix is
  // a corrected file. (The audit draw raises it only after an acceptance, so
  // there it stays settled.)
  duplicate_submission_id: "repair",
  // The run's own documents: the next prepare re-mints the workload and its
  // binding in the same call, so nothing is asked of the host.
  workload_missing: "none",
  workload_invalid: "none",
  trusted_binding_missing: "none",
  // A fault in the landed work or in the result that describes it — a worker
  // can make a new commit or correct the file.
  commit_missing: "repair",
  commit_not_landed: "repair",
  baseline_not_ancestor: "repair",
  changed_files_mismatch: "repair",
  run_start_dirty_overlap: "repair",
  required_test_failed: "repair",
  required_test_timed_out: "repair",
  landed_commit_invalid: "repair",
  // The plan, the run's recorded state, or the tool's own limit is at fault.
  required_test_output_overflow: "operator",
  dependency_missing: "operator",
  block_contract_invalid: "operator",
  recovery_unrecorded: "operator",
  tree_moved_between_phases: "operator",
  state_moved_between_phases: "operator",
  baseline_missing: "operator",
  baseline_orphaned: "operator",
  work_item_not_eligible: "operator",
  // The opt-in conformance review did not admit the result. "Repair" is the
  // dominant action a host can take: strengthen the cited evidence (an
  // `insufficient` verdict), re-recruit an independent reviewer (`unavailable`),
  // or re-mint the review against the changed content (`stale`). All three read
  // as "not accepted — try again next-step", never a mechanical refusal.
  conformance_review: "repair",
};

/** The remedy for one classified remediation ingest failure. */
export function remediationIssueRemedy(
  issue: SubmissionIssue<RemediationIssueCode>,
): IssueRemedy {
  return REMEDIATION_ISSUE_REMEDY[issue.code];
}


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
  /**
   * Newly created ignored root logs detected by comparing pre- and post-execution
   * inventory around host execution (excluding sanctioned artifact destinations).
   * Reported for operator visibility; never automatically deleted.
   */
  readonly ignored_root_logs?: readonly string[];
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


function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => known.has(key));
}

function normalizeDeclaredPath(root: string, candidate: string, label: string): string {
  if (candidate.length === 0 || isAbsolute(candidate)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const normalized = repoRelativePath(root, candidate, label);
  return candidate.endsWith("/") ? `${normalized}/` : normalized;
}

/**
 * Recover only the directory marker the pre-0.50.2 producer erased.
 *
 * The persisted workload remains byte-for-byte bound. This creates an
 * in-memory consumer view only after canonical workload validation, and only
 * when a finding assigned to this same work item carries the exact slash form
 * plus a syntactically valid plan-time content hash. Live filesystem shape,
 * git tree shape, and a coincidentally named directory are deliberately not
 * evidence: any of those would turn an exact legacy file scope into a blanket
 * widening rule.
 */
interface LegacyDirectoryScopeRecovery {
  readonly workItem: RemediationHostWorkItem;
  readonly directoryPaths: readonly string[];
}

function deriveLegacyDirectoryPathsForBlock(
  state: CurrentRemediationHostState,
  blockId: string,
  declaredPaths: readonly string[],
): string[] {
  const binding = state.host_handoff;
  if (binding?.contract_version !== REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA1) {
    return [];
  }
  const block = state.plan.blocks.find((entry) => entry.block_id === blockId);
  if (!block) return [];

  const hashedDirectoryPaths = new Set<string>();
  for (const findingId of block.items) {
    const finding = state.plan.findings.find((entry) => entry.id === findingId);
    if (!finding) continue;
    for (const affectedFile of finding.affected_files) {
      if (
        affectedFile.path.endsWith("/") &&
        isSha256(affectedFile.hash_at_plan_time)
      ) {
        hashedDirectoryPaths.add(affectedFile.path);
      }
    }
  }

  return declaredPaths.flatMap((path) => {
    const directoryPath = `${path}/`;
    return !path.endsWith("/") && hashedDirectoryPaths.has(directoryPath)
      ? [directoryPath]
      : [];
  });
}

function deriveLegacyDirectoryScopeRecovery(
  state: CurrentRemediationHostState,
  workItem: RemediationHostWorkItem,
): LegacyDirectoryScopeRecovery {
  if (!state.host_handoff?.work_item_ids.includes(workItem.id)) {
    return { workItem, directoryPaths: [] };
  }
  const directoryPaths = deriveLegacyDirectoryPathsForBlock(
    state,
    workItem.id,
    workItem.allowed_files,
  );
  const recovered = new Set(directoryPaths);
  const allowedFiles = workItem.allowed_files.map((allowed) => {
    const directoryPath = `${allowed}/`;
    return recovered.has(directoryPath) ? directoryPath : allowed;
  });
  return {
    workItem: sameStrings(allowedFiles, workItem.allowed_files)
      ? workItem
      : { ...workItem, allowed_files: allowedFiles },
    directoryPaths,
  };
}

function effectiveBoundWorkload(
  state: CurrentRemediationHostState,
  workload: RemediationHostWorkload,
): RemediationHostWorkload {
  if (!state.host_handoff) return workload;
  return {
    ...workload,
    work_items: workload.work_items.map((workItem) =>
      deriveLegacyDirectoryScopeRecovery(state, workItem).workItem,
    ),
  };
}

/**
 * Persist the same directory intent for every block in a legacy plan before
 * its final active workload is cleared. Dependency-blocked blocks are included
 * because their next workload will be minted under v1alpha2 and cannot use
 * legacy inference. This must run only on the final drain: changing a currently
 * bound block sooner would break byte-for-byte canonical re-derivation.
 */
function migrateLegacyDirectoryScopesAfterFinalDrain(
  state: CurrentRemediationHostState,
): void {
  state.plan.blocks = state.plan.blocks.map((block) => {
    const recovered = new Set(
      deriveLegacyDirectoryPathsForBlock(
        state,
        block.block_id,
        block.touched_files,
      ),
    );
    if (recovered.size === 0) return block;
    const touchedFiles = block.touched_files.map((path) =>
      !path.endsWith("/") && recovered.has(`${path}/`) ? `${path}/` : path,
    );
    return sameStrings(touchedFiles, block.touched_files)
      ? block
      : {
          ...block,
          touched_files: [...new Set(touchedFiles)].sort(compareCodeUnits),
        };
  });
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
 * COVERS THE HANDOFF BOUNDARY ONLY. The other consumer of the same
 * `block.targeted_commands` — `reverifyBlockedItemAgainstTree` in
 * `src/remediate/phases/triage.ts` — asks the same declared command-shape rule
 * before spawning and then runs each command through {@link runRequiredTest}
 * (argv-split, no shell, deadline-bounded), so a command this boundary would
 * refuse is refused there too rather than reaching a shell.
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
      normalized = normalizeDeclaredPath(
        root,
        raw,
        `${block.block_id}.touched_files[]`,
      );
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


/**
 * The bound path for one work item's submission — the SHARED rule, not a local
 * copy of it. This and its audit twin were byte-equivalent private helpers; a
 * divergence between them would have been silent on both sides.
 */
function resultPathFor(paths: BoundaryPaths, workItemId: string): string {
  return hostHandoffResultPath(paths, workItemId);
}

/**
 * The carried module contracts for one bound work item, read from the block the
 * item was minted from. The work item's prompt carries these verbatim and its
 * `obligation_ids` derive from the same block's findings; the conformance review
 * binds both, so the review judges the SAME interface the worker was shown.
 */
function moduleContractsFor(
  state: CurrentRemediationHostState,
  workItem: RemediationHostWorkItem,
): readonly { module: string; contract: Readonly<Record<string, unknown>> }[] {
  const block = state.plan.blocks.find((entry) => entry.block_id === workItem.id);
  return (block?.module_contracts ?? []).map((entry) => ({
    module: entry.module,
    contract: entry.contract as Readonly<Record<string, unknown>>,
  }));
}

/** The verdict outcome for a review request: parse the bound verdict file, or `unavailable` when absent. */
async function readConformanceVerdict(
  paths: BoundaryPaths,
  workItemId: string,
  request: ConformanceReviewRequest,
): Promise<ReturnType<typeof parseConformanceVerdict>> {
  const verdictPath = conformanceReviewVerdictPath(paths, workItemId);
  let text: string;
  try {
    text = await readFile(verdictPath, "utf8");
  } catch {
    // Absent reads as "the review has not passed yet" — a HOLD, never a silent
    // pass. This is the "unavailable required review pauses" arm for the case
    // where no reviewer wrote anything at all.
    return { kind: "unavailable", rationale: "no conformance review verdict was written" };
  }
  // `parseConformanceVerdict` owns the JSON parse (and its refusal prose), so
  // the raw text is handed through untouched — a BOM or malformed bytes are its
  // to classify, not this module's.
  return parseConformanceVerdict(text, request);
}

/** The classified message for a non-passing conformance-review outcome. */
function conformanceIssueMessage(
  outcome: ReturnType<typeof parseConformanceVerdict>,
  workItemId: string,
): string {
  switch (outcome.kind) {
    case "insufficient":
      return `conformance review judged the cited obligation evidence insufficient to demonstrate conformance to the carried contracts: ${outcome.rationale}`;
    case "unavailable":
      return `the per-run conformance review is required but no independent reviewer was available (${outcome.rationale}); the result is held, not accepted`;
    case "stale":
      return "the conformance review is bound to a result or contract set that has changed; the review must be re-minted against the current content";
    case "refused":
      return `the conformance review verdict could not be read: ${outcome.reason}`;
    case "pass":
      // Unreachable: the caller only builds a message for non-passing outcomes.
      return `review passed for ${workItemId}`;
  }
}

/** Absolute path of the conformance-review REQUEST for one work item. */
function conformanceReviewRequestPath(
  paths: BoundaryPaths,
  workItemId: string,
): string {
  return resolveContainedPath(
    paths.root,
    `${paths.runDir}/conformance-review/${workItemId}.request.json`,
    `conformance review request path for ${workItemId}`,
  );
}

/** Absolute path of the conformance-review VERDICT for one work item. */
function conformanceReviewVerdictPath(
  paths: BoundaryPaths,
  workItemId: string,
): string {
  return resolveContainedPath(
    paths.root,
    `${paths.runDir}/conformance-review/${workItemId}.verdict.json`,
    `conformance review verdict path for ${workItemId}`,
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
  // The shape gate reads only the item's identity (id and prompt digest). The
  // write scope is checked at ingest against the landed commit, so no stored
  // state can widen what this validator accepts.
  return {
    submissionDir: paths.resultDir,
    validate: (value: unknown): SubmissionIssue | null => {
      const parsed = parseResult(value, params.runId, workItem);
      return parsed.ok
        ? null
        : { code: "submission_contract_invalid", check: parsed.check, message: parsed.reason };
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

/**
 * Pending blocks that can NEVER dispatch — the dead-end sweep's one source,
 * kept beside {@link hostDependencyLevels} so the sweep and the workload
 * boundary share one eligibility semantics and cannot disagree (the 2026-08-23
 * empty-frontier incident: the old edge-only sweep predicate missed the phase
 * barrier and dependency existence, so a frontier the builder refused looked
 * dispatchable to the guard and next-step threw instead of pausing).
 *
 * Optimistic liveness fixpoint: an item counts as still SATISFIABLE while it is
 * verified-complete, `pending`, or `needs_clarification` — an unanswered
 * question is "awaiting an answer", never "upstream failed" (the 175cfb89
 * pin). A block is LIVE once every one of its items is satisfiable, every
 * declared dependency resolves to a live block, and every lower-phase block is
 * live. What never enters the live set is exactly what can never reach the
 * host: an obstacle chain that bottoms out in a terminal non-verified item
 * (`blocked` or a SKIP — INV-RS-01), a dependency id that resolves to no
 * block, or a dependency cycle.
 */
export function permanentlyDeadPendingBlocks(
  state: Pick<RemediationState, "plan" | "items">,
): RemediationBlock[] {
  const plan = state.plan;
  const items = state.items;
  if (!plan || !items) return [];

  const satisfiable = (status: string | undefined): boolean =>
    isVerifiedCompleteStatus(status) ||
    status === "pending" ||
    status === "needs_clarification";
  const phaseOf = (block: RemediationBlock): number => block.phase_ordinal ?? 0;
  const blockById = new Map(plan.blocks.map((block) => [block.block_id, block]));

  // Fully-verified blocks seed the live set unconditionally: their work already
  // landed, so their own declared dependencies are history, not obstacles.
  const live = new Set<string>(
    plan.blocks
      .filter((block) =>
        block.items.every((findingId) =>
          isVerifiedCompleteStatus(items[findingId]?.status),
        ),
      )
      .map((block) => block.block_id),
  );

  // Least fixpoint: grow the live set until stable. A cycle never enters it.
  for (let grew = true; grew; ) {
    grew = false;
    for (const block of plan.blocks) {
      if (live.has(block.block_id)) continue;
      if (!block.items.every((findingId) => satisfiable(items[findingId]?.status))) {
        continue;
      }
      const dependenciesLive = (block.dependencies ?? []).every((dependencyId) => {
        const dependency = blockById.get(dependencyId);
        return dependency !== undefined && live.has(dependency.block_id);
      });
      const lowerPhasesLive = plan.blocks
        .filter((lower) => phaseOf(lower) < phaseOf(block))
        .every((lower) => live.has(lower.block_id));
      if (dependenciesLive && lowerPhasesLive) {
        live.add(block.block_id);
        grew = true;
      }
    }
  }

  return plan.blocks.filter(
    (block) =>
      !live.has(block.block_id) &&
      block.items.some((findingId) => items[findingId]?.status === "pending"),
  );
}

function buildPrompt(item: {
  readonly blockId: string;
  readonly findingIds: readonly string[];
  readonly assignments: readonly Record<string, unknown>[];
  readonly allowedFiles: readonly string[];
  readonly baselineCommit: string;
  readonly requiredTests: readonly string[];
  readonly resultPath: string;
  readonly obligationIds: readonly string[];
  /**
   * Whether the repository declares any landing gate at all — a fact about the
   * target root, not about this item. It only decides whether the emitted
   * prompt's ONE sentence points the host at a close that will run gates; the
   * gates themselves are the CLOSE's, never this item's (see `buildWorkItem`).
   */
  readonly hasLandingGates: boolean;
  readonly moduleContracts: readonly { module: string; contract: Record<string, unknown> }[];
}): string {
  const assignment = stableStringify({
    allowed_files: item.allowedFiles,
    assignments: item.assignments,
    baseline_commit: item.baselineCommit,
    finding_ids: item.findingIds,
    id: item.blockId,
    // The approved contract rides the sha-bound prompt (the evidence-coverage
    // entry in docs/backlog/open-bugs.md): the binding then covers exactly the
    // interface the worker saw.
    ...(item.moduleContracts.length > 0
      ? { module_contracts: item.moduleContracts }
      : {}),
    ...(item.obligationIds.length > 0
      ? { obligation_ids: item.obligationIds }
      : {}),
    required_tests: item.requiredTests,
    result_path: item.resultPath,
  });
  // The BODY only. The result template is appended by `bindWorkerPrompt`, and
  // the prompt digest covers exactly this text (owner review of prompt 20,
  // 2026-09-18: plain language, rules as bullets, no word a worker cannot act
  // on).
  return [
    `# Implement remediation work item \`${item.blockId}\``,
    "",
    "Assignment:",
    "",
    "```json",
    assignment,
    "```",
    "",
    "Rules:",
    "",
    '- Edit only the files in `allowed_files`. An entry that ends in "/" allows every file below that directory. Every other entry allows only that one file.',
    "- Apply each finding in `assignments` exactly, with the clarified scope or the retry context it carries.",
    ...(item.moduleContracts.length > 0
      ? [
          "- Conform to each contract in `module_contracts`: every declared input, output, invariant, side effect, validation boundary, failure mode and seam adjustment. Code that breaks a contract is a defect, even when the build and the tests pass.",
        ]
      : []),
    ...(item.requiredTests.length > 0
      ? [
          "- Run each command in `required_tests` until it passes. The tool runs each command again before it accepts your result.",
        ]
      : []),
    "- Make one commit on top of `baseline_commit`, with all your edits in it. Merge it so that HEAD contains it.",
    ...(item.hasLandingGates
      ? ["- Do not run the landing gates. The close phase runs them once, on the merged tree."]
      : []),
  ].join("\n");
}

/**
 * The result template every remediation worker prompt ends with. The tool
 * fills the identity values from the body digest; the worker changes only the
 * marked values. The decision form follows for an item where no edit should
 * land.
 */
function renderResultTemplate(item: {
  readonly runId: string;
  readonly blockId: string;
  readonly resultPath: string;
  readonly obligationIds: readonly string[];
  readonly promptDigest: string;
}): string {
  const identity = {
    result_id: deriveResultId(item.blockId, item.promptDigest),
    run_id: item.runId,
    work_item_id: item.blockId,
    prompt_sha256: item.promptDigest,
  };
  const landed = {
    contract_version: RESULT_CONTRACT_VERSION,
    ...identity,
    landed_commit: "<full id of your commit>",
    obligation_evidence: item.obligationIds.map((obligationId) => ({
      obligation_id: obligationId,
      evidence: ["<a file, symbol or test that shows this obligation holds>"],
    })),
  };
  const decision = {
    contract_version: DECISION_CONTRACT_VERSION,
    ...identity,
    outcome: "<one of the three forms below>",
  };
  return [
    `When HEAD contains your commit, write this JSON to \`${item.resultPath}\`. Change only the ${item.obligationIds.length > 0 ? "marked values" : "marked value"}:`,
    "",
    "```json",
    JSON.stringify(landed, null, 2),
    "```",
    "",
    `If no edit should land, write this JSON to \`${item.resultPath}\` instead. Replace \`outcome\` with one of the three forms below:`,
    "",
    "```json",
    JSON.stringify(decision, null, 2),
    "```",
    "",
    '- `{"status": "resolved_no_change", "evidence": ["<why the code needs no change>"]}`',
    '- `{"status": "blocked", "failure_reason": "<what stops the work>"}`',
    '- `{"status": "needs_clarification", "question": "<your question>"}` — you can also add a `"category"`.',
  ].join("\n");
}

/**
 * The remediate draw's risk score for one block, in `[0, 1]`.
 *
 * The per-mode INPUT to the shared ranking is what this draw's artifacts
 * already carry: the severities of the findings the block addresses. A block
 * fixing three `critical` findings is not the same dispatch as one fixing a
 * single `info`, and before this it looked identical to the host.
 *
 * The score is the WORST severity in the block, with the count of same-or-worse
 * findings nudging it up — a block of many high-severity findings is above a
 * block with one. Deterministic (no clock, no sampling) and bounded by
 * construction. A block whose findings are all absent from the plan contributes
 * nothing, so an unresolvable block honestly ranks `low` rather than being
 * guessed at.
 */
export function severityRiskWeight(severity: FindingSeverity): number {
  // DERIVED from the shared tuple, never a second copy of it. This used to be a
  // hand-written `Record<string, number>` — a second severity vocabulary beside
  // the one `FindingSeveritySchema`/`SEVERITIES`/`severityRank` single-source in
  // `src/shared/types/lens.ts` — read through `?? 0`. A severity added to the
  // shared union fell through that fallback and weighted as ZERO, i.e. the
  // safest possible rank, so a block of brand-new-critical findings dispatched
  // as if it fixed nothing. The return type is the shared union, and `SEVERITIES`
  // is the tuple it is DERIVED from, so that class of miss is now a type error
  // rather than a silent downgrade.
  //
  // The scale is "how far up the severity ladder", 1 at the top and 0 at the
  // bottom: ORDER is the shared fact, and this is only the scale applied to it.
  // The values reproduce the hand-written table this replaced EXACTLY
  // (1 / 0.75 / 0.5 / 0.25 / 0.1 for five tiers), so no emitted ranking moves.
  //
  // The bottom tier's floor is deliberate. Unguarded it would be 0 — the same
  // weight as "this block's findings could not be resolved at all" — and those
  // are different facts: a block that fixes `info` findings is a real, if
  // smallest, dispatch, while an unresolvable block is a hole in the plan.
  // Keeping the bottom off zero is what lets `blockRiskScore`'s corroboration
  // bump distinguish them.
  const ladder = SEVERITIES.length - 1;
  return severity === "info"
    ? 0.1
    : ladder === 0
      ? 1
      : (severityRank(severity) - 1) / ladder;
}

function blockRiskScore(
  state: CurrentRemediationHostState,
  block: RemediationBlock,
): number {
  const scores = block.items
    .map(
      (findingId) =>
        state.plan.findings.find((entry) => entry.id === findingId)?.severity,
    )
    .flatMap((severity) =>
      severity === undefined ? [] : [severityRiskWeight(severity)],
    );
  if (scores.length === 0) return 0;
  const worst = Math.max(...scores);
  // Each additional finding at or above half the worst severity adds a tenth,
  // capped: breadth within a severity band is real but must not outrank a
  // genuinely worse finding.
  const corroborating = scores.filter((score) => score >= worst / 2).length - 1;
  return Math.min(1, worst + Math.max(0, corroborating) * 0.1);
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
  runId: string,
  block: RemediationBlock,
  baselineCommit: string,
  state: CurrentRemediationHostState,
): RemediationHostWorkItem {
  // The consumed-shape gate runs FIRST: a block outside the write-scope /
  // command contract must never become a work item, so nothing downstream can
  // dispatch it or execute its commands.
  assertBlockContract(paths.root, block);
  // THE ID-GLOSSARY SCOPE. A block whose contract COINS an invariant id writes
  // it in `src/`, and the glossary document that has to document it sits
  // outside every module's file scope — so without this the item is
  // structurally unable to satisfy the id-glossary gate. Read off the block's
  // own contract and obligations, never guessed; the ids the document already
  // carries are subtracted inside `withGlossaryScope`, so a contract that only
  // MENTIONS an existing id (a seam adjustment citing `INV-COVERAGE`, say) gets
  // no widening — it coins nothing and needs no row.
  const declaredIds = declaredInvariantIds({
    obligations: block.items.flatMap(
      (findingId) =>
        state.plan.findings.find((entry) => entry.id === findingId)
          ?.contract_obligation_ids ?? [],
    ),
    module_contracts: block.module_contracts ?? [],
  });
  const allowedFiles = withGlossaryScope(
    paths.root,
    [...new Set(block.touched_files)].map((path) =>
      normalizeDeclaredPath(paths.root, path, `${block.block_id}.touched_files[]`),
    ).sort(compareCodeUnits),
    declaredIds,
  );
  const resultPath = resultPathFor(paths, block.block_id);
  // THE LANDING GATES ARE NOT THIS ITEM'S. `check:deadcode`, `check:depgraph`,
  // lint and the id-glossary gate state facts about the WHOLE tree, so the
  // boundary that owns them is the CLOSE, on the merged tree — never a
  // per-item dispatch. Folding them in here was tried and refused a wave item
  // that added an export whose only consumer lands in a LATER item: no edit
  // inside the item's scope could pass, and another item's fault could refuse
  // this one. See CLAUDE.md, *A gate states the boundary it OWNS*; the close
  // leg is `verifyLandingGates` in `src/remediate/phases/close.ts`.
  //
  // The per-item required tests are the block's OWN commands, unchanged, which
  // is what this field meant before the gates were folded in and what the
  // tool reruns at ingestion.
  //
  // ONE FACT still rides the emitted prompt: whether the target root declares
  // any landing gate at all, so the host knows a close will run them.
  const hasLandingGates = discoverLandingGates(paths.root).length > 0;
  const requiredTests = [...(block.targeted_commands ?? [])];
  const assignments = buildFindingAssignments(state, block);
  // The obligation demand is bound here, once, from the same plan findings the
  // assignments render — ingestion then re-derives this exact set through the
  // byte-for-byte work-item comparison, so the result's evidence coverage is
  // checked against a tool-owned binding, never the result's own claim.
  const obligationIds = [
    ...new Set(
      block.items.flatMap(
        (findingId) =>
          state.plan.findings.find((entry) => entry.id === findingId)
            ?.contract_obligation_ids ?? [],
      ),
    ),
  ].sort(compareCodeUnits);
  const prompt = bindWorkerPrompt(buildPrompt({
    blockId: block.block_id,
    findingIds: block.items,
    assignments,
    allowedFiles,
    baselineCommit,
    obligationIds,
    requiredTests,
    hasLandingGates,
    resultPath,
    moduleContracts: block.module_contracts ?? [],
  }), (promptDigest) =>
    renderResultTemplate({
      runId,
      blockId: block.block_id,
      resultPath,
      obligationIds,
      promptDigest,
    }),
  );
  return {
    id: block.block_id,
    finding_ids: [...block.items],
    allowed_files: allowedFiles,
    baseline_commit: baselineCommit,
    obligation_ids: obligationIds,
    prompt: { text: prompt.text, sha256: prompt.sha256 },
    required_tests: requiredTests,
    result_path: resultPath,
    demand: deriveLaneDemand({
      tokenEstimate: block.token_estimate ?? 0,
      fileCount: allowedFiles.length,
      riskScore: blockRiskScore(state, block),
    }),
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
      buildWorkItem(params.paths, params.runId, block, params.baselineCommit, params.state),
    ),
  };
}

function parseWorkItem(
  value: unknown,
  paths: BoundaryPaths,
  runId: string,
  state: CurrentRemediationHostState,
  expectedBaselineCommit?: string,
): RemediationHostWorkItem | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "allowed_files",
      "baseline_commit",
      "demand",
      "finding_ids",
      "id",
      "obligation_ids",
      "prompt",
      "required_tests",
      "result_path",
      "token_estimate",
    ]) ||
    typeof value.id !== "string" ||
    !LaneDemandSchema.safeParse(value.demand).success ||
    !isCommit(value.baseline_commit) ||
    !Array.isArray(value.finding_ids) ||
    !value.finding_ids.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.obligation_ids) ||
    !value.obligation_ids.every((entry) => typeof entry === "string") ||
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
    !isSha256(value.prompt.sha256)
  ) {
    return null;
  }

  const block = state.plan.blocks.find((candidate) => candidate.block_id === value.id);
  if (!block) return null;
  let expected: RemediationHostWorkItem;
  try {
    expected = buildWorkItem(
      paths,
      runId,
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
    parseWorkItem(item, paths, runId, state, binding?.baseline_commit),
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

/**
 * The MINTED verdict table: a Map subclass that exists only inside this module.
 *
 * The type above says "a table of verdicts"; it cannot say "a table produced by
 * actually running the tests". A plain-JS caller at the package boundary — or a
 * `as unknown as` cast — can hand the ingest a hand-built map in which every
 * command reads `null`, i.e. green, without spawning anything. So the trust the
 * ingest needs is a RUNTIME property, and a module-private subclass is exactly
 * that: {@link precomputeRecoveryTestVerdicts} is the only code that can produce
 * one, and because the class is never exported, no other module can construct or
 * subclass it. A caller that wants a trusted table can still get one — by
 * calling the minter, which runs the tests, which is the whole point.
 */
class MintedRequiredTestVerdicts extends Map<string, RequiredTestFailure | null> {}

/** Whether a caller-supplied verdict table came from {@link precomputeRecoveryTestVerdicts}. */
function isMintedVerdictTable(
  value: unknown,
): value is RemediationRequiredTestVerdicts {
  return value instanceof MintedRequiredTestVerdicts;
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
  /**
   * Per-command deadline, forwarded to {@link runRequiredTest}. Optional for the
   * same reason `runRequiredTest` takes one: a `timed_out` or `output_overflow`
   * verdict is a first-class outcome of this function, and an outcome reachable
   * only by waiting ten real minutes is an outcome nothing ever tests.
   */
  readonly requiredTestTimeoutMs?: number;
}): Promise<RemediationRequiredTestVerdicts | UnsupportedRetiredRemediationState> {
  const state = parseCurrentState(params.state);
  if (!state) return "unsupported_retired_state";
  const paths = resolveBoundaryPaths(params);
  const verdicts = new MintedRequiredTestVerdicts();

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
      await runRequiredTest(paths.root, command, params.requiredTestTimeoutMs),
    );
  }
  return verdicts;
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
  | { readonly ok: false; readonly check: IngestionCheckId; readonly reason: string };

/** `check` names the registered ingestion check that failed; `reason` is its prose. */
function invalidResult(check: IngestionCheckId, reason: string): ParsedHostResult {
  return { ok: false, check, reason };
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
    // Envelope first, identity second: one message (the host repairs the same
    // file either way), two registered checks, so the issue names which failed.
    if (
      !hasExactKeys(value, [
        "contract_version",
        "result_id",
        "run_id",
        "work_item_id",
        "prompt_sha256",
        "outcome",
      ]) ||
      !isRecord(value.outcome) ||
      typeof value.outcome.status !== "string"
    ) {
      return invalidResult(
        "result_envelope",
        "decision must match the exact current run, work-item, and prompt binding",
      );
    }
    // The identity walk AND its vocabulary are the CORE's, so this refusal
    // names the same broken component the audit draw names for the same
    // submission — the shared sentence is appended to this draw's framing,
    // which addresses a host repairing a remediation decision.
    const decisionIdentityFailure = identityFailureDiagnostic(value, {
      runId,
      workItemId: workItem.id,
      promptSha256: workItem.prompt.sha256,
    });
    if (decisionIdentityFailure !== null) {
      return invalidResult(
        "identity_binding",
        `decision must match the exact current run, work-item, and prompt binding: ${decisionIdentityFailure}`,
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
          "outcome_shape",
          "resolved_no_change requires a non-empty evidence string array",
        );
      }
    } else if (outcome.status === "blocked") {
      if (
        !hasExactKeys(outcome, ["status", "failure_reason"]) ||
        typeof outcome.failure_reason !== "string" ||
        outcome.failure_reason.trim().length === 0
      ) {
        return invalidResult("outcome_shape", "blocked requires a non-empty failure_reason");
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
          "outcome_shape",
          "needs_clarification requires a non-empty question and optional canonical category",
        );
      }
    } else {
      return invalidResult(
        "outcome_shape",
        "decision outcome.status must be resolved_no_change, blocked, or needs_clarification",
      );
    }
    return {
      ok: true,
      kind: "decision",
      result: value as unknown as RemediationHostDecision,
    };
  }

  // v1alpha3 (owner review of prompt 20, 2026-09-18): the host states the
  // landed commit and the obligation evidence, and nothing it could only
  // restate. The changed files come from git, the tests from the tool's own
  // rerun, and the landing from ancestry — `corroborateHostResult` derives and
  // checks each of them, so an extra key here is a refusal, never a hint.
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contract_version",
      "landed_commit",
      "obligation_evidence",
      "prompt_sha256",
      "result_id",
      "run_id",
      "work_item_id",
    ]) ||
    value.contract_version !== RESULT_CONTRACT_VERSION
  ) {
    return invalidResult(
      "result_envelope",
      "result must match the exact current contract, run, work-item, and prompt binding",
    );
  }
  // The identity walk AND its vocabulary are the CORE's, so the same broken
  // submission is reported with the same named component whichever half of the
  // pipeline reads it. Only the framing is this draw's.
  const resultIdentityFailure = identityFailureDiagnostic(value, {
    runId,
    workItemId: workItem.id,
    promptSha256: workItem.prompt.sha256,
  });
  if (resultIdentityFailure !== null) {
    return invalidResult(
      "identity_binding",
      `result must match the exact current contract, run, work-item, and prompt binding: ${resultIdentityFailure}`,
    );
  }

  if (!isCommit(value.landed_commit)) {
    return invalidResult(
      "landed_commit",
      "landed_commit must be the full id of the commit that carries this item's edits",
    );
  }

  // The evidence-coverage floor: the cited obligation set must equal the
  // work item's tool-owned binding exactly. Shape and coverage only — judging
  // whether a citation SUFFICES is the per-run conformance review's job.
  const obligationEvidence = value.obligation_evidence;
  if (!Array.isArray(obligationEvidence)) {
    return invalidResult(
      "obligation_evidence",
      "obligation_evidence must be an array with one entry per bound obligation",
    );
  }
  const citedIds: string[] = [];
  for (const [index, entry] of obligationEvidence.entries()) {
    const citations = isRecord(entry) ? stringArray(entry.evidence) : null;
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["evidence", "obligation_id"]) ||
      typeof entry.obligation_id !== "string" ||
      entry.obligation_id.trim().length === 0 ||
      !citations ||
      citations.length === 0 ||
      citations.some((citation) => citation.trim().length === 0)
    ) {
      const named =
        isRecord(entry) && typeof entry.obligation_id === "string"
          ? ` (obligation_id: ${entry.obligation_id})`
          : "";
      return invalidResult(
        "obligation_evidence",
        `obligation_evidence[${index}] must cite at least one non-empty evidence string for a named obligation${named}`,
      );
    }
    citedIds.push(entry.obligation_id);
  }
  const cited = new Set(citedIds);
  if (citedIds.length !== cited.size) {
    const duplicates = [
      ...new Set(citedIds.filter((id, i) => citedIds.indexOf(id) !== i)),
    ];
    return invalidResult(
      "obligation_evidence",
      `obligation_evidence cites an obligation more than once: ${duplicates.join(", ")}`,
    );
  }
  const uncovered = workItem.obligation_ids.filter((id) => !cited.has(id));
  if (uncovered.length > 0) {
    return invalidResult(
      "obligation_evidence",
      `obligation_evidence must cover every prompt-bound obligation; uncovered: ${uncovered.join(", ")}`,
    );
  }
  const unknown = citedIds.filter(
    (id) => !workItem.obligation_ids.includes(id),
  );
  if (unknown.length > 0) {
    return invalidResult(
      "obligation_evidence",
      `obligation_evidence cites obligations the work item does not bind: ${unknown.join(", ")}`,
    );
  }

  return {
    ok: true,
    kind: "landed",
    result: value as unknown as RemediationHostResult,
  };
}

export {
  REQUIRED_TEST_MESSAGE_LIMIT,
  runRequiredTest,
} from "./requiredTests.js";
export type {
  RemediationRequiredTestVerdicts,
  RequiredTestFailure,
} from "./requiredTests.js";
export {
  workloadBindingIdentity,
} from "./recovery.js";

/**
 * Was this persisted workload written under an earlier workload contract
 * version? Only a document that NAMES a different version counts: a document
 * with no version, or not an object at all, is invalid, not stale.
 */
function persistedWorkloadIsStale(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.contract_version === "string" &&
    value.contract_version !== WORKLOAD_CONTRACT_VERSION
  );
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
  if (!existingRecord && (await isGitRepo(paths.root))) {
    const currentHead = await headCommit(paths.root);
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
    throw new CannotPrepareWorkloadError(cannotPrepareMessage(paths.root, state, error));
  }
  if (workload.work_items.length === 0) {
    // Name the producer defect when it is the cause. An empty level 0 that is
    // really "every candidate block declares a prerequisite that does not
    // exist" used to surface as a bare "empty workload", sending the operator
    // to look at scheduling rather than at the plan.
    const blocked = planBlockIssues(paths.root, state);
    throw new CannotPrepareWorkloadError(
      blocked.length === 0
        ? "Cannot prepare an empty remediation host workload"
        : `Cannot prepare a remediation host workload: ${blocked
            .map((issue) => issue.message)
            .join("; ")}`,
    );
  }
  const workloadDigest = contentSha256(workload);
  // The binding pins whatever the CURRENT state re-derives, and that
  // re-derivation moves for exactly two reasons, both re-binds rather than
  // refusals:
  //   - the persisted workload file was written under an earlier contract
  //     version (a version bump changed the work item's shape or prompt), and
  //   - the plan changed under a live binding (a clarification answer baked
  //     retry context into the prompt, a scope widened) — the "state moved under
  //     the binding" 2026-08-20 wedge that used to throw a raw "no longer
  //     matches" with no sanctionable repair short of hand-deleting the record.
  // The workload is by construction re-derived from the authoritative state, so
  // a moved digest is the binding honestly describing that new state — re-mint
  // the record at the current digest. What would still be a refusal is guarded
  // elsewhere: a foreign run (the run-id check above) and a missing/reordered
  // block (the canonical-build throw). So no digest move is itself a refusal.
  const handoffRecord: RemediationHostHandoffRecord = existingRecord
    ? { ...existingRecord, workload_sha256: workloadDigest }
    : {
      contract_version: REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2,
      scope_semantics: REMEDIATION_HOST_SCOPE_SEMANTICS,
      run_id: params.runId,
      baseline_commit: baselineCommit,
      workload_sha256: workloadDigest,
      work_item_ids: workload.work_items.map((item) => item.id),
    };

  await mkdir(paths.resultDir, { recursive: true });
  await recordIgnoredRootLogsPreInventory(paths);
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
 * from HEAD; its mechanically derived changed files lie within the
 * prompt-bound `allowed_files`; no overlap
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
// sites-pinned: tests/remediate/conformance-review.test.ts, tests/remediate/host-handoff-corroboration.test.ts
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

  // The verdict table is the ONE input whose validity the type system cannot
  // check: a hand-built map of all-green verdicts asserts tests ran that never
  // did. Refuse it up front — before any ledger append, any git probe, and any
  // acceptance — rather than letting the per-item loop read a fabricated table
  // as evidence. See MintedRequiredTestVerdicts.
  if (
    params.recovery !== undefined &&
    !isMintedVerdictTable(params.recovery.requiredTestVerdicts)
  ) {
    throw new Error(
      "recovery.requiredTestVerdicts must come from precomputeRecoveryTestVerdicts: " +
        "a caller-supplied verdict table asserts required tests ran that no runner produced",
    );
  }

  const paths = resolveBoundaryPaths(params);
  const nextState = structuredClone(state);
  // v1alpha2 state is the sole authority. A legacy sidecar is evidence of an
  // opted-in v1alpha1 run that cannot be downgraded to the legacy default-off
  // path; direct boundary callers get the same refusal as StateStore readers.
  const selection = state.conformance_review_policy === undefined
    ? await readLegacyConformanceReviewSelection(params)
    : { kind: "off" as const, path: "" };
  if (selection.kind !== "off") {
    const issues = await recordAndEnrichHostIssues(
      params.artifactsDir,
      params.runId,
      [{
        code: "conformance_review",
        check: "conformance_review",
        message:
          `legacy conformance-review selection at ${selection.path} has no primary ` +
          "state policy; start from the original input in a fresh artifacts directory " +
          "(next-step --input <source> --artifacts-dir <new-directory> --conformance-review) " +
          "and preserve these artifacts before accepting results",
      }],
      [],
    );
    const ignored_root_logs = await readNewlyCreatedIgnoredRootLogs(paths);
    return {
      accepted_count: 0,
      completed_work_item_ids: [],
      pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
      issues,
      work_item_outcomes: new Map(),
      state_changed: false,
      state: nextState,
      ignored_root_logs,
    };
  }
  const policy = state.conformance_review_policy;
  if (policy && !policy.first_dispatch_recorded) {
    // Before the first emitted dispatch, no host result can be accepted. The
    // caller will prepare the handoff and persist the marker before emission.
    return {
      accepted_count: 0,
      completed_work_item_ids: [],
      pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
      issues: [],
      work_item_outcomes: new Map(),
      state_changed: false,
      state: nextState,
      ignored_root_logs: await readNewlyCreatedIgnoredRootLogs(paths),
    };
  }
  const validated = await validateHostResultBundle({
    state,
    nextState,
    paths,
    runId: params.runId,
    recovery: params.recovery,
    conformanceReview: policy?.choice === "on",
  });
  if (validated.kind === "summary") {
    const issues = await recordAndEnrichHostIssues(
      params.artifactsDir,
      params.runId,
      validated.summary.issues,
      validated.summary.completed_work_item_ids,
    );
    const ignored_root_logs = await readNewlyCreatedIgnoredRootLogs(paths);
    return { ...validated.summary, issues, ignored_root_logs };
  }

  const acc: HostIngestAccumulators = {
    issues: validated.issues,
    completed: [],
    workItemOutcomes: new Map(),
    resultIds: new Set<string>(),
    landedFiles: new Set(nextState.applied_edit_surface ?? []),
    settledFindingIds: new Set<string>(),
    recordedRecoveryMarks: null,
  };
  const verdicts = await executeHostVerificationReruns(validated.ctx, acc);
  const issues = await recordAndEnrichHostIssues(
    params.artifactsDir,
    params.runId,
    acc.issues,
    acc.completed,
  );
  const summary = commitRemediationStateUpdates(validated.ctx, acc, verdicts, issues);
  const ignored_root_logs = await readNewlyCreatedIgnoredRootLogs(paths);
  return { ...summary, ignored_root_logs };
}

/** Record raw observations first, then decorate only the returned diagnostics. */
async function recordAndEnrichHostIssues(
  artifactsDir: string,
  runId: string,
  issues: readonly RemediationHostIngestIssue[],
  acceptedIds: readonly string[],
): Promise<RemediationHostIngestIssue[]> {
  const refusals = await readTrailingSubmissionRefusals(
    artifactsDir,
    issues
      .map((issue) => issue.work_item_id ?? issue.submission_id)
      .filter((id): id is string => id !== undefined),
    { runId },
  );
  await recordHostResultOutcomes(
    artifactsDir,
    runId,
    {
      // This refusal already reports that the ledger write failed. Retrying
      // that same item would replace its diagnostic with an ingest exception;
      // other items retain normal recording and error propagation.
      issues: issues.filter((issue) => issue.code !== "recovery_unrecorded"),
      acceptedIds,
    },
    { scopeToRunId: runId },
  );
  return enrichMissingSubmissionIssues(
    issues,
    refusals,
    "submission_rejected",
  );
}

/**
 * The read-mostly inputs the three ingest phases share.
 *
 * `nextState` is the sole mutable member, and only
 * {@link commitRemediationStateUpdates} writes to it — the verification phase
 * READS it (the pending filter) and writes nothing. `paths` is carried whole
 * rather than re-flattened to `root`/`artifactsDir`, because
 * {@link resolveBoundaryPaths} RESOLVES those values and they need not equal
 * the caller's arguments; the validate phase also needs `workloadPath`.
 */
interface HostIngestContext {
  readonly paths: BoundaryPaths;
  readonly runId: string;
  /** `params.recovery !== undefined` — the bare boolean corroboration takes. */
  readonly recovery: boolean;
  /** Parsed, never mutated. Corroboration is checked against THIS, not the clone. */
  readonly state: CurrentRemediationHostState;
  readonly nextState: CurrentRemediationHostState;
  readonly effectiveWorkload: RemediationHostWorkload;
  readonly eligibleIds: ReadonlySet<string>;
  readonly canCorroborate: boolean;
  readonly requiredTestVerdicts: RemediationRequiredTestVerdicts | null;
  /** Whether the opt-in per-result conformance review is enabled this run. */
  readonly conformanceReview: boolean;
}

/**
 * One accepted item, carrying everything the state commit needs.
 *
 * `pendingItems` and `at` ride on the verdict rather than being recomputed in
 * the commit phase, and that is load-bearing rather than convenience. Both are
 * observations of a moment INSIDE the loop: `pendingItems` is the finding set
 * that was still pending when this item was verified, and `at` is the instant
 * this item finished — which the loop interleaves with git probes and test
 * reruns that take real wall-clock time. Recomputing either during the commit
 * would change what the ingest writes for the same input.
 *
 * A refusal produces NO verdict; it pushes a classified issue and continues, so
 * the fail-closed shape stays structural rather than encoded in a verdict kind.
 */
type HostItemVerdict =
  | {
      readonly kind: "decision";
      readonly workItem: RemediationHostWorkItem;
      readonly pendingItems: readonly string[];
      readonly at: string;
      readonly outcome: RemediationHostDecision["outcome"];
    }
  | {
      readonly kind: "landed";
      readonly workItem: RemediationHostWorkItem;
      readonly pendingItems: readonly string[];
      readonly at: string;
      /**
       * The CORROBORATED landing — read from the result only after
       * `corroborateHostResult` verified the commit resolves, is reachable from
       * HEAD, and that its mechanically derived diff (`changedFiles`) lies
       * within the item's write scope. Persisted onto each
       * settled item (see `RemediationItemState.host_landed_commit`), which
       * `hasLandedCommitFor` reads back below to separate partial progress
       * from unfinished work.
       */
      readonly landedCommit: string;
      readonly changedFiles: readonly string[];
    };

/**
 * What the verification phase accumulates across items. None of it is
 * persisted state: the ingest returns a summary and a clone, and the caller
 * decides what to save.
 *
 * `landedFiles` is a VERIFICATION-phase accumulator with intra-loop feedback,
 * not a commit-phase one: it is seeded from `applied_edit_surface`, READ by a
 * no-change claim's excuse set, and WRITTEN by an accepted landing — so a
 * sibling item's legitimately landed files do not falsify a later item's claim.
 * Deferring it to the commit phase silently starts refusing honest no-change
 * items (pinned by "excuses a SIBLING's landing accepted earlier in the SAME
 * INGEST" in tests/remediate/host-handoff-corroboration.test.ts).
 */
interface HostIngestAccumulators {
  readonly issues: RemediationHostIngestIssue[];
  readonly completed: string[];
  /**
   * Per-item OBSERVED outcome, written where the item's bound path is read and
   * carried onto the summary. A work item is recorded `rejected` when an issue
   * names it, `missing_result_with_commit` when nothing is at its path but the
   * run holds a corroborated commit for one of its findings, and
   * `awaiting_result` otherwise — so "the host has not written this yet" and
   * "the host wrote it and we refused it" never share a shape.
   */
  readonly workItemOutcomes: Map<string, WorkItemOutcome>;
  readonly resultIds: Set<string>;
  readonly landedFiles: Set<string>;
  /**
   * Findings an accepted verdict has already settled THIS ingest.
   *
   * The pending filter used to read the settlement off `nextState` directly,
   * because the loop mutated as it went. With mutation deferred to the commit
   * phase it would instead read the pre-loop clone, so two work items sharing a
   * finding id would both claim it. This set restores exactly what the filter
   * used to observe.
   */
  readonly settledFindingIds: Set<string>;
  recordedRecoveryMarks: SubmissionLedgerEvent[] | null;
}

/**
 * Phase 1 — the whole-bundle gates, up to the schedulable frontier.
 *
 * Returns either a populated context or ONE OF THREE finished summaries. The
 * three do not agree on `pending_work_item_ids` — the read failure and the
 * canonical parse failure return the binding's own item ids, the trusted-binding
 * refusal returns the empty list — so folding any two together is a silent
 * behavior change. Each is pinned by a test that asserts the pending list, not
 * just the code.
 */
async function validateHostResultBundle(input: {
  readonly state: CurrentRemediationHostState;
  readonly nextState: CurrentRemediationHostState;
  readonly paths: BoundaryPaths;
  readonly runId: string;
  readonly conformanceReview: boolean;
  readonly recovery?: {
    readonly requiredTestVerdicts: RemediationRequiredTestVerdicts;
  };
}): Promise<
  | { readonly kind: "summary"; readonly summary: RemediationHostIngestSummary }
  | {
      readonly kind: "context";
      readonly ctx: HostIngestContext;
      readonly issues: RemediationHostIngestIssue[];
    }
> {
  const { state, nextState, paths } = input;
  const issues: RemediationHostIngestIssue[] = [];
  const workloadRead = await readSubmissionDocument(paths.workloadPath);
  if (workloadRead.kind !== "value") {
    if (state.host_handoff) {
      issues.push({
        code:
          workloadRead.kind === "missing"
            ? "workload_missing"
            : "workload_invalid",
        check: "workload_binding",
        message:
          workloadRead.kind === "missing"
            ? "the persisted trusted handoff has no workload file"
            : `the workload file is not valid JSON: ${workloadRead.detail}`,
      });
    }
    return {
      kind: "summary",
      summary: {
        accepted_count: 0,
        completed_work_item_ids: [],
        pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
        issues,
        work_item_outcomes: new Map(),
        state_changed: false,
        state: nextState,
      },
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

  if ((await isGitRepo(paths.root)) && !state.host_handoff) {
    issues.push({
      code: "trusted_binding_missing",
      check: "workload_binding",
      message:
        "a git-backed remediation workload requires the tool-owned host_handoff state binding",
    });
    return {
      kind: "summary",
      summary: {
        accepted_count: 0,
        completed_work_item_ids: [],
        pending_work_item_ids: [],
        issues,
        work_item_outcomes: new Map(),
        state_changed: false,
        state: nextState,
      },
    };
  }

  // A workload an EARLIER contract version wrote is not a defect in it: the
  // tool changed underneath a live binding. It is reported as stale — no host
  // action — and `prepareRemediationHostHandoff` re-mints the digest and
  // rewrites the file on the same step, under the same work item ids.
  if (state.host_handoff && persistedWorkloadIsStale(workloadRead.value)) {
    issues.push({
      code: "workload_stale",
      check: "workload_binding",
      message:
        "the workload file was written under an earlier contract version; the tool writes it again",
    });
    return {
      kind: "summary",
      summary: {
        accepted_count: 0,
        completed_work_item_ids: [],
        pending_work_item_ids: state.host_handoff.work_item_ids,
        issues,
        work_item_outcomes: new Map(),
        state_changed: false,
        state: nextState,
      },
    };
  }

  const workload = parseWorkload(workloadRead.value, paths, input.runId, state);
  if (!workload) {
    // Accumulated, not replaced: when a block-contract defect is WHY the
    // canonical re-derivation failed, the block-attributed issue is the only
    // thing that names the cause.
    issues.push({
      code: "workload_invalid",
      check: "workload_binding",
      message:
        "the workload does not match its canonical state shape and persisted digest binding",
    });
    return {
      kind: "summary",
      summary: {
        accepted_count: 0,
        completed_work_item_ids: [],
        pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
        issues,
        work_item_outcomes: new Map(),
        state_changed: false,
        state: nextState,
      },
    };
  }

  return {
    kind: "context",
    issues,
    ctx: {
      paths,
      runId: input.runId,
      recovery: input.recovery !== undefined,
      state,
      nextState,
      effectiveWorkload: effectiveBoundWorkload(state, workload),
      eligibleIds: new Set(
        (hostDependencyLevels(state)[0] ?? []).map((block) => block.block_id),
      ),
      // Can this ingest be corroborated against ground truth AT ALL? A git root
      // supplies the tree; a persisted `host_handoff` supplies the trusted
      // binding. With NEITHER there is nothing to check a host's claim against,
      // and the remaining evidence is the host's own attestation — which is
      // exactly the claim under test. That branch is REFUSED for both result
      // and decision documents rather than admitted on the attestation alone.
      canCorroborate:
        state.host_handoff !== undefined || (await isGitRepo(paths.root)),
      // Recovery-only answer table; the normal lane gets null and spawns
      // exactly as it always has. See RemediationRequiredTestVerdicts.
      requiredTestVerdicts: input.recovery?.requiredTestVerdicts ?? null,
      conformanceReview: input.conformanceReview,
    },
  };
}

/**
 * Phase 2 — per-item verification. Writes NOTHING to `ctx.nextState`.
 *
 * Iterates the effective workload in order and emits one verdict per ACCEPTED
 * item; a refusal pushes its classified issue and continues. The ledger mark
 * for a recovery acceptance still goes down before that item's verdict is
 * emitted, so no acceptance can outrun its record.
 */
/**
 * Did a corroborated commit already land for this work item, even though no
 * result file is at its bound path?
 *
 * Ground truth, not a claim: `host_landed_commit` is written only after
 * `corroborateHostResult` verified the commit resolves, is reachable from HEAD,
 * and that its mechanically derived diff lies within the item's write scope.
 * Anything less is not a landing.
 *
 * ANY finding of the item counts, because the commit is attributed per FINDING
 * and a work item is a bundle of them: a commit for one of its findings is work
 * this item did, which is exactly what the host needs to know before rewriting
 * the result from scratch.
 */
function hasLandedCommitFor(
  state: CurrentRemediationHostState,
  workItem: RemediationHostWorkItem,
): boolean {
  return workItem.finding_ids.some(
    (findingId) => typeof state.items[findingId]?.host_landed_commit === "string",
  );
}

async function executeHostVerificationReruns(
  ctx: HostIngestContext,
  acc: HostIngestAccumulators,
): Promise<readonly HostItemVerdict[]> {
  const { paths, nextState, state } = ctx;
  const verdicts: HostItemVerdict[] = [];
  for (const workItem of ctx.effectiveWorkload.work_items) {
    const pendingItems = workItem.finding_ids.filter(
      (findingId) =>
        nextState.items[findingId]?.status === "pending" &&
        !acc.settledFindingIds.has(findingId),
    );
    if (pendingItems.length === 0) continue;
    if (!ctx.eligibleIds.has(workItem.id)) {
      acc.issues.push({
        code: "work_item_not_eligible",
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
        const result = parseResult(value, ctx.runId, workItem);
        return result.ok
          ? { ok: true, parsed: result }
          : { ok: false, check: result.check, detail: result.reason };
      },
      resultId: (result) => result.result.result_id,
      seen: (resultId) => acc.resultIds.has(resultId),
      messages: remediationScanMessages,
    });
    if (!scan.ok) {
      acc.issues.push(scan.issue);
      // A refusal is a REFUSAL — unless the refusal is "nothing is there", in
      // which case it says nothing about whether the host did the work. The run
      // holds a CORROBORATED commit for a settled item (see
      // `RemediationItemState.host_landed_commit`), and an item whose edits
      // landed but whose result is missing is PARTIAL PROGRESS the host must be
      // told about; it used to disappear as a bare missing-result line.
      // THREE-WAY, not two. "Nothing is at the bound path" is an OBSERVATION,
      // and it splits again on whether the run holds a corroborated commit for
      // this item: with one it is partial progress, without one it is simply
      // unfinished work. Only a REFUSAL of something that WAS written is
      // `rejected`. Collapsing the missing half into `rejected` would restore
      // exactly the conflation this split exists to end.
      acc.workItemOutcomes.set(
        workItem.id,
        !isMissingObservation(scan.issue)
          ? "rejected"
          : hasLandedCommitFor(nextState, workItem)
            ? "missing_result_with_commit"
            : "awaiting_result",
      );
      continue;
    }
    const parsed = scan.parsed;
    const resultId = parsed.result.result_id;

    acc.resultIds.add(resultId);
    if (parsed.kind === "decision") {
      const result = parsed.result;
      const outcome = result.outcome;
      if (outcome.status === "resolved_no_change") {
        if (!ctx.canCorroborate) {
          acc.issues.push({
            code: "trusted_binding_missing",
            check: "no_change_corroboration",
            work_item_id: workItem.id,
            result_path: workItem.result_path,
            message:
              "resolved_no_change needs a git root or a persisted host_handoff binding to corroborate the write scope against; attestation-only acceptance is refused",
          });
          continue;
        }
        const noChange = await corroborateNoChangeClaim({
          root: paths.root,
          workItem,
          // Ground truth only: pre-existing dirt plus the edit surface this run
          // has already corroborated and accepted (`landedFiles` starts from
          // `applied_edit_surface` and grows as this same ingest accepts).
          excusedPaths: new Set([
            ...(state.run_start_dirty ?? []).map(normalizeRepoPath),
            ...[...acc.landedFiles].map(normalizeRepoPath),
          ]),
        });
        if (!noChange.ok) {
          acc.issues.push({
            code: noChange.code,
            check: noChange.check,
            work_item_id: workItem.id,
            result_path: workItem.result_path,
            message: noChange.message,
          });
          continue;
        }
        const failedTests = await rerunRequiredTests(
          paths.root,
          workItem.required_tests,
          ctx.requiredTestVerdicts,
        );
        if (failedTests.length > 0) {
          acc.issues.push(requiredTestIssue(workItem, failedTests));
          continue;
        }
      }
      for (const findingId of pendingItems) acc.settledFindingIds.add(findingId);
      verdicts.push({
        kind: "decision",
        workItem,
        pendingItems,
        at: new Date().toISOString(),
        outcome,
      });
      acc.completed.push(workItem.id);
      continue;
    }

    const result = parsed.result;
    if (!ctx.canCorroborate) {
      acc.issues.push({
        code: "trusted_binding_missing",
        check: "workload_binding",
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
      verdicts: ctx.requiredTestVerdicts,
      recovery: ctx.recovery,
    });
    if (!corroborated.ok) {
      acc.issues.push({
        code: corroborated.code,
        check: corroborated.check,
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
        acc.recordedRecoveryMarks ??= (
          await readSubmissionLedger(paths.artifactsDir)
        ).filter((event) => event.kind === "accepted_via_recovery");
        // The mark's identity is (run, item, LANDED COMMIT), not just
        // (run, item): an item re-opened and later re-accepted from a
        // DIFFERENT landing is a different relaxed acceptance and earns its
        // own record. Only a retry of the SAME landing is a duplicate. The
        // landed commit is carried on the event as `landed_commit` and read
        // back through `recoveryMarkMatches` — prose is not an identity, and a
        // message reworded by any later edit silently un-deduped the mark.
        const landedCommit = result.landed_commit;
        const alreadyMarked = acc.recordedRecoveryMarks.some(
          (event) =>
            event.run_id === ctx.runId &&
            recoveryMarkMatches(event, workItem.id, landedCommit),
        );
        if (!alreadyMarked) {
          const event: SubmissionLedgerEvent = {
            contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
            run_id: ctx.runId,
            submission_id: workItem.id,
            lane: workItem.id,
            kind: "accepted_via_recovery",
            // The structured half of this event's identity, beside the prose
            // that narrates it. `recoveryMarkMatches` reads THIS, never the
            // message below.
            landed_commit: landedCommit,
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
          acc.recordedRecoveryMarks.push(event);
        }
      } catch (error) {
        acc.issues.push({
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
    if (ctx.conformanceReview && workItem.obligation_ids.length > 0) {
      // The opt-in sufficiency half (O39). MECHANICAL coverage was already
      // enforced by `parseResult` — the reviewer neither reopens nor relaxes it.
      // Here the result is HELD, not accepted: a bound independent review of the
      // cited evidence against the carried contracts must pass first. A non-
      // passing verdict (insufficient / unavailable / stale / refused / absent)
      // is a classified `conformance_review` issue, never a mechanical refusal,
      // and files nothing — the item stays pending and the same result is
      // re-reviewed on the next ingest once the host has acted.
      const reviewRequest = mintConformanceReview({
        resultId: result.result_id,
        workItemId: workItem.id,
        obligationIds: workItem.obligation_ids,
        moduleContracts: moduleContractsFor(state, workItem),
        obligationEvidence: result.obligation_evidence,
      });
      // PERSIST the request before reading the verdict: a first ingest on an
      // opted-in run writes the request the host reviews; a later ingest reads
      // the verdict the host wrote against it.
      await writeJsonFile(
        conformanceReviewRequestPath(paths, workItem.id),
        reviewRequest,
      );
      const verdictOutcome = await readConformanceVerdict(paths, workItem.id, reviewRequest);
      if (verdictOutcome.kind !== "pass") {
        acc.issues.push({
          code: "conformance_review",
          check: "conformance_review",
          work_item_id: workItem.id,
          result_path: workItem.result_path,
          message: conformanceIssueMessage(verdictOutcome, workItem.id),
        });
        continue;
      }
    }
    for (const findingId of pendingItems) acc.settledFindingIds.add(findingId);
    verdicts.push({
      kind: "landed",
      workItem,
      pendingItems,
      at: new Date().toISOString(),
      landedCommit: result.landed_commit,
      changedFiles: corroborated.changedFiles,
    });
    for (const changedFile of corroborated.changedFiles) {
      acc.landedFiles.add(changedFile);
    }
    acc.completed.push(workItem.id);
  }
  return verdicts;
}

/**
 * Phase 3 — apply the accepted verdicts to the clone and assemble the summary.
 *
 * Infallible given the verdicts: every refusal was already classified in
 * phase 2, so nothing here can reject. Verdicts apply in workload order, which
 * is the order they were emitted, so a finding two items share is written the
 * same way it was before the phases were separated.
 */
function commitRemediationStateUpdates(
  ctx: HostIngestContext,
  acc: HostIngestAccumulators,
  verdicts: readonly HostItemVerdict[],
  issues: readonly RemediationHostIngestIssue[],
): RemediationHostIngestSummary {
  const { nextState } = ctx;
  for (const verdict of verdicts) {
    if (verdict.kind === "decision") {
      const outcome = verdict.outcome;
      for (const findingId of verdict.pendingItems) {
        const item = nextState.items[findingId]!;
        item.started_at ??= verdict.at;
        if (outcome.status === "resolved_no_change") {
          item.status = "resolved_no_change";
          item.completed_at = verdict.at;
          item.host_result_evidence = [...outcome.evidence];
          delete item.failure_reason;
        } else if (outcome.status === "blocked") {
          item.status = "blocked";
          item.completed_at = verdict.at;
          item.failure_reason = outcome.failure_reason;
        } else {
          item.status = "needs_clarification";
          delete item.completed_at;
          item.failure_reason = outcome.question;
          // The question lives on the item (its one home): the clarification
          // round lists every paused item, so no answer can erase another's.
          item.clarification_question = {
            category: isClarificationCategory(outcome.category)
              ? outcome.category
              : "scope_of_fix",
            description: outcome.question,
          };
        }
      }
      continue;
    }
    for (const findingId of verdict.pendingItems) {
      const item = nextState.items[findingId]!;
      item.status = "resolved";
      item.started_at ??= verdict.at;
      item.completed_at = verdict.at;
      // The corroborated outcome is PERSISTED per item, not just folded into the
      // run-wide `applied_edit_surface`, so the attribution survives the process
      // that observed it — and read back by `hasLandedCommitFor` on the next
      // ingest, which is how an item whose edits landed but whose result file
      // never arrived is told apart from one that was never attempted.
      item.host_landed_commit = verdict.landedCommit;
      item.host_landed_files = [...verdict.changedFiles];
      delete item.failure_reason;
      delete item.host_result_evidence;
    }
  }

  if (acc.completed.length > 0) {
    nextState.applied_edit_surface = [...acc.landedFiles].sort(compareCodeUnits);
  }

  const pendingWorkItemIds = ctx.effectiveWorkload.work_items
    .filter((workItem) =>
      workItem.finding_ids.some(
        (findingId) => nextState.items[findingId]?.status === "pending",
      ),
    )
    .map((workItem) => workItem.id);
  let stateChanged = acc.completed.length > 0;
  if (nextState.host_handoff && pendingWorkItemIds.length === 0) {
    migrateLegacyDirectoryScopesAfterFinalDrain(nextState);
    delete nextState.host_handoff;
    stateChanged = true;
  }

  // Every remaining work item is `awaiting_result` unless the verify loop
  // already classified it: an item the loop never reached (a sibling's refusal
  // ended the pass early) is still genuinely unread, and "not read" is the
  // honest answer there — never a claim that something was refused.
  const workItemOutcomes = new Map<string, WorkItemOutcome>();
  for (const workItem of ctx.effectiveWorkload.work_items) {
    workItemOutcomes.set(
      workItem.id,
      acc.workItemOutcomes.get(workItem.id) ?? "awaiting_result",
    );
  }

  return {
    accepted_count: acc.completed.length,
    completed_work_item_ids: acc.completed,
    pending_work_item_ids: pendingWorkItemIds,
    issues,
    work_item_outcomes: workItemOutcomes,
    state_changed: stateChanged,
    state: nextState,
  };
}
