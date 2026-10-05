import { DecisionApplicationReceiptSchema } from "../../state/decisionConsumption.js";
import { recordHostRootLogBoundary } from "../../../shared/observability/rootLogObservations.js";
import { AcceptedConformanceReviewSchema, type AcceptedConformanceReview } from "../../../shared/types/reviewIndependence.js";
import type { CurrentRemediationHostState, PreparedRemediationHostHandoff, RemediationHostDecision, RemediationHostIngestIssue, RemediationHostIngestSummary, RemediationHostResult, RemediationHostWorkItem, RemediationHostWorkload, RemediationIssueCode, UnsupportedRetiredRemediationState } from "./hostContracts.js";
import type { RemediationRequiredTestVerdicts } from "./requiredTests.js";
import { corroborateHostResult, corroborateNoChangeClaim } from "./hostCorroboration.js";
import { runRequiredTest, rerunRequiredTests, requiredTestIssue, requiredTestVerdictKey, type RequiredTestFailure } from "./requiredTests.js";
import { readIntentCheckpoint } from "../../../shared/types/intentCheckpoint.js";
import { checkContractConformance, conformanceReviewPaths, type ConformanceReviewCheck } from "./contractConformanceReview.js";
import type { ExecutionUnit, ExecutionRequirement } from "../../../shared/types/executionPlan.js";
import { executionPlanReferenceIssues } from "../../../shared/types/executionPlan.js";
import { executionPlanContextIssues } from "../../contractPipeline/executionPlan.js";
import { assertApprovedRuntimePlan as assertCurrentPlanAuthority, RemediationPlanAuthorityError } from "../../contractPipeline/runtimePlanAuthority.js";
// sites-pinned: tests/remediate/host-handoff-corroboration.test.ts, tests/remediate/host-handoff-corroboration-required-test-runner.test.ts, tests/remediate/host-handoff.test.ts
//   host-handoff-corroboration-required-test-runner: the bounded required-test failure message.
//   host-handoff: the "landing gates" block fails when the close-owns-the-gates prompt line
//   or the id-glossary write scope is reverted.
import { mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  headCommit,
  commandLeavesDeclaredShape,
  SUBMISSION_ISSUE_REMEDY,
  WORKLOAD_ISSUE_REMEDY,
  bindWorkerPrompt,
  deriveResultId,
  type IssueRemedy,
  type WorkItemOutcome,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  appendSubmissionEvent,
  enrichMissingSubmissionIssues,
  isMissingObservation,
  compareCodeUnits,
  contentSha256,
  deriveLaneDemand,
  estimateTokensFromBytes,
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
  readJsonFile,
  readSubmissionLedger,
  readTrailingSubmissionRefusals,
  recoveryMarkMatches,
  recordHostResultOutcomes,
  repoRelativePath,
  resolveContainedPath,
  resolveHostHandoffPaths,
  sameStrings,
  scanBoundSubmission,
  SEVERITIES,
  severityRank,
  stringArray,
  stableStringify,
  writeJsonFile,
  type FindingSeverity,
  type HostHandoffPaths,
  type IngestionCheckId,
  type SubmissionIssue,
  type SubmissionLedgerEvent,
  type SubmissionScanMessages,
} from "audit-tools/shared";
import {
  REMEDIATION_STATE_CONTRACT_VERSION,
  type RemediationState,
} from "../../state/store.js";
import {
  REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2,
  REMEDIATION_HOST_SCOPE_SEMANTICS,
  RemediationHostHandoffRecordSchema,
  ConformanceReviewBindingSchema,
  RemediationPlanSchema,
  isClarificationCategory,
  type RemediationHostHandoffRecord,
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

/** A recognized preparation defect, emitted as a bounded repair step by next-step. */
export class RemediationHostPreparationError extends Error {
  constructor(readonly code: "plan_repair_required" | "handoff_rebind_required", message: string) {
    super(message);
    this.name = "RemediationHostPreparationError";
  }
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
  conformance_review_required: "none",
  conformance_review_unavailable: "none",
  conformance_review_insufficient: "repair",
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
};

/** The remedy for one classified remediation ingest failure. */
export function remediationIssueRemedy(
  issue: SubmissionIssue<RemediationIssueCode>,
): IssueRemedy {
  return REMEDIATION_ISSUE_REMEDY[issue.code];
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

const CURRENT_STATE_KEYS = new Set([
  "decision_applications",
  "applied_edit_surface",
  "closing_context",
  "closing_plan",
  "contract_version",
  "items",
  "finding_dispositions",
  "source_verifications",
  "host_handoff",
  "conformance_review",
  "plan",
  "plan_coverage",
  "run_start_dirty",
  "started_at",
  "status",
  "step_count",
]);

const CURRENT_ITEM_KEYS = new Set([
  "unit_id",
  "clarification_context",
  "clarification_question",
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
  "conformance_review",
  "incomplete_coverage_attempts",
  "last_successful_step",
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

  if (value.conformance_review !== undefined && !ConformanceReviewBindingSchema.safeParse(value.conformance_review).success) return null;
  if (value.decision_applications !== undefined && (!Array.isArray(value.decision_applications) || value.decision_applications.some(receipt => !DecisionApplicationReceiptSchema.safeParse(receipt).success))) return null;
  const parsedPlan = RemediationPlanSchema.safeParse(value.plan);
  if (!parsedPlan.success || !isRecord(value.items)) return null;
  const stateItems = value.items;

  if (value.host_handoff !== undefined) {
    const parsedHandoff = RemediationHostHandoffRecordSchema.safeParse(
      value.host_handoff,
    );
    if (!parsedHandoff.success) return null;
    if (parsedHandoff.data.conformance_policy_sha256 !== undefined &&
      (value.conformance_review === undefined || contentSha256(value.conformance_review) !== parsedHandoff.data.conformance_policy_sha256)) return null;
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

  const unitIds = new Set(parsedPlan.data.units.map(unit => unit.id));
  if (unitIds.size !== parsedPlan.data.units.length) return null;
  const knownStatuses = new Set<string>(ITEM_STATUSES);
  for (const [unitId, item] of Object.entries(stateItems)) {
    if (!isRecord(item) || !hasOnlyKnownKeys(item, CURRENT_ITEM_KEYS) ||
        item.unit_id !== unitId || !unitIds.has(unitId) || !knownStatuses.has(String(item.status))) return null;
    if (item.conformance_review !== undefined && !AcceptedConformanceReviewSchema.safeParse(item.conformance_review).success) return null;
  }
  if ([...unitIds].some(id => !stateItems[id])) return null;

  return value as unknown as CurrentRemediationHostState;
}

/** Preserve the host boundary's public repair error while sharing its authority policy. */
async function assertApprovedRuntimePlan(artifactsDir: string, state: CurrentRemediationHostState) {
  try {
    return await assertCurrentPlanAuthority(artifactsDir, state);
  } catch (error) {
    if (!(error instanceof RemediationPlanAuthorityError)) throw error;
    throw new RemediationHostPreparationError(error.code, error.message);
  }
}

function normalizeDeclaredPath(root: string, candidate: string, label: string): string {
  if (candidate.length === 0 || isAbsolute(candidate)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const normalized = repoRelativePath(root, candidate, label);
  return candidate.endsWith("/") ? `${normalized}/` : normalized;
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
 * `block.required_tests` — `reverifyBlockedItemAgainstTree` in
 * `src/remediate/phases/triage.ts` — asks the same declared command-shape rule
 * before spawning and then runs each command through {@link runRequiredTest}
 * (argv-split, no shell, deadline-bounded), so a command this boundary would
 * refuse is refused there too rather than reaching a shell.
 */
function assertBlockContract(root: string, block: ExecutionUnit): void {
  for (const raw of block.allowed_files) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new BlockContractError(
        block.id,
        "touched_files carries an empty entry",
      );
    }
    if (isAbsolute(raw)) {
      throw new BlockContractError(
        block.id,
        `touched_files entry ${JSON.stringify(raw)} is absolute, not repository-relative`,
      );
    }
    let normalized: string;
    try {
      normalized = normalizeDeclaredPath(
        root,
        raw,
        `${block.id}.touched_files[]`,
      );
    } catch {
      throw new BlockContractError(
        block.id,
        `touched_files entry ${JSON.stringify(raw)} does not resolve beneath the repository root`,
      );
    }
    if (normalized !== raw) {
      throw new BlockContractError(
        block.id,
        `touched_files entry ${JSON.stringify(raw)} is not in normalized repo-relative form ` +
          `(${JSON.stringify(normalized)})`,
      );
    }
  }
  for (const command of block.required_tests ?? []) {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new BlockContractError(
        block.id,
        "targeted_commands carries an empty command",
      );
    }
    // THE declared-command-shape rule (`audit-tools/shared`), not a local copy:
    // the producer that promotes these commands and the triage path that also
    // spawns them ask the same predicate, so a command cannot clear one boundary
    // and dead-end at another.
    if (commandLeavesDeclaredShape(command)) {
      throw new BlockContractError(
        block.id,
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
  const blockIds = new Set(state.plan.units.map((block) => block.id));
  const boundIds = new Set(state.host_handoff?.work_item_ids ?? []);
  const issues: RemediationHostIngestIssue[] = [];
  for (const block of state.plan.units) {
    const status = state.items[block.id]?.status;
    const unsettled = status !== undefined && !isTerminalStatus(status);
    if (!unsettled && !boundIds.has(block.id)) continue;
    const missing = (block.dependencies ?? []).filter(
      (dependencyId) => !blockIds.has(dependencyId),
    );
    if (missing.length > 0) {
      issues.push({
        code: "dependency_missing",
        work_item_id: block.id,
        message:
          `block '${block.id}' declares ${missing.length === 1 ? "a dependency" : "dependencies"} ` +
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
        work_item_id: block.id,
        message: error.message,
      });
    }
  }
  for (const message of executionPlanReferenceIssues(state.plan, state.plan.findings.map(finding => finding.id))) {
    if (!issues.some(issue => issue.message === message)) issues.push({ code: "block_contract_invalid", message });
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
): ExecutionUnit[][] {
  const { plan, items } = state;
  if (!plan || !items) return [];
  const byId = new Map(plan.units.map(unit => [unit.id, unit]));
  const lowerPhases = (unit: ExecutionUnit): ExecutionUnit[] => plan.units.filter(lower =>
    (lower.phase_ordinal ?? 0) < (unit.phase_ordinal ?? 0));
  const placed = new Set<string>();
  let remaining = plan.units.filter(unit => items[unit.id]?.status === "pending");
  const levels: ExecutionUnit[][] = [];
  while (remaining.length) {
    // A phase is an integration boundary: even projected later dependency levels
    // wait until every earlier phase actually verified on the current tree.
    const ready = remaining.filter(unit => lowerPhases(unit).every(lower => isVerifiedCompleteStatus(items[lower.id]?.status)) &&
      unit.dependencies.every(id => byId.has(id) && (isVerifiedCompleteStatus(items[id]?.status) || placed.has(id))));
    if (!ready.length) break;
    levels.push(ready);
    for (const unit of ready) placed.add(unit.id);
    remaining = remaining.filter(unit => !placed.has(unit.id));
  }
  return levels;
}

/** Questions remain live; skipped/failed prerequisites never authorize a dependent. */
export function permanentlyDeadPendingUnits(
  state: Pick<RemediationState, "plan" | "items">,
): ExecutionUnit[] {
  const { plan, items } = state;
  if (!plan || !items) return [];
  const live = new Set(plan.units.filter(unit => isVerifiedCompleteStatus(items[unit.id]?.status)).map(unit => unit.id));
  for (let changed = true; changed;) {
    changed = false;
    for (const unit of plan.units) {
      if (live.has(unit.id)) continue;
      const status = items[unit.id]?.status;
      const lowerPhasesLive = plan.units.filter(lower => (lower.phase_ordinal ?? 0) < (unit.phase_ordinal ?? 0)).every(lower => live.has(lower.id));
      if ((status === "pending" || status === "needs_clarification") && lowerPhasesLive && unit.dependencies.every(id => live.has(id))) {
        live.add(unit.id); changed = true;
      }
    }
  }
  return plan.units.filter(unit => !live.has(unit.id) && items[unit.id]?.status === "pending");
}

function buildPrompt(item: {
  readonly unit: ExecutionUnit;
  readonly requirements: readonly ExecutionRequirement[];
  readonly sourceFindings: readonly unknown[];
  readonly counterexamples: readonly unknown[];
  readonly revision: string;
  readonly context: { clarification_context?: string; failure_context?: string };
  readonly baselineCommit: string;
  readonly resultPath: string;
  readonly hasLandingGates: boolean;
}): string {
  return [
    `# Implement execution unit \`${item.unit.id}\``, "", "Assignment:", "", "```json",
    stableStringify({
      unit: item.unit, requirements: item.requirements, source_findings: item.sourceFindings,
      accepted_counterexamples: item.counterexamples,
      review_revision_sha256: item.revision, baseline_commit: item.baselineCommit,
      ...item.context, result_path: item.resultPath,
    }), "```", "", "Rules:", "",
    '- Edit only `unit.allowed_files`. A trailing "/" permits files below that directory; every other entry permits exactly that file.',
    '- Read `unit.read_paths`, implement the reviewed unit description, and satisfy every linked requirement and scoped positive/negative assertion. Original source findings are provenance, not substitute execution instructions.',
    '- Preserve every declared affected interface and address the named counterexamples. Code violating a requirement is a defect even if tests pass.',
    ...(item.unit.required_tests.length ? ['- Run every `unit.required_tests` command until it passes. The tool reruns each before accepting your result.'] : []),
    '- Make one commit on top of `baseline_commit`, with all your edits in it. Merge it so HEAD contains it.',
    ...(item.hasLandingGates ? ['- Do not run the landing gates. The close phase runs them once, on the merged tree.'] : []),
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
  block: ExecutionUnit,
): number {
  const scores = block.source_finding_ids
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

function buildWorkItem(
  paths: BoundaryPaths, runId: string, unit: ExecutionUnit,
  baselineCommit: string, state: CurrentRemediationHostState,
): RemediationHostWorkItem {
  assertBlockContract(paths.root, unit);
  const item = state.items[unit.id];
  if (!item) throw new Error(`Execution unit ${unit.id} has no runtime item`);
  const requirements = unit.requirement_ids.map(id => {
    const requirement = state.plan.requirements.find(entry => entry.id === id);
    if (!requirement) throw new Error(`Execution unit ${unit.id} references unknown requirement ${id}`);
    return requirement;
  });
  const sourceFindings = unit.source_finding_ids.map(id => {
    const finding = state.plan.findings.find(entry => entry.id === id);
    if (!finding) throw new Error(`Execution unit ${unit.id} references unknown source finding ${id}`);
    return finding;
  });
  const resultPath = resultPathFor(paths, unit.id);
  const obligationIds = [...unit.requirement_ids].sort(compareCodeUnits);
  const prompt = bindWorkerPrompt(buildPrompt({
    unit, requirements, sourceFindings, revision: state.plan.review_revision_sha256,
    counterexamples: (state.plan.review_counterexamples ?? []).filter(example => unit.addresses_counterexample_ids.includes(example.id)),
    context: {
      ...(item.clarification_context ? { clarification_context: item.clarification_context } : {}),
      ...(item.failure_context ? { failure_context: item.failure_context } : {}),
    }, baselineCommit, resultPath, hasLandingGates: discoverLandingGates(paths.root).length > 0,
  }), promptDigest => renderResultTemplate({ runId, blockId: unit.id, resultPath, obligationIds, promptDigest }));
  const tokenEstimate = estimateTokensFromBytes(Buffer.byteLength(prompt.text, "utf8"));
  return {
    id: unit.id, source_finding_ids: [...unit.source_finding_ids],
    allowed_files: [...unit.allowed_files], baseline_commit: baselineCommit,
    obligation_ids: obligationIds, prompt: { text: prompt.text, sha256: prompt.sha256 },
    required_tests: [...unit.required_tests], result_path: resultPath,
    demand: deriveLaneDemand({ tokenEstimate, fileCount: unit.allowed_files.length, riskScore: blockRiskScore(state, unit) }),
    token_estimate: tokenEstimate,
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
    ? params.state.plan.units.filter((block) => requestedIds.has(block.id))
    : hostDependencyLevels(params.state)[0] ?? [];
  const blocks = [...sourceBlocks].sort((left, right) =>
    compareCodeUnits(left.id, right.id),
  );
  if (
    requestedIds &&
    (blocks.length !== requestedIds.size ||
      blocks.some((block) => !requestedIds.has(block.id)))
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
      "source_finding_ids",
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
    !Array.isArray(value.source_finding_ids) ||
    !value.source_finding_ids.every((entry) => typeof entry === "string") ||
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

  const block = state.plan.units.find((candidate) => candidate.id === value.id);
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
    { readonly unit_id?: string; readonly status?: string } | undefined
  >;
  const pendingBlockIds = new Set(
    Object.values(items)
      .filter((item) => item?.status === "pending")
      .map((item) => item!.unit_id),
  );
  return [...record.work_item_ids]
    .filter((id) => pendingBlockIds.has(id))
    .sort(compareCodeUnits);
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
  await assertApprovedRuntimePlan(paths.artifactsDir, state);
  const verdicts = new MintedRequiredTestVerdicts();

  const workloadRead = await readSubmissionDocument(paths.workloadPath);
  if (workloadRead.kind !== "value") return verdicts;
  const workload = parseWorkload(workloadRead.value, paths, params.runId, state);
  if (!workload) return verdicts;

  const commands: string[] = [];
  for (const workItem of workload.work_items) {
    const hasPending = state.items[workItem.id]?.status === "pending";
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

async function persistedWorkloadAllowsRebind(
  workloadPath: string, expected: RemediationHostHandoffRecord,
): Promise<boolean> {
  const value = await readJsonFile<unknown>(workloadPath);
  // A version change can alter shape, never the run/baseline/work identities.
  if (!isRecord(value) || value.run_id !== expected.run_id || !Array.isArray(value.work_items)) return false;
  const ids: string[] = [];
  for (const item of value.work_items) {
    if (!isRecord(item) || typeof item.id !== "string" || item.baseline_commit !== expected.baseline_commit) return false;
    ids.push(item.id);
  }
  if (new Set(ids).size !== ids.length ||
      !sameStrings(ids.sort(compareCodeUnits), [...expected.work_item_ids].sort(compareCodeUnits))) return false;
  // Ordinary state movement also proves the predecessor's complete digest.
  return persistedWorkloadIsStale(value) || contentSha256(value) === expected.workload_sha256;
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
  const paths = resolveBoundaryPaths(params);
  const approved = await assertApprovedRuntimePlan(paths.artifactsDir, state);
  if (!isCommit(params.baselineCommit)) {
    throw new Error("Remediation host baselineCommit must be a full commit id");
  }

  const existingRecord = state.host_handoff;
  if (!existingRecord) {
    const accepted = state.plan.units.flatMap(unit => {
      const item = state.items[unit.id];
      return item?.host_landed_commit ? [{ allowed_files: [...unit.allowed_files], landed_commit: item.host_landed_commit }] : [];
    });
    const contextIssues = await executionPlanContextIssues(paths.root, approved.canonical, accepted);
    if (contextIssues.length) throw new RemediationHostPreparationError("plan_repair_required", contextIssues.join("; "));
  }
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
  const planIssues = planBlockIssues(paths.root, state);
  if (planIssues.length) throw new RemediationHostPreparationError("plan_repair_required", planIssues.map(issue => issue.message).join("; "));
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
    throw new RemediationHostPreparationError("plan_repair_required", cannotPrepareMessage(paths.root, state, error));
  }
  if (workload.work_items.length === 0) {
    // Name the producer defect when it is the cause. An empty level 0 that is
    // really "every candidate block declares a prerequisite that does not
    // exist" used to surface as a bare "empty workload", sending the operator
    // to look at scheduling rather than at the plan.
    const blocked = planBlockIssues(paths.root, state);
    throw new RemediationHostPreparationError(
      "plan_repair_required",
      blocked.length === 0
        ? "Cannot prepare an empty remediation host workload"
        : `Cannot prepare a remediation host workload: ${blocked
            .map((issue) => issue.message)
            .join("; ")}`,
    );
  }
  const workloadDigest = contentSha256(workload);
  // A binding whose workload file an earlier contract version wrote is
  // re-minted in place: same run, baseline and work item ids, new digest. Only
  // the DIGEST moves — anything else that no longer matches is still a refusal.
  const remintStaleDigest =
    existingRecord !== undefined &&
    existingRecord.workload_sha256 !== workloadDigest &&
    (await persistedWorkloadAllowsRebind(paths.workloadPath, existingRecord));
  if (
    existingRecord &&
    existingRecord.workload_sha256 !== workloadDigest &&
    !remintStaleDigest
  ) {
    throw new RemediationHostPreparationError(
      "handoff_rebind_required",
      `Trusted remediation host workload no longer matches the persisted state binding; ${paths.workloadPath} cannot prove its trusted identity`,
    );
  }
  let conformanceReview = state.conformance_review;
  if (conformanceReview && conformanceReview.run_id !== params.runId) {
    throw new Error("Conformance review policy belongs to another run; restore coherent run state or confirm a new run.");
  }
  if (!conformanceReview) {
    // A lost snapshot must not reset a review already requested for this run.
    for (const item of workload.work_items) {
      const priorReview = await readSubmissionDocument(conformanceReviewPaths(paths.artifactsDir, params.runId, item.id).request);
      if (priorReview.kind !== "missing") {
        throw new Error("The conformance review has begun but the trusted run policy is missing. Restore the run state before continuing; review cannot be silently disabled.");
      }
    }
    const checkpoint = await readIntentCheckpoint(join(paths.artifactsDir, "intent_checkpoint.json"));
    conformanceReview = { run_id: params.runId, enabled: checkpoint?.conformance_review === true,
      ...(checkpoint ? { checkpoint_sha256: contentSha256(checkpoint) } : {}) };
  }
  const conformancePolicyDigest = conformanceReview.enabled ? contentSha256(conformanceReview) : undefined;
  if (existingRecord?.conformance_policy_sha256 && existingRecord.conformance_policy_sha256 !== conformancePolicyDigest) {
    throw new Error("The conformance review snapshot no longer matches its trusted handoff binding.");
  }
  const handoffRecord: RemediationHostHandoffRecord = existingRecord
    ? remintStaleDigest
      ? { ...existingRecord, workload_sha256: workloadDigest }
      : existingRecord
    : {
      contract_version: REMEDIATION_HOST_HANDOFF_RECORD_V1ALPHA2,
      scope_semantics: REMEDIATION_HOST_SCOPE_SEMANTICS,
      run_id: params.runId,
      baseline_commit: baselineCommit,
      workload_sha256: workloadDigest,
      work_item_ids: workload.work_items.map((item) => item.id),
    };

  await mkdir(paths.resultDir, { recursive: true });
  await assertApprovedRuntimePlan(paths.artifactsDir, state);
  await recordHostRootLogBoundary({ ...paths, runId: params.runId, phase: "prepare" });
  await writeJsonFile(paths.workloadPath, workload);
  return {
    workload,
    workload_path: paths.workloadPath,
    handoff_record: conformancePolicyDigest ? { ...handoffRecord, conformance_policy_sha256: conformancePolicyDigest } : handoffRecord,
    conformance_review: conformanceReview,
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
  await assertApprovedRuntimePlan(paths.artifactsDir, state);

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

  if (state.conformance_review && state.conformance_review.run_id !== params.runId) {
    throw new Error("Conformance review policy belongs to another run; refusing result acceptance.");
  }
  if (!state.conformance_review && state.host_handoff) {
    for (const id of state.host_handoff.work_item_ids) {
      const priorReview = await readSubmissionDocument(conformanceReviewPaths(paths.artifactsDir, params.runId, id).request);
      if (priorReview.kind !== "missing") throw new Error("Required conformance review policy is missing; restore the trusted run state.");
    }
  }
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
    if (state.host_handoff) await recordHostRootLogBoundary({ ...paths, runId: params.runId, phase: "ingest" });
    return { ...validated.summary, issues };
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
  // Tests and independent review involve awaits. A superseding plan/source
  // invalidates the entire acceptance before any accepted ledger event is minted.
  await assertApprovedRuntimePlan(paths.artifactsDir, state);
  const issues = await recordAndEnrichHostIssues(
    params.artifactsDir,
    params.runId,
    acc.issues,
    acc.completed,
  );
  const summary = await commitRemediationStateUpdates(validated.ctx, acc, verdicts, issues);
  await recordHostRootLogBoundary({ ...paths, runId: params.runId, phase: "ingest" });
  return summary;
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
      readonly conformance_review?: AcceptedConformanceReview;
      readonly outcome: RemediationHostDecision["outcome"];
    }
  | {
      readonly kind: "landed";
      readonly workItem: RemediationHostWorkItem;
      readonly pendingItems: readonly string[];
      readonly at: string;
      readonly conformance_review?: AcceptedConformanceReview;
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
 * INGEST" in tests/remediate/host-handoff-corroboration-no-change.test.ts).
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
      effectiveWorkload: workload,
      eligibleIds: new Set(
        (hostDependencyLevels(state)[0] ?? []).map((block) => block.id),
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
  return typeof state.items[workItem.id]?.host_landed_commit === "string";
}

async function requiredConformanceReview(
  ctx: HostIngestContext, workItem: RemediationHostWorkItem,
  result: RemediationHostResult | RemediationHostDecision,
): Promise<ConformanceReviewCheck> {
  if (!ctx.state.conformance_review?.enabled) return { ok: true };
  return checkContractConformance({
    root: ctx.paths.root, artifactsDir: ctx.paths.artifactsDir, runId: ctx.runId,
    item: workItem, result,
    requirements: ctx.state.plan.requirements.filter(requirement => workItem.obligation_ids.includes(requirement.id)),
    unit: ctx.state.plan.units.find(unit => unit.id === workItem.id)!,
    revision: ctx.state.plan.review_revision_sha256,
    counterexamples: (ctx.state.plan.review_counterexamples ?? []).filter(example =>
      ctx.state.plan.units.find(unit => unit.id === workItem.id)!.addresses_counterexample_ids.includes(example.id)),
  });
}

async function executeHostVerificationReruns(
  ctx: HostIngestContext,
  acc: HostIngestAccumulators,
): Promise<readonly HostItemVerdict[]> {
  const { paths, nextState, state } = ctx;
  const verdicts: HostItemVerdict[] = [];
  for (const workItem of ctx.effectiveWorkload.work_items) {
    const pendingItems = [workItem.id].filter(
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
      const review: ConformanceReviewCheck = outcome.status === "resolved_no_change"
        ? await requiredConformanceReview(ctx, workItem, result) : { ok: true };
      if (!review.ok) { acc.issues.push(review.issue); continue; }
      for (const findingId of pendingItems) acc.settledFindingIds.add(findingId);
      verdicts.push({
        kind: "decision",
        workItem,
        pendingItems,
        at: new Date().toISOString(),
        outcome,
        conformance_review: review.receipt,
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
    const review = await requiredConformanceReview(ctx, workItem, result);
    if (!review.ok) { acc.issues.push(review.issue); continue; }
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
    for (const findingId of pendingItems) acc.settledFindingIds.add(findingId);
    verdicts.push({
      kind: "landed",
      conformance_review: review.receipt,
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
        if (verdict.conformance_review) item.conformance_review = verdict.conformance_review;
        else delete item.conformance_review;
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
        if (verdict.conformance_review) item.conformance_review = verdict.conformance_review;
        else delete item.conformance_review;
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
      [workItem.id].some(
        (findingId) => nextState.items[findingId]?.status === "pending",
      ),
    )
    .map((workItem) => workItem.id);
  let stateChanged = acc.completed.length > 0;
  if (nextState.host_handoff && pendingWorkItemIds.length === 0) {
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
