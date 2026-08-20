import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  headCommit,
  FindingSchema,
  SUBMISSION_ISSUE_CODES,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  appendSubmissionEvent,
  assertSubmissionRunId,
  hashContent,
  isGitRepo,
  normalizeRepoPath,
  readSubmissionDocument,
  readSubmissionLedger,
  repoRelativePath,
  resolveContainedPath,
  spawnSyncHidden,
  stableStringify,
  submissionPathFor,
  writeJsonFile,
  type SubmissionIssue,
  type SubmissionLedgerEvent,
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
import { ITEM_STATUSES, isVerifiedCompleteStatus } from "../../state/itemStatus.js";

const STATE_CONTRACT_VERSION = "remediate-code-state/v1alpha1" as const;
const WORKLOAD_CONTRACT_VERSION =
  "remediation-host-workload/v1alpha1" as const;
const RESULT_CONTRACT_VERSION = "remediation-host-result/v1alpha1" as const;
const DECISION_CONTRACT_VERSION = "remediation-host-decision/v1alpha1" as const;
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
  "item_spec",
  "last_successful_step",
  "mechanical_verification",
  "rework_count",
  "started_at",
  "status",
]);

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const canonicalExpected = [...expected].sort(compareCodeUnits);
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  );
}

function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

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

function resolveBoundaryPaths(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
}): BoundaryPaths {
  assertSubmissionRunId(params.runId, "remediation host run id");
  const root = resolve(params.root);
  const artifactsDir = resolveContainedPath(root, params.artifactsDir, "artifactsDir");
  const runDir = resolveContainedPath(
    artifactsDir,
    join("runs", params.runId, "implement"),
    "remediation host run directory",
  );
  return {
    root,
    artifactsDir,
    workloadPath: join(runDir, "host-workload.json"),
    resultDir: join(runDir, "host-results"),
  };
}

/**
 * The bound path for one work item's submission — the SHARED rule, not a local
 * copy of it. This and its audit twin were byte-equivalent private helpers; a
 * divergence between them would have been silent on both sides.
 */
function resultPathFor(paths: BoundaryPaths, workItemId: string): string {
  return submissionPathFor(
    { root: paths.root, submissionDir: paths.resultDir },
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
      if (dependency && !isVerifiedNow(dependency) && !isPending(dependency)) {
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
          if (!dependency || isVerifiedNow(dependency)) return true;
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
      ...(item.item_spec ? { item_spec: item.item_spec } : {}),
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
    prompt: { text: promptText, sha256: hashContent(promptText) },
    required_tests: requiredTests,
    result_path: resultPath,
    token_estimate: block.token_estimate ?? 0,
  };
}

function hostWorkloadSha256(workload: RemediationHostWorkload): string {
  return hashContent(stableStringify(workload));
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
    hashContent(value.prompt.text) !== value.prompt.sha256
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "run_id", "work_items"]) ||
    value.contract_version !== WORKLOAD_CONTRACT_VERSION ||
    value.run_id !== runId ||
    !Array.isArray(value.work_items)
  ) {
    return null;
  }
  const binding = state.host_handoff;
  if (
    binding &&
    (binding.run_id !== runId ||
      hostWorkloadSha256(value as unknown as RemediationHostWorkload) !==
        binding.workload_sha256)
  ) {
    return null;
  }
  const workItems = value.work_items.map((item) =>
    parseWorkItem(item, paths, state, binding?.baseline_commit),
  );
  if (workItems.some((item) => item === null)) return null;
  const ids = workItems.map((item) => item!.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id, index) => index > 0 && compareCodeUnits(ids[index - 1]!, id) >= 0) ||
    (binding !== undefined && !sameStrings(ids, binding.work_item_ids))
  ) {
    return null;
  }
  return value as unknown as RemediationHostWorkload;
}

function stringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
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
      typeof value.result_id !== "string" ||
      value.result_id.length === 0 ||
      value.run_id !== runId ||
      value.work_item_id !== workItem.id ||
      value.prompt_sha256 !== workItem.prompt.sha256 ||
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
    typeof value.result_id !== "string" ||
    value.result_id.length === 0 ||
    value.run_id !== runId ||
    value.work_item_id !== workItem.id ||
    value.prompt_sha256 !== workItem.prompt.sha256
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
export type RemediationRequiredTestVerdicts = ReadonlyMap<string, string | null>;

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

/** The ONE place a required-test command is spawned. */
function runRequiredTest(root: string, command: string): string | null {
  const result = spawnSync(command, {
    cwd: root,
    shell: true,
    stdio: "ignore",
    timeout: 10 * 60 * 1_000,
    windowsHide: true,
  });
  return result.error || result.status !== 0
    ? `${command} (${result.error?.message ?? `exit ${String(result.status)}`})`
    : null;
}

