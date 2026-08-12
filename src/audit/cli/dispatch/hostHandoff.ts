import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  FindingSchema,
  assertSubmissionRunId,
  hashContent,
  isFileMissingError,
  readJsonFile,
  readSubmissionDocument,
  repoRelativePath,
  resolveContainedPath,
  stableStringify,
  submissionPathFor,
  writeJsonFile,
  type SubmissionIssue,
} from "audit-tools/shared";
import { AuditResultSchema, type AuditResult } from "../../types.js";

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
  readonly issues: readonly SubmissionIssue[];
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
  readonly findings: readonly unknown[];
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
  readonly artifactsDir: string;
  readonly runDir: string;
  readonly resultDir: string;
  readonly workloadPath: string;
  readonly resultMapPath: string;
  readonly taskBindingsPath: string;
  readonly acceptedLedgerPath: string;
  readonly acceptedResultsPath: string;
}

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
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort(compareCodeUnits)[index])
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function resolveBoundaryPaths(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
}): ResolvedBoundaryPaths {
  assertSubmissionRunId(params.runId, "audit host run id");
  const root = resolve(params.root);
  const artifactsDir = resolveContainedPath(root, params.artifactsDir, "artifactsDir");
  const runDir = resolveContainedPath(
    artifactsDir,
    join("runs", params.runId),
    "audit host run directory",
  );
  return {
    root,
    artifactsDir,
    runDir,
    resultDir: join(runDir, "host-results"),
    workloadPath: join(runDir, "host-workload.json"),
    resultMapPath: join(runDir, "host-result-map.json"),
    taskBindingsPath: join(runDir, "host-task-bindings.json"),
    acceptedLedgerPath: join(runDir, "host-accepted-results-ledger.json"),
    acceptedResultsPath: join(runDir, "host-accepted-results.json"),
  };
}

/**
 * The bound path for one work item's submission — the SHARED rule, not a local
 * copy of it. The audit and remediate handoffs both derived
 * `<resultDir>/<sha256(id)>.json` in their own private helpers; a divergence
 * between the two would have been silent on both sides.
 */
function resultPathFor(
  paths: ResolvedBoundaryPaths,
  workItemId: string,
): string {
  return submissionPathFor(
    { root: paths.root, submissionDir: paths.resultDir },
    workItemId,
  );
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
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
    "Each file_coverage entry must contain exactly path, reviewed_lines, and total_lines; findings must satisfy the audit finding contract.",
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
      sha256: hashContent(promptText),
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
    value.result_sha256 === hashContent(stableStringify(value.result)) &&
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
  const identities = new Set<string>();
  for (const entry of value.entries) {
    const identity = `${entry.work_item_id}\u0000${entry.prompt_sha256}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate accepted audit host result binding: ${entry.work_item_id}`);
    }
    identities.add(identity);
  }
  return value as unknown as AcceptedResultsLedger;
}

function bindingIdentity(entry: {
  readonly work_item_id: string;
  readonly prompt_sha256: string;
}): string {
  return `${entry.work_item_id}\u0000${entry.prompt_sha256}`;
}

export async function prepareAuditHostHandoff(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly tasks: readonly AuditHostTask[];
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

  const accepted = await loadAcceptedResults(
    paths.acceptedLedgerPath,
    params.runId,
  );
  const acceptedBindings = new Set(accepted.entries.map(bindingIdentity));
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

  await mkdir(paths.resultDir, { recursive: true });
  await writeJsonFile(paths.taskBindingsPath, taskBindings);
  await writeJsonFile(
    paths.acceptedResultsPath,
    accepted.entries.map((entry) => entry.audit_result),
  );
  await writeJsonFile(paths.acceptedLedgerPath, accepted);
  await writeJsonFile(paths.workloadPath, workload);
  await writeJsonFile(paths.resultMapPath, resultMap);
  return {
    workload,
    result_map: resultMap,
    workload_path: paths.workloadPath,
    result_map_path: paths.resultMapPath,
  };
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
    hashContent(value.prompt.text) !== value.prompt.sha256 ||
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
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["contract_version", "run_id", "work_items"]) ||
    value.contract_version !== WORKLOAD_CONTRACT_VERSION ||
    value.run_id !== runId ||
    !Array.isArray(value.work_items)
  ) {
    throw new Error("Invalid audit host workload");
  }
  const workItems = value.work_items.map(parseWorkItem);
  if (workItems.some((entry) => entry === null)) {
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
      Object.keys(binding.file_line_counts).sort(compareCodeUnits).join("\u0000") !==
        [...item.scope.files].sort(compareCodeUnits).join("\u0000")
    ) {
      throw new Error(`Invalid audit host task binding: ${item.id}`);
    }
    items.set(item.id, item);
  }
  if (resultMap.entries.length !== items.size) {
    throw new Error("Audit host result map does not cover the workload exactly");
  }
  const mapped = new Set<string>();
  for (const entry of resultMap.entries) {
    const item = items.get(entry.work_item_id);
    if (
      item === undefined ||
      mapped.has(entry.work_item_id) ||
      entry.prompt_sha256 !== item.prompt.sha256 ||
      entry.result_path !== item.result_path
    ) {
      throw new Error(`Invalid audit host result binding: ${entry.work_item_id}`);
    }
    mapped.add(entry.work_item_id);
  }
  return items;
}

