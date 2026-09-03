import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createMemoizedSourceReader,
  appendSubmissionEvent,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  bindingIdentity,
  compareCodeUnits,
  contentSha256,
  firstDuplicateIdentity,
  hasExactKeys,
  hostHandoffResultPath,
  isFileMissingError,
  isRecord,
  isSha256,
  parseAllWorkloadItems,
  parseWorkloadEnvelope,
  promptSha256,
  readJsonFile,
  repoRelativePath,
  requireNonEmptyString,
  resolveContainedPath,
  resolveHostHandoffPaths,
  resultMapIdentity,
  scanBoundSubmission,
  siblingLockPath,
  sameStrings,
  stableStringify,
  verifyFindingGrounding,
  withFileLock,
  writeBlockedStepContract,
  writeJsonFile,
  type RunLogger,
  type SubmissionScanMessages,
} from "audit-tools/shared";
import { findingContractPromptLines } from "../../contracts/findingContractPrompt.js";
import { WorkerFindingSchema, type WorkerFinding } from "../../contracts/workerSchemas.js";
import { AuditResultSchema, type AuditResult, type AuditTask } from "../../types.js";
import {
  validateOneAuditResult,
  formatAuditResultIssues,
} from "../../validation/auditResults.js";
import type { AuditHostIngestIssue } from "../../validation/ingestIssueCodes.js";

const WORKLOAD_CONTRACT_VERSION = "audit-host-workload/v1alpha1" as const;
const RESULT_MAP_CONTRACT_VERSION = "audit-host-result-map/v1alpha1" as const;
const RESULT_CONTRACT_VERSION = "audit-host-result/v1alpha1" as const;
const TASK_BINDINGS_CONTRACT_VERSION =
  "audit-host-task-bindings/v1alpha1" as const;
const ACCEPTED_RESULTS_CONTRACT_VERSION =
  "audit-host-accepted-results/v1alpha1" as const;

export interface AuditHostTask {
  readonly task_id: string;
  readonly unit_id: string;
  readonly pass_id: string;
  readonly lens: string;
  readonly file_paths: readonly string[];
  readonly file_line_counts: Readonly<Record<string, number>>;
  readonly rationale: string;
  readonly priority: string;
  readonly complexity: string;
  readonly risk: string;
  readonly token_estimate: number;
}

export interface AuditHostWorkItem {
  readonly id: string;
  readonly lens: string;
  readonly metadata: {
    readonly complexity: string;
    readonly risk: string;
    readonly token_estimate: number;
  };
  readonly prompt: {
    readonly sha256: string;
    readonly text: string;
  };
  readonly scope: {
    readonly files: readonly string[];
    readonly unit_ids: readonly string[];
  };
  readonly result_path: string;
}

export interface AuditHostWorkload {
  readonly contract_version: typeof WORKLOAD_CONTRACT_VERSION;
  readonly run_id: string;
  readonly work_items: readonly AuditHostWorkItem[];
}

export interface AuditHostResultMapEntry {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly result_path: string;
}

export interface AuditHostResultMap {
  readonly contract_version: typeof RESULT_MAP_CONTRACT_VERSION;
  readonly run_id: string;
  readonly entries: readonly AuditHostResultMapEntry[];
}

export interface PreparedAuditHostHandoff {
  readonly workload: AuditHostWorkload;
  readonly result_map: AuditHostResultMap;
  readonly workload_path: string;
  readonly result_map_path: string;
}

/**
 * One ADVISORY validation finding on an ACCEPTED result. Deliberately not a
 * {@link AuditHostIngestIssue}: an accepted result was never refused, so it must
 * never ride (or be recorded through) the rejection-classified channel — see
 * {@link AuditHostIngestSummary.validation_warnings}.
 */
export interface AuditHostValidationWarning {
  readonly work_item_id: string;
  readonly result_path: string;
  readonly message: string;
}

export interface AuditHostIngestSummary {
  readonly accepted_count: number;
  readonly accepted_results: readonly AuditResult[];
  readonly accepted_results_path: string;
  readonly completed_work_item_ids: readonly string[];
  /**
   * Every submission this ingest could not accept, classified.
   *
   * The four ways a submission used to fail — absent file, unparseable bytes, a
   * body that violates the result contract, and a conversion that yields
   * nothing — all collapsed into the same bare `null` and the same silent
   * `continue`. A host that never wrote its result and a host that wrote
   * garbage were indistinguishable to every caller, which is exactly the
   * measured drift P25 exists to make visible.
   */
  readonly issues: readonly AuditHostIngestIssue[];
  /**
   * Advisory validation findings on results that WERE accepted — a small
   * coverage-stat divergence, verification metadata on a non-verification
   * task. Never a refusal: they ride this separate channel precisely so the
   * rejection list stays rejections only, and no ledger records an acceptance
   * as one.
   */
  readonly validation_warnings: readonly AuditHostValidationWarning[];
}

interface HostCoverage {
  readonly path: string;
  readonly reviewed_lines: number;
  readonly total_lines: number;
}

interface AuditHostResult {
  readonly contract_version: typeof RESULT_CONTRACT_VERSION;
  readonly result_id: string;
  readonly run_id: string;
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly file_coverage: readonly HostCoverage[];
  /** The findings AS THE STRICT PROJECTION PARSED THEM (see {@link parseFindings}). */
  readonly findings: readonly WorkerFinding[];
}

interface AcceptedResultEntry {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly result_path: string;
  readonly result_id: string;
  readonly result_sha256: string;
  readonly result: AuditHostResult;
  readonly audit_result: AuditResult;
}

interface AcceptedResultsLedger {
  readonly contract_version: typeof ACCEPTED_RESULTS_CONTRACT_VERSION;
  readonly run_id: string;
  readonly entries: readonly AcceptedResultEntry[];
}

interface AuditHostTaskBinding {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
  readonly result_path: string;
  readonly unit_id: string;
  readonly pass_id: string;
  readonly lens: string;
  readonly file_line_counts: Readonly<Record<string, number>>;
}

interface AuditHostTaskBindings {
  readonly contract_version: typeof TASK_BINDINGS_CONTRACT_VERSION;
  readonly run_id: string;
  readonly entries: readonly AuditHostTaskBinding[];
}