function rerunRequiredTests(
  root: string,
  commands: readonly string[],
  /** `null` on the normal lane — see {@link RemediationRequiredTestVerdicts}. */
  verdicts: RemediationRequiredTestVerdicts | null,
): readonly string[] {
  const failures: string[] = [];
  for (const command of commands) {
    if (verdicts) {
      const verdict = verdicts.get(requiredTestVerdictKey(root, command));
      if (verdict === undefined) {
        failures.push(
          `${command} (no pre-computed verdict — refusing to spawn a test while the state lock is held)`,
        );
      } else if (verdict !== null) {
        failures.push(verdict);
      }
      continue;
    }
    const failure = runRequiredTest(root, command);
    if (failure !== null) failures.push(failure);
  }
  return failures;
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
  const verdicts = new Map<string, string | null>();

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
      runRequiredTest(paths.root, command),
    );
  }
  return verdicts;
}

function corroborateHostResult(params: {
  readonly root: string;
  readonly state: CurrentRemediationHostState;
  readonly workItem: RemediationHostWorkItem;
  readonly result: RemediationHostResult;
  readonly verdicts: RemediationRequiredTestVerdicts | null;
  /** See `ingestRemediationHostResults`'s `recovery` option. */
  readonly recovery: boolean;
}): CorroboratedHostResult {
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
  const failedTests = rerunRequiredTests(
    root,
    workItem.required_tests,
    verdicts,
  );
  if (failedTests.length > 0) {
    return {
      ok: false,
      code: "required_test_failed",
      message: `mechanical required-test rerun failed: ${failedTests.join("; ")}`,
    };
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
  const workload = buildCanonicalWorkload({
    paths,
    state,
    runId: params.runId,
    baselineCommit,
    ...(existingRecord
      ? { workItemIds: existingRecord.work_item_ids }
      : {}),
  });
  if (workload.work_items.length === 0) {
    throw new Error("Cannot prepare an empty remediation host workload");
  }
  const workloadDigest = hostWorkloadSha256(workload);
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

  if (isGitRepo(paths.root) && !state.host_handoff) {
    return {
      accepted_count: 0,
      completed_work_item_ids: [],
      pending_work_item_ids: [],
      issues: [
        {
          code: "trusted_binding_missing",
          message:
            "a git-backed remediation workload requires the tool-owned host_handoff state binding",
        },
      ],
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
    return {
      accepted_count: 0,
      completed_work_item_ids: [],
      pending_work_item_ids: state.host_handoff?.work_item_ids ?? [],
      issues: [
        {
          code: "workload_invalid",
          message:
            "the workload does not match its canonical state shape and persisted digest binding",
        },
      ],
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
  const requireRepositoryCorroboration =
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

    const absoluteResultPath = resolveContainedPath(
      paths.root,
      workItem.result_path,
      `result path for ${workItem.id}`,
    );
    resolveContainedPath(paths.artifactsDir, absoluteResultPath, `result path for ${workItem.id}`);
    const resultRead = await readSubmissionDocument(absoluteResultPath);
    if (resultRead.kind === "missing") {
      issues.push({
        code: "submission_missing",
        work_item_id: workItem.id,
        result_path: workItem.result_path,
        message: "no result file exists for this pending work item",
      });
      continue;
    }
    if (resultRead.kind === "malformed") {
      issues.push({
        code: "submission_malformed",
        work_item_id: workItem.id,
        result_path: workItem.result_path,
        message: `result JSON could not be parsed: ${resultRead.detail}`,
      });
      continue;
    }
    const parsed = parseResult(resultRead.value, params.runId, workItem);
    if (!parsed.ok) {
      issues.push({
        code: "submission_contract_invalid",
        work_item_id: workItem.id,
        result_path: workItem.result_path,
        message: parsed.reason,
      });
      continue;
    }
    const resultId = parsed.result.result_id;
    if (resultIds.has(resultId)) {
      issues.push({
        code: "duplicate_submission_id",
        work_item_id: workItem.id,
        result_path: workItem.result_path,
        message: `result_id ${resultId} is duplicated in this workload`,
      });
      continue;
    }

    resultIds.add(resultId);
    if (parsed.kind === "decision") {
      const result = parsed.result;
      const outcome = result.outcome;
      if (outcome.status === "resolved_no_change") {
        const failedTests = rerunRequiredTests(
          paths.root,
          workItem.required_tests,
          requiredTestVerdicts,
        );
        if (failedTests.length > 0) {
          issues.push({
            code: "required_test_failed",
            work_item_id: workItem.id,
            result_path: workItem.result_path,
            message: `mechanical required-test rerun failed: ${failedTests.join("; ")}`,
          });
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
    let acceptedFiles = result.changed_files;
    if (requireRepositoryCorroboration) {
      const corroborated = corroborateHostResult({
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
      acceptedFiles = corroborated.changedFiles;
    }
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
