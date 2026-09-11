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
  enrichMissingSubmissionIssues,
  compareCodeUnits,
  contentSha256,
  deriveLaneDemand,
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
  parseCommandString,
  parseWorkloadEnvelope,
  promptSha256,
  readSubmissionDocument,
  readSubmissionLedger,
  readTrailingSubmissionRefusals,
  recoveryMarkMatches,
  recordHostResultOutcomes,
  repoRelativePath,
  resolveContainedPath,
  resolveHostHandoffPaths,
  runTrackedAsync,
  sameStrings,
  scanBoundSubmission,
  SEVERITIES,
  severityRank,
  stringArray,
  stableStringify,
  TRACKED_CHILD_DEADLINE_MS,
  writeJsonFile,
  type FindingSeverity,
  type HostHandoffPaths,
  type IngestionCheckId,
  type LaneDemand,
  type SubmissionIssue,
  type SubmissionLedgerEvent,
  type SubmissionScanMessages,
} from "audit-tools/shared";
import {
  REMEDIATION_STATE_CONTRACT_VERSION,
  StateStore,
  type RemediationState,
} from "../../state/store.js";
import {
  REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA1,
  REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2,
  REMEDIATION_HOST_SCOPE_SEMANTICS,
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

// The state contract version is the STORE's declaration, not a second literal
// here. It used to be private to this module — and the module then supplied it
// to its own parser at the call site below, so the check it performed was
// "does the constant equal itself".
const STATE_CONTRACT_VERSION = REMEDIATION_STATE_CONTRACT_VERSION;

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

/**
 * The remediate draw's boundary paths are the CORE's, whole.
 *
 * This used to be a four-field local shape that dropped `runDir` — leaving
 * {@link resultPathFor} no choice but to RE-DERIVE it by slicing the literal
 * `host-workload.json` filename off `workloadPath`. A core-side rename of that
 * filename would have silently produced a wrong-but-plausible run directory on
 * this draw only. The core already returns the run directory it resolved, so
 * the draw carries it rather than reconstructing it.
 */
type BoundaryPaths = HostHandoffPaths;

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
  // The corroborated landing this ingest itself writes on an accepted item (see
  // RemediationItemState.host_landed_commit). Listed because this gate is an
  // ALLOWLIST: without them the first ingest persists them and the very next
  // one refuses the whole state as a retired shape it cannot parse.
  "host_landed_commit",
  "host_landed_files",
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
  const normalized = repoRelativePath(root, candidate, label);
  return candidate.endsWith("/") ? `${normalized}/` : normalized;
}