interface ResolvedBoundaryPaths {
  readonly root: string;
  readonly runId: string;
  readonly artifactsDir: string;
  readonly runDir: string;
  readonly resultDir: string;
  readonly workloadPath: string;
  readonly resultMapPath: string;
  readonly taskBindingsPath: string;
  readonly acceptedLedgerPath: string;
  readonly acceptedResultsPath: string;
  /**
   * The ONE lock serializing every read-modify-write of the ACCEPTED-RESULTS
   * PAIR. Both writers — prepare and ingest — acquire it before touching the
   * ledger, so the read-merge-write race the ledger used to lose is closed for
   * prepare-against-ingest as well as ingest-against-ingest.
   *
   * IT COVERS THE LEDGER ONLY — state the uncovered half rather than let the
   * covered half read as a close. The rest of the run directory is still
   * unsynchronized in both directions:
   *   - `ingestAuditHostResults` reads `host-workload.json`,
   *     `host-result-map.json` and `host-task-bindings.json` BEFORE taking the
   *     lock, so a concurrent prepare can rewrite any of the three underneath a
   *     ledger merge that already parsed them;
   *   - `prepareAuditHostHandoff` writes `host-task-bindings.json` outside the
   *     lock entirely (only the workload and result-map writes are inside it),
   *     so that file has no writer-side serialization at all.
   * Closing the whole prepare/ingest race — the trio under the same acquisition
   * as the ledger — is tracked as backlog work, not done here.
   */
  readonly acceptedLockPath: string;
}

/**
 * The audit draw's boundary paths: the SHARED resolution (run-id grammar,
 * containment, `runs/<id>`), plus the four files this boundary persists beyond
 * the workload — the result map, the trusted task bindings, and the
 * accepted-results pair with its one serializing lock.
 */
function resolveBoundaryPaths(
  params: Parameters<typeof resolveHostHandoffPaths>[0],
): ResolvedBoundaryPaths {
  const core = resolveHostHandoffPaths({
    ...params,
    runDirSegments: [],
    runIdLabel: "audit host run id",
  });
  return {
    root: core.root,
    runId: params.runId,
    artifactsDir: core.artifactsDir,
    runDir: core.runDir,
    resultDir: core.resultDir,
    workloadPath: core.workloadPath,
    resultMapPath: join(core.runDir, "host-result-map.json"),
    taskBindingsPath: join(core.runDir, "host-task-bindings.json"),
    acceptedLedgerPath: join(core.runDir, "host-accepted-results-ledger.json"),
    acceptedResultsPath: join(core.runDir, "host-accepted-results.json"),
    // Named off the pair's own stem, so the lock is visibly the lock FOR those
    // two files rather than an independently-invented name. It is transient
    // infrastructure, not a run artifact anything cites.
    acceptedLockPath: siblingLockPath(join(core.runDir, "host-accepted-results")),
  };
}

/**
 * The accepted-results read-modify-write, SERIALIZED.
 *
 * `host-accepted-results.json` and its ledger are one logical record written as
 * two files, and both prepare and ingest used to load a snapshot, work from it,
 * and write both files back with a plain atomic replace. Atomic-replace makes
 * the loss SILENT rather than corrupt: the later writer's snapshot simply
 * predates the earlier writer's additions, and every duplicate-binding and
 * duplicate-result_id guard downstream derives from that stale snapshot.
 *
 * So the read, the merge and both writes happen inside ONE acquisition of the
 * shared lock substrate. No backoff, retry or stale-lock logic lives here — all
 * of it is `withFileLock`'s, and the caller's RunLogger is threaded straight
 * through so the primitive's heartbeat and stale-lock-reclaim events land in the
 * run log rather than vanishing.
 */
async function withAcceptedResultsLock<T>(
  paths: ResolvedBoundaryPaths,
  logger: RunLogger | undefined,
  mutate: (current: AcceptedResultsLedger) => Promise<T>,
): Promise<T> {
  return withFileLock(
    paths.acceptedLockPath,
    async () =>
      mutate(
        await loadAcceptedResults(paths.acceptedLedgerPath, paths.runId),
      ),
    undefined,
    logger,
  );
}

/**
 * Persist the accepted-results pair. Only ever called under the lock above.
 *
 * ORDER IS LOAD-BEARING — the LEDGER is written FIRST, the results render
 * second. The strict loader (`loadAcceptedResults`) reads the ledger as truth;
 * a throw between the two writes must therefore be able to leave the render
 * STALE, never AHEAD of it: a render naming an entry the ledger has not yet
 * recorded would re-serve that result on every future ingest (the ledger is
 * what dedupes), while a stale render is simply regenerated by the next
 * successful write of this pair.
 */
async function writeAcceptedResults(
  paths: ResolvedBoundaryPaths,
  ledger: AcceptedResultsLedger,
): Promise<void> {
  await writeJsonFile(paths.acceptedLedgerPath, ledger);
  await writeJsonFile(
    paths.acceptedResultsPath,
    ledger.entries.map((entry) => entry.audit_result),
  );
}

/**
 * The bound path for one work item's submission — the SHARED rule, not a local
 * copy of it. This and the remediate twin were byte-equivalent private helpers;
 * a divergence between them would have been silent on both sides.
 */
function resultPathFor(paths: ResolvedBoundaryPaths, workItemId: string): string {
  return hostHandoffResultPath(
    { root: paths.root, artifactsDir: paths.artifactsDir, runDir: paths.runDir, resultDir: paths.resultDir, workloadPath: paths.workloadPath },
    workItemId,
  );
}