function parseHostResult(
  value: unknown,
  runId: string,
  item: AuditHostWorkItem,
  binding: AuditHostTaskBinding,
): AuditHostResult | null {
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
    value.result_id.length === 0 ||
    value.run_id !== runId ||
    value.work_item_id !== item.id ||
    value.prompt_sha256 !== item.prompt.sha256 ||
    !Array.isArray(value.file_coverage) ||
    !Array.isArray(value.findings) ||
    !value.findings.every((finding) => FindingSchema.safeParse(finding).success)
  ) {
    return null;
  }
  const coveragePaths = new Set<string>();
  for (const coverage of value.file_coverage) {
    if (
      !isRecord(coverage) ||
      !hasExactKeys(coverage, ["path", "reviewed_lines", "total_lines"]) ||
      typeof coverage.path !== "string" ||
      coveragePaths.has(coverage.path) ||
      !Number.isInteger(coverage.reviewed_lines) ||
      !Number.isInteger(coverage.total_lines) ||
      (coverage.reviewed_lines as number) < 0 ||
      coverage.reviewed_lines !== coverage.total_lines ||
      coverage.total_lines !== binding.file_line_counts[coverage.path]
    ) {
      return null;
    }
    coveragePaths.add(coverage.path);
  }
  if (
    coveragePaths.size !== item.scope.files.length ||
    item.scope.files.some((path) => !coveragePaths.has(path))
  ) {
    return null;
  }
  return JSON.parse(stableStringify(value)) as AuditHostResult;
}

function toAuditResult(
  result: AuditHostResult,
  binding: AuditHostTaskBinding,
): AuditResult | null {
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
    findings: result.findings,
    reviewed_clean: result.findings.length === 0,
    run_id: result.run_id,
  });
  return parsed.success ? parsed.data : null;
}

/** A submission read that either yielded a valid result or says why not. */
type SubmittedResultOutcome =
  | { readonly ok: true; readonly result: AuditHostResult }
  | { readonly ok: false; readonly issue: SubmissionIssue };

/**
 * Read one bound submission and CLASSIFY the outcome. Every failure names
 * itself and the bound path it looked at; nothing collapses to `null`.
 */
async function readSubmittedResult(
  absolutePath: string,
  boundPath: string,
  runId: string,
  item: AuditHostWorkItem,
  binding: AuditHostTaskBinding,
): Promise<SubmittedResultOutcome> {
  const locators = { work_item_id: item.id, result_path: boundPath } as const;
  const read = await readSubmissionDocument(absolutePath);
  if (read.kind === "missing") {
    return {
      ok: false,
      issue: {
        code: "submission_missing",
        message: `work item '${item.id}' submitted nothing at its bound path`,
        ...locators,
      },
    };
  }
  if (read.kind === "malformed") {
    return {
      ok: false,
      issue: {
        code: "submission_malformed",
        message: `work item '${item.id}' submitted bytes that are not JSON: ${read.detail}`,
        ...locators,
      },
    };
  }
  const result = parseHostResult(read.value, runId, item, binding);
  if (result === null) {
    return {
      ok: false,
      issue: {
        code: "submission_contract_invalid",
        message:
          `work item '${item.id}' submitted JSON that does not satisfy the audit host ` +
          `result contract (identity, prompt binding, or file coverage)`,
        ...locators,
      },
    };
  }
  return { ok: true, result };
}

export async function ingestAuditHostResults(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
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
  const issues: SubmissionIssue[] = [];

  for (const entry of resultMap.entries) {
    if (acceptedBindings.has(bindingIdentity(entry))) continue;
    const item = items.get(entry.work_item_id);
    const binding = taskBindings.get(entry.work_item_id);
    if (item === undefined || binding === undefined) continue;
    const absoluteResultPath = resolveContainedPath(
      paths.root,
      entry.result_path,
      `result path for ${entry.work_item_id}`,
    );
    const outcome = await readSubmittedResult(
      absoluteResultPath,
      entry.result_path,
      params.runId,
      item,
      binding,
    );
    if (!outcome.ok) {
      issues.push(outcome.issue);
      continue;
    }
    const result = outcome.result;
    if (resultIds.has(result.result_id)) {
      issues.push({
        code: "duplicate_submission_id",
        message:
          `work item '${entry.work_item_id}' submitted result id '${result.result_id}', ` +
          `which this run has already accepted`,
        work_item_id: entry.work_item_id,
        result_path: entry.result_path,
      });
      continue;
    }
    const auditResult = toAuditResult(result, binding);
    if (auditResult === null) {
      issues.push({
        code: "submission_contract_invalid",
        message:
          `work item '${entry.work_item_id}' submitted a result that does not convert to ` +
          `an AuditResult (coverage or finding shape)`,
        work_item_id: entry.work_item_id,
        result_path: entry.result_path,
      });
      continue;
    }
    resultIds.add(result.result_id);
    additions.push({
      work_item_id: entry.work_item_id,
      prompt_sha256: entry.prompt_sha256,
      result_path: entry.result_path,
      result_id: result.result_id,
      result_sha256: hashContent(stableStringify(result)),
      result,
      audit_result: auditResult,
    });
  }

  let ledger = accepted;
  if (additions.length > 0) {
    ledger = {
      contract_version: ACCEPTED_RESULTS_CONTRACT_VERSION,
      run_id: params.runId,
      entries: [...accepted.entries, ...additions].sort((left, right) => {
        const item = compareCodeUnits(left.work_item_id, right.work_item_id);
        return item !== 0
          ? item
          : compareCodeUnits(left.prompt_sha256, right.prompt_sha256);
      }),
    };
    await writeJsonFile(
      paths.acceptedResultsPath,
      ledger.entries.map((entry) => entry.audit_result),
    );
    await writeJsonFile(paths.acceptedLedgerPath, ledger);
  }

  return {
    accepted_count: additions.length,
    accepted_results: ledger.entries.map((entry) => entry.audit_result),
    accepted_results_path: paths.acceptedResultsPath,
    completed_work_item_ids: [
      ...new Set(ledger.entries.map((entry) => entry.work_item_id)),
    ].sort(compareCodeUnits),
    issues,
  };
}