function pathIsAllowedByWriteScope(
  root: string,
  candidate: string,
  allowedFiles: readonly string[],
): boolean {
  let normalized: string;
  try {
    normalized = repoRelativePath(root, candidate, "changed_files[]");
  } catch {
    return false;
  }
  if (normalized !== candidate) return false;
  return allowedFiles.some((allowed) =>
    allowed.endsWith("/")
      ? normalized.startsWith(allowed)
      : normalized === allowed,
  );
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

function resolveBoundaryPaths(
  params: Parameters<typeof resolveHostHandoffPaths>[0],
): BoundaryPaths {
  // The remediate draw's run dir carries the `implement` lane segment — its
  // runs directory also holds triage/closing lanes — which the core takes as a
  // parameter rather than a fork. The core's whole result is returned: the draw
  // adds no fields and re-derives none of the core's.
  return resolveHostHandoffPaths({
    ...params,
    runDirSegments: ["implement"],
    runIdLabel: "remediation host run id",
  });
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
  // Legacy directory recovery is privileged by the tool-owned state binding,
  // not by prompt text or current filesystem shape. Exact-scope validation
  // remains available when state is absent; only canonical bound state can
  // widen the in-memory view.
  let validationWorkItem = workItem;
  try {
    const storedState = await new StateStore(paths.artifactsDir).loadState();
    // No version is supplied here. The store reads the state from disk and
    // stamps the contract version it just VALIDATED, so `parseCurrentState`
    // tests the value that was in the file. It used to be handed
    // `STATE_CONTRACT_VERSION` from this line, which made the parser's version
    // check compare a constant to itself and accept any state the store was
    // willing to return.
    const state = storedState ? parseCurrentState(storedState) : null;
    const canonicalWorkload = state
      ? parseWorkload(read.value, paths, params.runId, state)
      : null;
    const canonicalWorkItem = canonicalWorkload?.work_items.find(
      (item) => item.id === params.workItemId,
    );
    if (state?.host_handoff && canonicalWorkItem) {
      validationWorkItem = deriveLegacyDirectoryScopeRecovery(
        state,
        canonicalWorkItem,
      ).workItem;
    }
  } catch {
    // Invalid/missing state cannot authorize widening. The raw workload's
    // exact scope remains the fail-closed validator for this recovery write.
  }
  return {
    submissionDir: paths.resultDir,
    validate: (value: unknown): SubmissionIssue | null => {
      const parsed = parseResult(
        value,
        params.runId,
        validationWorkItem,
        paths.root,
      );
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
  return [
    "Implement the bounded remediation work item below.",
    "The host owns execution choices. For every assignment, apply the finding and item instructions exactly, including any clarified scope or retry context.",
    "Keep every edit within allowed_files, run every required test, land one attributable commit whose changed-file set is exact, and write one JSON result at result_path.",
    'An allowed_files entry ending in "/" authorizes normalized descendant files; every other entry authorizes only that exact file.',
    ...(item.moduleContracts.length > 0
      ? [
          "module_contracts carries the APPROVED contract for each module this item implements. The implementation MUST conform to every declared input, output, invariant, side effect, validation boundary, failure mode, and seam adjustment. A locally plausible interface that contradicts them is a defect even when the build and the targeted tests pass — a conformance divergence propagates to every consumer of the module.",
        ]
      : []),
    `Assignment: ${assignment}`,
    `The result must use ${RESULT_CONTRACT_VERSION} and contain exactly contract_version, result_id, run_id, work_item_id, prompt_sha256, changed_files, commit_evidence, test_evidence, obligation_evidence, worktree_evidence, acceptance, and merge.`,
    item.obligationIds.length > 0
      ? `obligation_evidence must contain exactly one entry per bound obligation id — ${item.obligationIds.join(", ")} — each an object {obligation_id, evidence} whose evidence array cites at least one non-empty string (file, symbol, or test) showing the landed implementation satisfies that obligation. Ingestion refuses the result when any bound obligation is uncovered.`
      : "obligation_evidence must be an empty array — this item binds no contract obligations.",
    "Bind commit_evidence.before and worktree_evidence.baseline_commit to baseline_commit; report only passed required tests; acceptance.status must be accepted and merge.status must be merged.",
    `If no edit should land, write ${DECISION_CONTRACT_VERSION} instead with exactly contract_version, result_id, run_id, work_item_id, prompt_sha256, outcome. outcome must be one of: {status: resolved_no_change, evidence: [non-empty strings]}, {status: blocked, failure_reason: non-empty string}, or {status: needs_clarification, question: non-empty string, optional category}.`,
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
  const promptText = buildPrompt({
    blockId: block.block_id,
    findingIds: block.items,
    assignments,
    allowedFiles,
    baselineCommit,
    obligationIds,
    requiredTests,
    resultPath,
    moduleContracts: block.module_contracts ?? [],
  });
  return {
    id: block.block_id,
    finding_ids: [...block.items],
    allowed_files: allowedFiles,
    baseline_commit: baselineCommit,
    obligation_ids: obligationIds,
    prompt: { text: promptText, sha256: promptSha256(promptText) },
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
  root: string,
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

  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "acceptance",
      "changed_files",
      "commit_evidence",
      "contract_version",
      "merge",
      "obligation_evidence",
      "prompt_sha256",
      "result_id",
      "run_id",
      "test_evidence",
      "work_item_id",
      "worktree_evidence",
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
  // pipeline reads it. Only the framing is this draw's — and the framing is the
  // part that used to differ, producing two undifferentiated sentences that
  // named no component at all.
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

  const changedFiles = stringArray(value.changed_files);
  if (
    !changedFiles ||
    changedFiles.length === 0 ||
    new Set(changedFiles).size !== changedFiles.length ||
    !sameStrings([...changedFiles].sort(compareCodeUnits), changedFiles) ||
    changedFiles.some(
      (path) => !pathIsAllowedByWriteScope(root, path, workItem.allowed_files),
    )
  ) {
    return invalidResult(
      "write_scope",
      "changed_files must be non-empty, sorted, unique, normalized paths within allowed_files",
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
      "commit_evidence",
      "commit_evidence must bind the workload baseline to a distinct full commit id",
    );
  }

  if (
    !Array.isArray(value.test_evidence) ||
    value.test_evidence.length !== workItem.required_tests.length
  ) {
    return invalidResult(
      "test_evidence",
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
        "test_evidence",
        `test_evidence[${index}] must echo the bound command with status passed`,
      );
    }
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

  if (
    !isRecord(value.worktree_evidence) ||
    !hasExactKeys(value.worktree_evidence, ["baseline_commit", "changed_files"]) ||
    value.worktree_evidence.baseline_commit !== workItem.baseline_commit
  ) {
    return invalidResult(
      "worktree_evidence",
      "worktree_evidence must bind the workload baseline and changed-file list",
    );
  }
  const worktreeFiles = stringArray(value.worktree_evidence.changed_files);
  if (!worktreeFiles || !sameStrings(worktreeFiles, changedFiles)) {
    return invalidResult(
      "worktree_evidence",
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
      "landing_attestation",
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
      readonly check: IngestionCheckId;
      readonly message: string;
    };

// The corroboration probes below run while the remediation state lock (and, on
// the fold path, the phase lock) is held — ASYNC with the shared deadline
// (INV-SSF), so the held lock's mtime heartbeat keeps beating through each
// probe and a git that never answers cannot hang the ingest.
async function gitCommitExists(root: string, commit: string): Promise<boolean> {
  const result = await runTrackedAsync(
    ["git", "rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  return !result.error && result.status === 0;
}

// INV-WTS-3 (landed-node ancestry): a landed node's commit must be an ancestor
// of the ref it claims to have landed on. `git merge-base --is-ancestor` exits 0
// exactly when that holds.
async function gitCommitIsAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runTrackedAsync(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
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
 * it.
 *
 * A THIRD source of reachability sits outside `for-each-ref` entirely: the
 * HEADs of this repository's OTHER worktrees, checked into no ref at all. In a
 * linked worktree git DETACHES HEAD (or parks a per-worktree branch), so a
 * baseline that is the live HEAD of a sibling worktree — exactly the state a
 * parallel remediation lane is in — would be reported as contained by nothing,
 * i.e. orphaned, and the relaxation would be handed out for a commit the
 * repository is actively keeping. `git worktree list --porcelain` enumerates
 * every worktree with its current HEAD, so it is read and compared. The linked
 * worktree's own HEAD is included by this probe, which is why the ordinary
 * detached-HEAD case needs no separate arm.
 *
 * RESIDUAL, deliberately not closed: that probe compares HEAD for EQUALITY, so
 * it covers a worktree detached at the baseline ONLY when its HEAD *is* the
 * baseline. A sibling worktree detached at a DESCENDANT of the baseline — a
 * lane that landed further commits on top — keeps the baseline reachable while
 * matching no ref and no worktree HEAD, and is still reported orphaned. Closing
 * it means an ancestry probe per enumerated worktree HEAD; the residual is
 * stated here rather than left as an implied full cover.
 *
 * A failed scan is not evidence of orphanhood — any probe that cannot answer
 * fails closed, so a git that cannot answer never unlocks the relaxation.
 */
async function gitCommitIsOrphaned(
  root: string,
  commit: string,
): Promise<boolean> {
  if (await gitCommitIsAncestor(root, commit, "HEAD")) return false;
  const result = await runTrackedAsync(
    ["git", "for-each-ref", "--contains", commit, "--format=%(refname)"],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  if (result.error || result.status !== 0) return false;
  if (result.stdout.trim().length > 0) return false;
  // Reached only when no REF keeps the commit. Every worktree HEAD is then
  // checked, so the detached (and per-worktree-branch) HEADs git does not
  // enumerate as refs are still seen.
  const worktrees = await runTrackedAsync(
    ["git", "worktree", "list", "--porcelain"],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  if (worktrees.error || worktrees.status !== 0) return false;
  return !worktrees.stdout
    .split("\n")
    .filter((line) => line.startsWith("HEAD "))
    .some((line) => line.slice("HEAD ".length).trim() === commit);
}

async function gitChangedFilesOfCommit(
  root: string,
  commit: string,
): Promise<readonly string[] | null> {
  const result = await runTrackedAsync(
    [
      "git",
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      commit,
    ],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  if (result.error || result.status !== 0) return null;
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort(
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
async function gitChangedFilesSince(
  root: string,
  baseline: string,
): Promise<readonly string[] | null> {
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
    const probe = await runTrackedAsync(["git", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: TRACKED_CHILD_DEADLINE_MS,
    });
    if (probe.error || probe.status !== 0) return null;
    for (const file of probe.stdout.split("\0").filter(Boolean)) {
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
async function corroborateNoChangeClaim(params: {
  readonly root: string;
  readonly workItem: RemediationHostWorkItem;
  /** Repo-relative paths whose movement is already accounted for. */
  readonly excusedPaths: ReadonlySet<string>;
}): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: RemediationHostIngestIssue["code"];
      readonly check: IngestionCheckId;
      readonly message: string;
    }
> {
  const { root, workItem, excusedPaths } = params;
  if (!(await isGitRepo(root))) return { ok: true };
  const baseline = workItem.baseline_commit;
  if (!(await gitCommitExists(root, baseline))) {
    return {
      ok: false,
      code: "commit_missing",
      check: "no_change_corroboration",
      message:
        "resolved_no_change cannot be corroborated: baseline_commit does not resolve to a real commit",
    };
  }
  const changed = await gitChangedFilesSince(root, baseline);
  if (changed === null) {
    return {
      ok: false,
      code: "commit_missing",
      check: "no_change_corroboration",
      message:
        "resolved_no_change cannot be corroborated: git could not enumerate the changes since the workload baseline",
    };
  }
  const violating = changed.filter(
    (path) => !excusedPaths.has(normalizeRepoPath(path)),
  );
  if (violating.length > 0) {
    const inScope = violating.filter((path) =>
      pathIsAllowedByWriteScope(root, path, workItem.allowed_files),
    );
    const outOfScope = violating.filter(
      (path) => !pathIsAllowedByWriteScope(root, path, workItem.allowed_files),
    );
    return {
      ok: false,
      code: "changed_files_mismatch",
      check: "no_change_corroboration",
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
 * The FRONTIER a recovery verdict table describes, as a comparable identity.
 *
 * The recovery verb splits into an unlocked phase that runs the required tests
 * and a locked phase that ingests their verdicts, and it used to bind the two
 * by HEAD alone. HEAD says the TREE has not moved; it says nothing about whether
 * the RUN's own state changed underneath those unlocked spawns — and a
 * concurrent state writer can settle items without touching a single commit.
 * The verdict table phase 1 computed is keyed on which findings were PENDING
 * (`precomputeRecoveryTestVerdicts` filters on exactly that), so once the
 * frontier moves, a command the table no longer covers reads as
 * `required_test_failed` — a bookkeeping race reported as the host's work being
 * wrong. Both halves of the comparison degrade safely: a mismatch refuses.
 *
 * So the identity carries three things, and each catches a writer the others
 * cannot:
 *
 *  - the binding record's own parts (run, baseline, workload digest, item ids),
 *    which the ordinary workload-integrity check would also catch — kept here so
 *    this guard is the one place that says "the frontier moved";
 *  - the sorted set of work items with at least one still-PENDING finding, which
 *    is what the verdict table is actually keyed on. This is the residual's real
 *    shape, and no digest in the state tracks it.
 *
 * `null` means "no binding", which is itself a distinct identity: a phase-1
 * snapshot with no handoff and a phase-2 read that grew one describe different
 * runs.
 */
export function workloadBindingIdentity(
  state: CurrentRemediationHostState,
): string | null {
  const record = state.host_handoff;
  if (!record) return null;
  const pendingWorkItemIds = unresolvedFrontierWorkItemIds(state, record);
  return JSON.stringify([
    record.run_id,
    record.baseline_commit,
    record.workload_sha256,
    [...record.work_item_ids].sort(compareCodeUnits),
    pendingWorkItemIds,
  ]);
}

/**
 * The bound work item ids with at least one finding still `pending`, sorted.
 *
 * Derived from the STATE alone — the workload document is not read, because the
 * caller may be comparing a snapshot whose workload file is no longer on disk
 * (which is one of the situations this guard exists to refuse). A finding with
 * no item record is NOT counted: the state is corrupt in that case, and the
 * ingest's own parse refuses it with a better message than this guard could.
 */
function unresolvedFrontierWorkItemIds(
  state: CurrentRemediationHostState,
  record: { readonly work_item_ids: readonly string[] },
): readonly string[] {
  const items = state.items as Record<
    string,
    { readonly block_id?: string; readonly status?: string } | undefined
  >;
  const pendingBlockIds = new Set(
    Object.values(items)
      .filter((item) => item?.status === "pending")
      .map((item) => item!.block_id),
  );
  return [...record.work_item_ids]
    .filter((id) => pendingBlockIds.has(id))
    .sort(compareCodeUnits);
}

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
    check: "test_evidence",
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
  if (
    !(await gitCommitExists(root, baseline)) ||
    !(await gitCommitExists(root, landed))
  ) {
    return {
      ok: false,
      code: "commit_missing",
      check: "commit_evidence",
      message: "baseline_commit and commit_evidence.after must both resolve to real commits",
    };
  }
  if (!(await gitCommitIsAncestor(root, baseline, landed))) {
    if (!params.recovery) {
      return {
        ok: false,
        code: "baseline_not_ancestor",
        check: "commit_evidence",
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
    if (!(await gitCommitIsOrphaned(root, baseline))) {
      return {
        ok: false,
        code: "baseline_not_ancestor",
        check: "commit_evidence",
        message:
          "the trusted workload baseline is not an ancestor of the claimed landed commit, " +
          "and the baseline is NOT orphaned (a ref still contains it, or it is reachable " +
          "from HEAD), so the stale-worker protection stands and recovery cannot waive it",
      };
    }
    usedRecovery = true;
  }
  if (!(await gitCommitIsAncestor(root, landed, "HEAD"))) {
    return {
      ok: false,
      code: "commit_not_landed",
      check: "commit_evidence",
      message: "commit_evidence.after is not reachable from the repository HEAD",
    };
  }
  const actualFiles = await gitChangedFilesOfCommit(root, landed);
  if (!actualFiles || !sameStrings(actualFiles, result.changed_files)) {
    return {
      ok: false,
      code: "changed_files_mismatch",
      check: "write_scope",
      message:
        "the landed commit's mechanically derived changed files do not exactly match changed_files",
    };
  }
  if (
    actualFiles.some(
      (path) => !pathIsAllowedByWriteScope(root, path, workItem.allowed_files),
    )
  ) {
    return {
      ok: false,
      code: "changed_files_mismatch",
      check: "write_scope",
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
      check: "worktree_evidence",
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
    return { ok: false, code: issue.code, check: "test_evidence", message: issue.message };
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
      contract_version: REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2,
      scope_semantics: REMEDIATION_HOST_SCOPE_SEMANTICS,
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
  const validated = await validateHostResultBundle({
    state,
    nextState,
    paths,
    runId: params.runId,
    recovery: params.recovery,
  });
  if (validated.kind === "summary") {
    const issues = await recordAndEnrichHostIssues(
      params.artifactsDir,
      params.runId,
      validated.summary.issues,
      validated.summary.completed_work_item_ids,
    );
    return { ...validated.summary, issues };
  }

  const acc: HostIngestAccumulators = {
    issues: validated.issues,
    completed: [],
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
  return commitRemediationStateUpdates(validated.ctx, acc, verdicts, issues);
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
       * HEAD, and that its mechanically derived diff exactly equals
       * `changedFiles` within the item's write scope. Persisted onto each
       * settled item (see `RemediationItemState.host_landed_commit`) for a
       * later boundary to attribute; nothing reads it back yet.
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
        const result = parseResult(value, ctx.runId, workItem, paths.root);
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
        const landedCommit = result.commit_evidence.after;
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
    for (const findingId of pendingItems) acc.settledFindingIds.add(findingId);
    verdicts.push({
      kind: "landed",
      workItem,
      pendingItems,
      at: new Date().toISOString(),
      landedCommit: result.commit_evidence.after,
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
      continue;
    }
    for (const findingId of verdict.pendingItems) {
      const item = nextState.items[findingId]!;
      item.status = "resolved";
      item.started_at ??= verdict.at;
      item.completed_at = verdict.at;
      // The corroborated outcome is PERSISTED per item, not just folded into the
      // run-wide `applied_edit_surface`, so the attribution survives the process
      // that observed it. Persisted only: no reader consumes it yet.
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

  return {
    accepted_count: acc.completed.length,
    completed_work_item_ids: acc.completed,
    pending_work_item_ids: pendingWorkItemIds,
    issues,
    state_changed: stateChanged,
    state: nextState,
  };
}