function normalizeTask(
  task: AuditHostTask,
  root: string,
): AuditHostTask {
  if (!isRecord(task)) {
    throw new Error("Audit host task must be an object");
  }
  const taskId = requireNonEmptyString(task.task_id, "task_id");
  const unitId = requireNonEmptyString(task.unit_id, `${taskId}.unit_id`);
  const passId = requireNonEmptyString(task.pass_id, `${taskId}.pass_id`);
  const lens = requireNonEmptyString(task.lens, `${taskId}.lens`);
  const rationale = requireNonEmptyString(task.rationale, `${taskId}.rationale`);
  const priority = requireNonEmptyString(task.priority, `${taskId}.priority`);
  const complexity = requireNonEmptyString(
    task.complexity,
    `${taskId}.complexity`,
  );
  const risk = requireNonEmptyString(task.risk, `${taskId}.risk`);
  if (
    !Number.isFinite(task.token_estimate) ||
    task.token_estimate < 0 ||
    !Number.isInteger(task.token_estimate)
  ) {
    throw new Error(`${taskId}.token_estimate must be a non-negative integer`);
  }
  if (!Array.isArray(task.file_paths) || !isRecord(task.file_line_counts)) {
    throw new Error(`${taskId} must declare file paths and line counts`);
  }

  const files = [
    ...new Set(
      task.file_paths.map((path) => {
        const raw = requireNonEmptyString(path, `${taskId}.file_paths[]`);
        const absolute = resolveContainedPath(root, raw, `${taskId} file path`);
        return repoRelativePath(root, absolute, `${taskId} file path`);
      }),
    ),
  ].sort(compareCodeUnits);
  const normalizedLineCounts: Record<string, number> = {};
  for (const [path, count] of Object.entries(task.file_line_counts)) {
    const normalizedPath = repoRelativePath(
      root,
      resolveContainedPath(root, path, `${taskId} line-count path`),
      `${taskId} line-count path`,
    );
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${taskId} has an invalid line count for ${path}`);
    }
    if (
      Object.hasOwn(normalizedLineCounts, normalizedPath) &&
      normalizedLineCounts[normalizedPath] !== count
    ) {
      throw new Error(`${taskId} has conflicting line counts for ${normalizedPath}`);
    }
    normalizedLineCounts[normalizedPath] = count;
  }
  for (const file of files) {
    if (!Object.hasOwn(normalizedLineCounts, file)) {
      throw new Error(`${taskId} is missing the line count for ${file}`);
    }
  }

  return {
    task_id: taskId,
    unit_id: unitId,
    pass_id: passId,
    lens,
    file_paths: files,
    file_line_counts: Object.fromEntries(
      Object.entries(normalizedLineCounts).sort(([left], [right]) =>
        compareCodeUnits(left, right),
      ),
    ),
    rationale,
    priority,
    complexity,
    risk,
    token_estimate: task.token_estimate,
  };
}

function buildPrompt(task: AuditHostTask, resultPath: string): string {
  const assignment = stableStringify({
    file_line_counts: task.file_line_counts,
    files: task.file_paths,
    lens: task.lens,
    pass_id: task.pass_id,
    rationale: task.rationale,
    result_path: resultPath,
    task_id: task.task_id,
    unit_id: task.unit_id,
  });
  return [
    "Perform the bounded semantic audit work item below.",
    "Review every listed file and return one JSON object at the bound result path.",
    `Assignment: ${assignment}`,
    "Result contract: audit-host-result/v1alpha1 with exactly result_id, run_id, work_item_id, prompt_sha256, file_coverage, and findings in addition to contract_version.",
    "Each file_coverage entry must contain exactly path, reviewed_lines, and total_lines.",
    // The finding contract is CARRIED, not referenced: it is rendered from the
    // very schema ingestion enforces, so a host never has to remember or fetch it.
    ...findingContractPromptLines(),
    "Do not supply a `grounding` field on any finding — grounding is computed by the tool at ingest by re-reading your cited quoted_text from disk, and a supplied one rejects the whole submission.",
  ].join("\n");
}

function buildWorkItem(
  paths: ResolvedBoundaryPaths,
  task: AuditHostTask,
): AuditHostWorkItem {
  const resultPath = resultPathFor(paths, task.task_id);
  const promptText = buildPrompt(task, resultPath);
  return {
    id: task.task_id,
    lens: task.lens,
    metadata: {
      complexity: task.complexity,
      risk: task.risk,
      token_estimate: task.token_estimate,
    },
    prompt: {
      sha256: promptSha256(promptText),
      text: promptText,
    },
    scope: {
      files: [...task.file_paths],
      unit_ids: [task.unit_id],
    },
    result_path: resultPath,
  };
}

function validateAcceptedEntry(
  value: unknown,
): value is AcceptedResultEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "audit_result",
      "prompt_sha256",
      "result",
      "result_id",
      "result_path",
      "result_sha256",
      "work_item_id",
    ])
  ) {
    return false;
  }
  return (
    typeof value.work_item_id === "string" &&
    isSha256(value.prompt_sha256) &&
    typeof value.result_path === "string" &&
    typeof value.result_id === "string" &&
    isSha256(value.result_sha256) &&
    isRecord(value.result) &&
    value.result_sha256 === contentSha256(value.result) &&
    value.result.work_item_id === value.work_item_id &&
    value.result.prompt_sha256 === value.prompt_sha256 &&
    value.result.result_id === value.result_id &&
    AuditResultSchema.safeParse(value.audit_result).success &&
    isRecord(value.audit_result) &&
    value.audit_result.task_id === value.work_item_id
  );
}

async function loadAcceptedResults(
  path: string,
  runId: string,
): Promise<AcceptedResultsLedger> {
  let value: unknown;
  try {
    value = await readJsonFile<unknown>(path);
  } catch (error) {
    if (isFileMissingError(error)) {
      return {
        contract_version: ACCEPTED_RESULTS_CONTRACT_VERSION,
        run_id: runId,
        entries: [],
      };
    }
    throw error;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "entries", "run_id"]) ||
    value.contract_version !== ACCEPTED_RESULTS_CONTRACT_VERSION ||
    value.run_id !== runId ||
    !Array.isArray(value.entries) ||
    !value.entries.every(validateAcceptedEntry)
  ) {
    throw new Error(`Invalid accepted audit host results ledger: ${path}`);
  }
  const duplicate = firstDuplicateIdentity(value.entries, bindingIdentity);
  if (duplicate !== null) {
    throw new Error(`Duplicate accepted audit host result binding: ${duplicate.work_item_id}`);
  }
  return value as unknown as AcceptedResultsLedger;
}

export async function prepareAuditHostHandoff(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly tasks: readonly AuditHostTask[];
  /**
   * Threaded into the shared lock substrate so its heartbeat, timeout and
   * stale-lock-reclaim events are recorded rather than lost. Optional: a caller
   * with no run log still gets the serialization, just not the telemetry.
   */
  readonly logger?: RunLogger;
}): Promise<PreparedAuditHostHandoff> {
  if (!Array.isArray(params.tasks)) {
    throw new Error("Audit host tasks must be an array");
  }
  const paths = resolveBoundaryPaths(params);
  const taskIds = new Set<string>();
  const tasks = params.tasks
    .map((task) => normalizeTask(task, paths.root))
    .sort((left, right) => compareCodeUnits(left.task_id, right.task_id));
  for (const task of tasks) {
    if (taskIds.has(task.task_id)) {
      throw new Error(`Duplicate audit host task id: ${task.task_id}`);
    }
    taskIds.add(task.task_id);
  }

  const allWorkItems = tasks.map((task) => buildWorkItem(paths, task));
  const taskById = new Map(tasks.map((task) => [task.task_id, task]));
  const taskBindings: AuditHostTaskBindings = {
    contract_version: TASK_BINDINGS_CONTRACT_VERSION,
    run_id: params.runId,
    entries: allWorkItems.map((item) => {
      const task = taskById.get(item.id);
      if (task === undefined) {
        throw new Error(`Missing canonical audit host task: ${item.id}`);
      }
      return {
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        result_path: item.result_path,
        unit_id: task.unit_id,
        pass_id: task.pass_id,
        lens: task.lens,
        file_line_counts: Object.fromEntries(
          item.scope.files.map((path) => [path, task.file_line_counts[path]]),
        ),
      };
    }),
  };

  await mkdir(paths.resultDir, { recursive: true });
  await writeJsonFile(paths.taskBindingsPath, taskBindings);

  // The already-satisfied filter READS the ledger and the rewrite WRITES it, so
  // both sit inside the one acquisition — a prepare that snapshotted before a
  // concurrent ingest's additions must not replace them with its stale copy, and
  // it must not re-ask for a lane that ingest has meanwhile satisfied.
  return withAcceptedResultsLock(paths, params.logger, async (accepted) => {
    const acceptedBindings = new Set(accepted.entries.map(bindingIdentity));
    const workItems = allWorkItems.filter(
      (item) =>
        !acceptedBindings.has(
          bindingIdentity({
            work_item_id: item.id,
            prompt_sha256: item.prompt.sha256,
          }),
        ),
    );
    const workload: AuditHostWorkload = {
      contract_version: WORKLOAD_CONTRACT_VERSION,
      run_id: params.runId,
      work_items: workItems,
    };
    const resultMap: AuditHostResultMap = {
      contract_version: RESULT_MAP_CONTRACT_VERSION,
      run_id: params.runId,
      entries: workItems.map((item) => ({
        work_item_id: item.id,
        prompt_sha256: item.prompt.sha256,
        result_path: item.result_path,
      })),
    };

    await writeAcceptedResults(paths, accepted);
    await writeJsonFile(paths.workloadPath, workload);
    await writeJsonFile(paths.resultMapPath, resultMap);
    return {
      workload,
      result_map: resultMap,
      workload_path: paths.workloadPath,
      result_map_path: paths.resultMapPath,
    };
  });
}

function parseWorkItem(value: unknown): AuditHostWorkItem | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "id",
      "lens",
      "metadata",
      "prompt",
      "result_path",
      "scope",
    ]) ||
    typeof value.id !== "string" ||
    typeof value.lens !== "string" ||
    typeof value.result_path !== "string" ||
    !isRecord(value.metadata) ||
    !hasExactKeys(value.metadata, ["complexity", "risk", "token_estimate"]) ||
    typeof value.metadata.complexity !== "string" ||
    typeof value.metadata.risk !== "string" ||
    !Number.isInteger(value.metadata.token_estimate) ||
    !isRecord(value.prompt) ||
    !hasExactKeys(value.prompt, ["sha256", "text"]) ||
    !isSha256(value.prompt.sha256) ||
    typeof value.prompt.text !== "string" ||
    promptSha256(value.prompt.text) !== value.prompt.sha256 ||
    !isRecord(value.scope) ||
    !hasExactKeys(value.scope, ["files", "unit_ids"]) ||
    !Array.isArray(value.scope.files) ||
    !value.scope.files.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.scope.unit_ids) ||
    !value.scope.unit_ids.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return value as unknown as AuditHostWorkItem;
}

function parseWorkload(value: unknown, runId: string): AuditHostWorkload {
  // Envelope + all-items parsing is the CORE's scaffolding; the audit draw
  // selects only its own contract version and item parser.
  const envelope = parseWorkloadEnvelope(value, {
    contractVersion: WORKLOAD_CONTRACT_VERSION,
    runId,
  });
  if (!envelope.ok) {
    throw new Error("Invalid audit host workload");
  }
  const workItems = parseAllWorkloadItems(envelope.rawItems, parseWorkItem);
  if (workItems === null) {
    throw new Error("Invalid audit host work item");
  }
  return value as unknown as AuditHostWorkload;
}

function parseResultMap(value: unknown, runId: string): AuditHostResultMap {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "entries", "run_id"]) ||
    value.contract_version !== RESULT_MAP_CONTRACT_VERSION ||
    value.run_id !== runId ||
    !Array.isArray(value.entries) ||
    !value.entries.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, [
          "prompt_sha256",
          "result_path",
          "work_item_id",
        ]) &&
        typeof entry.work_item_id === "string" &&
        isSha256(entry.prompt_sha256) &&
        typeof entry.result_path === "string",
    )
  ) {
    throw new Error("Invalid audit host result map");
  }
  return value as unknown as AuditHostResultMap;
}

function parseTaskBinding(value: unknown): AuditHostTaskBinding | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "file_line_counts",
      "lens",
      "pass_id",
      "prompt_sha256",
      "result_path",
      "unit_id",
      "work_item_id",
    ]) ||
    typeof value.work_item_id !== "string" ||
    !isSha256(value.prompt_sha256) ||
    typeof value.result_path !== "string" ||
    typeof value.unit_id !== "string" ||
    typeof value.pass_id !== "string" ||
    typeof value.lens !== "string" ||
    !isRecord(value.file_line_counts) ||
    !Object.values(value.file_line_counts).every(
      (count) => Number.isInteger(count) && (count as number) >= 0,
    )
  ) {
    return null;
  }
  return value as unknown as AuditHostTaskBinding;
}

function parseTaskBindings(
  value: unknown,
  runId: string,
): Map<string, AuditHostTaskBinding> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "entries", "run_id"]) ||
    value.contract_version !== TASK_BINDINGS_CONTRACT_VERSION ||
    value.run_id !== runId ||
    !Array.isArray(value.entries)
  ) {
    throw new Error("Invalid audit host task bindings");
  }
  const bindings = new Map<string, AuditHostTaskBinding>();
  for (const rawEntry of value.entries) {
    const entry = parseTaskBinding(rawEntry);
    if (entry === null || bindings.has(entry.work_item_id)) {
      throw new Error("Invalid or duplicate audit host task binding");
    }
    bindings.set(entry.work_item_id, entry);
  }
  return bindings;
}

function validateHandoffBinding(
  paths: ResolvedBoundaryPaths,
  workload: AuditHostWorkload,
  resultMap: AuditHostResultMap,
  taskBindings: ReadonlyMap<string, AuditHostTaskBinding>,
): Map<string, AuditHostWorkItem> {
  const items = new Map<string, AuditHostWorkItem>();
  for (const item of workload.work_items) {
    if (items.has(item.id)) {
      throw new Error(`Duplicate audit host work item: ${item.id}`);
    }
    if (item.result_path !== resultPathFor(paths, item.id)) {
      throw new Error(`Unbound audit host result path: ${item.id}`);
    }
    const binding = taskBindings.get(item.id);
    if (
      binding === undefined ||
      binding.prompt_sha256 !== item.prompt.sha256 ||
      binding.result_path !== item.result_path ||
      binding.lens !== item.lens ||
      item.scope.unit_ids.length !== 1 ||
      binding.unit_id !== item.scope.unit_ids[0] ||
      !sameStrings(
        Object.keys(binding.file_line_counts).sort(compareCodeUnits),
        [...item.scope.files].sort(compareCodeUnits),
      )
    ) {
      throw new Error(`Invalid audit host task binding: ${item.id}`);
    }
    items.set(item.id, item);
  }
  // The result-map identity half is the CORE's check, with its failure
  // CLASSIFIED: a coverage miss says the MAP is wrong; an identity miss names
  // the entry whose prompt digest or bound path broke. Both of the audit
  // draw's original refusals survive — they are not collapsed into one.
  const identity = resultMapIdentity([...items.values()], resultMap.entries);
  if (!identity.ok) {
    throw new Error(
      identity.reason === "coverage"
        ? "Audit host result map does not cover the workload exactly"
        : `Invalid audit host result binding: ${identity.workItemId ?? "unknown"}`,
    );
  }
  return items;
}

/**
 * A parsed submission, or the NAMED reason it was refused.
 *
 * `detail` opens with the category that failed — envelope, identity binding,
 * findings, file coverage — because the categories are not interchangeable to
 * the host that has to repair the result. A live lap lost four submissions whose
 * identity, prompt binding and file coverage were all byte-correct and whose
 * FINDINGS failed the finding schema; the single collapsed message sent the host
 * to re-check the three things that were already right.
 */
type HostResultParse =
  | { readonly ok: true; readonly result: AuditHostResult }
  | { readonly ok: false; readonly detail: string };

function refuse(detail: string): HostResultParse {
  return { ok: false, detail };
}

/** `findings[2].affected_files.0.path` — a zod issue path, host-readable. */
function issueLocation(
  prefix: string,
  path: readonly (string | number)[],
): string {
  return [prefix, ...path.map((segment) => String(segment))].join(".");
}

function parseFindings(
  findings: readonly unknown[],
):
  | { readonly ok: true; readonly findings: readonly WorkerFinding[] }
  | { readonly ok: false; readonly detail: string } {
  const parsedFindings: WorkerFinding[] = [];
  for (const [index, finding] of findings.entries()) {
    // S7: `grounding` is the TOOL's re-check of the worker's own quote — the one
    // bit ingestion exists to compute. A submission that supplies it is
    // self-certifying that bit, so it is REFUSED (never silently overwritten):
    // the host must see that the field is not its to send. Stated ahead of the
    // schema check because this message names the field as the WORKER's mistake;
    // the strict schema would report it only as an unrecognized key.
    if (isRecord(finding) && "grounding" in finding) {
      return {
        ok: false,
        detail: `findings[${index}].grounding: grounding is tool-computed at ingest and must not be supplied`,
      };
    }
    // The same refusal for the second tool-owned verdict: `verification_status`
    // is DERIVED at conceptual ingest from the judge's per-candidate claims, so a
    // worker-supplied value would bypass the derivation and be
    // un-cross-checkable against the adjudication record.
    if (isRecord(finding) && "verification_status" in finding) {
      return {
        ok: false,
        detail: `findings[${index}].verification_status: verification_status is tool-derived at ingest and must not be supplied`,
      };
    }
    // The STRICT WORKER PROJECTION — the same contract the dispatch prompt
    // renders (`findingContractPromptLines`). Parsing the lenient base schema
    // here accepted a prompt-obedient submission that downstream validation
    // then failed (evidence missing), which is exactly the two-sources defect.
    const parsed = WorkerFindingSchema.safeParse(finding);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const location =
        issue === undefined
          ? `findings[${index}]`
          : issueLocation(`findings[${index}]`, issue.path);
      const reason = issue === undefined ? "invalid" : issue.message;
      return {
        ok: false,
        detail: `findings failed the audit finding contract at ${location}: ${reason}`,
      };
    }
    parsedFindings.push(parsed.data);
  }
  return { ok: true, findings: parsedFindings };
}

function parseHostResult(
  value: unknown,
  runId: string,
  item: AuditHostWorkItem,
  binding: AuditHostTaskBinding,
): HostResultParse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "contract_version",
      "file_coverage",
      "findings",
      "prompt_sha256",
      "result_id",
      "run_id",
      "work_item_id",
    ]) ||
    value.contract_version !== RESULT_CONTRACT_VERSION ||
    typeof value.result_id !== "string" ||
    value.result_id.length === 0
  ) {
    return refuse(
      `result envelope is not ${RESULT_CONTRACT_VERSION} with exactly contract_version, ` +
        `result_id, run_id, work_item_id, prompt_sha256, file_coverage and findings`,
    );
  }
  if (value.run_id !== runId) {
    return refuse(`identity binding: run_id is not this run's '${runId}'`);
  }
  if (value.work_item_id !== item.id) {
    return refuse(`identity binding: work_item_id is not '${item.id}'`);
  }
  if (value.prompt_sha256 !== item.prompt.sha256) {
    return refuse(
      "prompt binding: prompt_sha256 is not the sha256 of this work item's prompt",
    );
  }
  if (!Array.isArray(value.file_coverage)) {
    return refuse("file coverage: file_coverage must be an array");
  }
  if (!Array.isArray(value.findings)) {
    return refuse("findings failed the audit finding contract: findings must be an array");
  }
  // The parsed findings ride ON the result, so `toAuditResult` never has to
  // re-parse them (one parse, one door).
  const findingsParse = parseFindings(value.findings);
  if (!findingsParse.ok) return refuse(findingsParse.detail);
  const { findings } = findingsParse;
  const coveragePaths = new Set<string>();
  for (const coverage of value.file_coverage) {
    if (
      !isRecord(coverage) ||
      !hasExactKeys(coverage, ["path", "reviewed_lines", "total_lines"]) ||
      typeof coverage.path !== "string"
    ) {
      return refuse(
        "file coverage: every entry must contain exactly path, reviewed_lines and total_lines",
      );
    }
    if (coveragePaths.has(coverage.path)) {
      return refuse(`file coverage: '${coverage.path}' is covered twice`);
    }
    if (
      !Number.isInteger(coverage.reviewed_lines) ||
      !Number.isInteger(coverage.total_lines) ||
      (coverage.reviewed_lines as number) < 0 ||
      coverage.reviewed_lines !== coverage.total_lines
    ) {
      return refuse(
        `file coverage: '${coverage.path}' must report reviewed_lines equal to total_lines`,
      );
    }
    const boundLines: number | undefined = binding.file_line_counts[coverage.path];
    if (coverage.total_lines !== boundLines) {
      return refuse(
        boundLines === undefined
          ? `file coverage: '${coverage.path}' is not one of this work item's bound files`
          : `file coverage: '${coverage.path}' reports ${String(coverage.total_lines)} ` +
            `total_lines, not the bound ${String(boundLines)}`,
      );
    }
    coveragePaths.add(coverage.path);
  }
  const uncovered = item.scope.files.filter((path) => !coveragePaths.has(path));
  if (uncovered.length > 0 || coveragePaths.size !== item.scope.files.length) {
    return refuse(
      uncovered.length > 0
        ? `file coverage: the assigned scope is not fully covered (missing ${uncovered.join(", ")})`
        : "file coverage: entries do not match the assigned scope exactly",
    );
  }
  const result = JSON.parse(
    stableStringify({
      ...value,
      findings,
    }),
  ) as AuditHostResult;
  return { ok: true, result };
}

/** The conversion to the persisted `AuditResult`, or the field that refused it. */
type AuditResultConversion =
  | { readonly ok: true; readonly auditResult: AuditResult }
  | { readonly ok: false; readonly detail: string };

function toAuditResult(
  result: AuditHostResult,
  binding: AuditHostTaskBinding,
): AuditResultConversion {
  // Findings arrive already parsed against the strict worker projection
  // (`parseFindings`, threaded through `AuditHostResult.findings`) — this is a
  // mapping, not a second validation. `lens` defaults from the enclosing
  // AuditResult — the binding's lens, which IS this result's lens — exactly as
  // the projection's `.describe()` states.
  const findings = result.findings.map((finding) => ({
    ...finding,
    lens: finding.lens ?? binding.lens,
  }));
  const parsed = AuditResultSchema.safeParse({
    task_id: binding.work_item_id,
    unit_id: binding.unit_id,
    pass_id: binding.pass_id,
    lens: binding.lens,
    file_coverage: result.file_coverage
      .map((coverage) => ({
        path: coverage.path,
        total_lines: coverage.total_lines,
      }))
      .sort((left, right) => compareCodeUnits(left.path, right.path)),
    findings,
    reviewed_clean: result.findings.length === 0,
    run_id: result.run_id,
  });
  if (parsed.success) return { ok: true, auditResult: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    detail:
      issue === undefined
        ? "the converted AuditResult is invalid"
        : `${issueLocation("audit_result", issue.path)}: ${issue.message}`,
  };
}

/**
 * This draw's refusal vocabulary for {@link scanBoundSubmission}. The scan owns
 * the sequence (containment, read, classify, duplicate check); the words are
 * this lane's, because they address a host repairing a bound audit result.
 */
function auditScanMessages(workItemId: string): SubmissionScanMessages {
  return {
    missing: () => `work item '${workItemId}' submitted nothing at its bound path`,
    malformed: (detail) =>
      `work item '${workItemId}' submitted bytes that are not JSON: ${detail}`,
    // The detail NAMES its own category. The message must never enumerate
    // categories the submission satisfied — that is how four correct-identity
    // results read as an identity problem for a whole lap.
    contractInvalid: (detail) =>
      `work item '${workItemId}' submitted JSON that does not satisfy the audit host ` +
      `result contract: ${detail}`,
    duplicate: (resultId) =>
      `work item '${workItemId}' submitted result id '${resultId}', ` +
      `which this run has already accepted`,
  };
}

export async function ingestAuditHostResults(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  /**
   * The active audit-task manifest, REQUIRED: every task-known result is put
   * through the SAME per-result rules `validateAuditResults` applies to the
   * batch BEFORE it is written to the accepted pair; a task-unknown (orphan)
   * result passes through unvalidated, mirroring the batch gate's retention of
   * orphans. Requiring it here means no caller can silently regain
   * accept-without-validation by forgetting to pass the manifest.
   */
  readonly auditTasks: readonly AuditTask[];
  /**
   * Normalized path → actual line count, built from the repo manifest exactly as
   * {@link runAuditStep} builds it. Threads the line-count rules of the batch
   * gate into the accept decision; absent means those checks degrade to skips,
   * never to errors.
   */
  readonly lineIndex?: Record<string, number>;
  /** See {@link prepareAuditHostHandoff}'s `logger`. */
  readonly logger?: RunLogger;
}): Promise<AuditHostIngestSummary> {
  const paths = resolveBoundaryPaths(params);
  const accepted = await loadAcceptedResults(
    paths.acceptedLedgerPath,
    params.runId,
  );
  const workload = parseWorkload(
    await readJsonFile<unknown>(paths.workloadPath),
    params.runId,
  );
  const resultMap = parseResultMap(
    await readJsonFile<unknown>(paths.resultMapPath),
    params.runId,
  );
  const taskBindings = parseTaskBindings(
    await readJsonFile<unknown>(paths.taskBindingsPath),
    params.runId,
  );
  const items = validateHandoffBinding(
    paths,
    workload,
    resultMap,
    taskBindings,
  );
  const acceptedBindings = new Set(accepted.entries.map(bindingIdentity));
  const resultIds = new Set(accepted.entries.map((entry) => entry.result_id));
  const additions: AcceptedResultEntry[] = [];
  const issues: AuditHostIngestIssue[] = [];
  const validation_warnings: AuditHostValidationWarning[] = [];
  // One memoized reader for the whole ingest: N findings citing one file read it once.
  const readSource = createMemoizedSourceReader();
  const activeTaskIds = new Set(params.auditTasks.map((task) => task.task_id));

  for (const entry of resultMap.entries) {
    if (acceptedBindings.has(bindingIdentity(entry))) continue;
    const item = items.get(entry.work_item_id);
    const binding = taskBindings.get(entry.work_item_id);
    if (item === undefined || binding === undefined) continue;
    const outcome = await scanBoundSubmission<AuditHostResult>({
      root: paths.root,
      artifactsDir: paths.artifactsDir,
      workItemId: entry.work_item_id,
      resultPath: entry.result_path,
      parse: (value) => {
        const parsed = parseHostResult(value, params.runId, item, binding);
        return parsed.ok ? { ok: true, parsed: parsed.result } : parsed;
      },
      resultId: (result) => result.result_id,
      // CHECK only. The id is consumed further down, after conversion,
      // validation and grounding — a result refused there must stay re-submittable.
      seen: (resultId) => resultIds.has(resultId),
      messages: auditScanMessages(entry.work_item_id),
    });
    if (!outcome.ok) {
      issues.push(outcome.issue);
      continue;
    }
    const result = outcome.parsed;
    const converted = toAuditResult(result, binding);
    if (!converted.ok) {
      issues.push({
        code: "submission_contract_invalid",
        message:
          `work item '${entry.work_item_id}' submitted a result that does not convert to ` +
          `an AuditResult: ${converted.detail}`,
        work_item_id: entry.work_item_id,
        result_path: entry.result_path,
      });
      continue;
    }

    // VALIDATE BEFORE ACCEPT. The conversion above proves only the envelope
    // contract (`FindingSchema` admits an evidence-less finding); these are the
    // per-result rules the downstream batch gate applies, applied HERE so an
    // error-severity issue never reaches the accepted pair. A rejected item is
    // simply never in the ledger, so the corrected file at the same bound path
    // is re-read on the next fold — acceptance used to be terminal instead, and
    // a failed batch gate then wedged the run permanently.
    //
    // Orphans (task pruned by a re-plan) pass through UNVALIDATED with the same
    // stderr notice the batch gate uses — never newly rejected: refusing one
    // here would strand it outside the append-only ledger entirely.
    if (!activeTaskIds.has(entry.work_item_id)) {
      process.stderr.write(
        `audit host-handoff ingest: result for '${entry.work_item_id}' is not in the ` +
          `active task manifest (orphaned by re-planning); retained in the accepted pair ` +
          `but skipped at the validation gate\n`,
      );
    } else {
      const validationIssues = validateOneAuditResult(converted.auditResult, [
        ...params.auditTasks,
      ], {
        lineIndex: params.lineIndex,
      });
      const errors = validationIssues.filter((issue) => issue.severity === "error");
      if (errors.length > 0) {
        issues.push({
          code: "result_validation_failed",
          message:
            `work item '${entry.work_item_id}' failed audit-results validation ` +
            `(${errors.length} error(s)); fix the result file at its bound path and call next-step again: ` +
            formatAuditResultIssues(errors),
          work_item_id: entry.work_item_id,
          result_path: entry.result_path,
        });
        continue;
      }
      // Warnings are NOT rejections: an accepted result never refused anything,
      // so a warning must never reach the rejection-classified issue list — the
      // ONE ledger recorder would otherwise record kind:'rejected' for a result
      // that was accepted, manufacturing a repair story that never happened.
      // They ride the separate advisory channel instead (rendered for the
      // operator; never counted as a submission that could not be accepted).
      validation_warnings.push(
        ...validationIssues
          .filter((issue) => issue.severity === "warning")
          .map(
            (warning): AuditHostValidationWarning => ({
              work_item_id: entry.work_item_id,
              result_path: entry.result_path,
              message: `${warning.message} (${warning.field})`,
            }),
          ),
      );
    }

    // S7 quote-and-verify: the tool re-reads each cited span from disk and
    // stamps the verdict. It NEVER rejects — a quote that does not re-verify
    // rides through as `ungrounded` and synthesis surfaces it under "Ungrounded
    // Findings (not confirmed)"; refusing here would discard the whole
    // submission over one bad citation.
    for (const finding of converted.auditResult.findings) {
      finding.grounding = await verifyFindingGrounding(
        paths.root,
        finding,
        readSource,
      );
    }
    resultIds.add(result.result_id);
    additions.push({
      work_item_id: entry.work_item_id,
      prompt_sha256: entry.prompt_sha256,
      result_path: entry.result_path,
      result_id: result.result_id,
      result_sha256: contentSha256(result),
      result,
      audit_result: converted.auditResult,
    });
  }

  // The submission reading, contract checking and grounding re-verification
  // above run UNLOCKED — they only read. The read-modify-write does not: the
  // ledger is re-read under the lock and the additions are re-filtered against
  // that fresh copy, so a concurrent writer's entries are merged rather than
  // replaced, and a binding or result id it accepted in the meantime is not
  // accepted a second time here.
  let landed: AcceptedResultEntry[] = [];
  const ledger = await withAcceptedResultsLock(
    paths,
    params.logger,
    async (current) => {
      const currentBindings = new Set(current.entries.map(bindingIdentity));
      const currentResultIds = new Set(
        current.entries.map((entry) => entry.result_id),
      );
      landed = additions.filter(
        (addition) =>
          !currentBindings.has(bindingIdentity(addition)) &&
          !currentResultIds.has(addition.result_id),
      );
      if (landed.length === 0) return current;
      const next: AcceptedResultsLedger = {
        contract_version: ACCEPTED_RESULTS_CONTRACT_VERSION,
        run_id: params.runId,
        entries: [...current.entries, ...landed].sort((left, right) => {
          const item = compareCodeUnits(left.work_item_id, right.work_item_id);
          return item !== 0
            ? item
            : compareCodeUnits(left.prompt_sha256, right.prompt_sha256);
        }),
      };
      await writeAcceptedResults(paths, next);
      return next;
    },
  );
  for (const addition of additions) {
    if (landed.includes(addition)) continue;
    issues.push({
      code: "duplicate_submission_id",
      message:
        `work item '${addition.work_item_id}' was already accepted by a concurrent ` +
        `ingest of this run, so this submission was not accepted a second time`,
      work_item_id: addition.work_item_id,
      result_path: addition.result_path,
    });
  }

  // Ledger recording is NOT done here. The shared submission ledger is written
  // by the ONE recorder, `recordHostResultOutcomes`, at this ingest's only
  // production caller — fed these very `issues` and `completed_work_item_ids` —
  // so every rejection below already lands there in arrival order. A second
  // writer inside the boundary would double-record the same fact.

  return {
    accepted_count: landed.length,
    accepted_results: ledger.entries.map((entry) => entry.audit_result),
    accepted_results_path: paths.acceptedResultsPath,
    validation_warnings,
    completed_work_item_ids: [
      ...new Set(ledger.entries.map((entry) => entry.work_item_id)),
    ].sort(compareCodeUnits),
    issues,
  };
}

/**
 * Remove accepted entries — the supported way back out of an acceptance.
 *
 * An accepted binding is skipped forever by {@link ingestAuditHostResults}, so
 * before this verb existed the only exit from a poisoned acceptance was editing
 * both files of the pair by hand. This runs under the SAME lock the writers use,
 * rewrites BOTH files together (they are one logical record), refuses a ledger
 * that fails the strict loader rather than truncating what it cannot validate,
 * records each removal on the shared submission ledger so a repaired run stays
 * distinguishable from a clean one, and invalidates the persisted step contract
 * — a stale live instruction may not survive a verb that mutates run state.
 */
export async function dropAcceptedResults(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  /** Work items to drop. Required unless {@link dropAcceptedResults.all}. */
  readonly workItemIds?: readonly string[];
  /** Drop EVERY entry. */
  readonly all?: boolean;
  /** See {@link prepareAuditHostHandoff}'s `logger`. */
  readonly logger?: RunLogger;
}): Promise<{ readonly dropped_work_item_ids: readonly string[] }> {
  if (params.all !== true && (params.workItemIds ?? []).length === 0) {
    throw new Error(
      "unaccept-results requires --work-item <id> (repeatable) or --all",
    );
  }
  const paths = resolveBoundaryPaths(params);
  const targets =
    params.all === true ? undefined : new Set(params.workItemIds ?? []);
  let droppedWorkItemIds: string[] = [];

  await withAcceptedResultsLock(paths, params.logger, async (current) => {
    if (current.entries.length === 0) return current;
    const isTarget = (workItemId: string) =>
      params.all === true ? true : (targets?.has(workItemId) ?? false);
    const kept = current.entries.filter(
      (entry) => !isTarget(entry.work_item_id),
    );
    droppedWorkItemIds = current.entries
      .filter((entry) => isTarget(entry.work_item_id))
      .map((entry) => entry.work_item_id);
    if (droppedWorkItemIds.length === 0) return current;
    await writeAcceptedResults(paths, {
      contract_version: ACCEPTED_RESULTS_CONTRACT_VERSION,
      run_id: params.runId,
      entries: kept,
    });
    return { ...current, entries: kept };
  });

  // Record each removal AFTER the pair is rewritten: the withdrawal must be on
  // the record even though the accepted pair no longer mentions the item.
  // Best-effort, like every other ledger write.
  try {
    for (const workItemId of droppedWorkItemIds) {
      await appendSubmissionEvent(paths.artifactsDir, {
        contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
        run_id: params.runId,
        submission_id: workItemId,
        lane: workItemId,
        kind: "removed_by_operator",
        message: "removed from the accepted results pair by unaccept-results",
        recorded_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    params.logger?.event?.({
      phase: "advance",
      kind: "error",
      note: `submission-ledger removal record failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  // Refresh-or-invalidate the persisted step contract: after mutating run state
  // there must be no stale live instruction left on disk. The next `next-step`
  // derives the real step fresh; until then the contract says blocked — through
  // the ONE shared blocked-step assembly, never a hand-built writer here.
  const reason =
    droppedWorkItemIds.length > 0
      ? `unaccept-results removed ${droppedWorkItemIds.length} accepted result(s) (${[...droppedWorkItemIds].sort().join(", ")}); run next-step to re-dispatch or re-ingest them`
      : "unaccept-results ran but no accepted entry matched; run next-step to continue";
  await writeBlockedStepContract({
    tool: "audit-code",
    contractVersion: "audit-code-step/v1alpha1",
    artifactsDir: paths.artifactsDir,
    repoRoot: paths.root,
    runId: null,
    reason,
  });

  return { dropped_work_item_ids: droppedWorkItemIds };
}
