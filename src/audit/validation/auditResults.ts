import type { AuditResult, AuditTask, Finding } from "../types.js";
import {
  describeValue,
  formatValidationIssues,
  isRecord,
  VALID_LENSES,
  VALID_SEVERITIES,
  VALID_CONFIDENCES,
  type ValidationIssue,
} from "audit-tools/shared";

export type IssueSeverity = "error" | "warning";

export function normalizeCoveragePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export interface AuditResultIssue extends ValidationIssue {
  result_index: number;
  task_id: string;
  severity: IssueSeverity;
  field: string;
}

export interface ValidateAuditResultOptions {
  lineIndex?: Record<string, number>;
  /**
   * Packet/unit boundary file list: the union of the file_paths of every sibling
   * task dispatched in the same packet. When provided and non-empty, the two
   * hard-reject evidence gates (`file_coverage` paths and
   * `verification.followup_tasks.file_paths`) are widened from the single task's
   * assigned files to this boundary — a result may declare coverage of, or queue
   * a followup over, any file a sibling task in the packet was assigned, without
   * a hard reject. `affected_files` stays warn-and-retain regardless (INV-09).
   *
   * Fail-closed: an empty/undefined boundary falls back to the per-task assigned
   * set, so the gates never widen by accident.
   */
  boundaryPaths?: string[];
}

const REQUIRED_FINDING_FIELDS: Array<keyof Finding> = [
  "id",
  "title",
  "category",
  "severity",
  "confidence",
  "lens",
  "summary",
];

// Severity / confidence / lens validity now come from the canonical shared
// vocabulary (`audit-tools/shared`); previously each was re-defined here and
// drifted from the shared Lens / FindingSeverity / FindingConfidence types.
const VALID_PRIORITIES = new Set(["high", "medium", "low"]);
const LENS_VERIFICATION_TAG = "lens_verification";

function pushIssue(
  issues: AuditResultIssue[],
  params: Omit<AuditResultIssue, "severity" | "path"> & {
    path?: string;
    severity?: IssueSeverity;
  },
): void {
  issues.push({
    ...params,
    path: params.path ?? params.field,
    severity: params.severity ?? "error",
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issueTaskId(
  record: Record<string, unknown>,
  resultIndex: number,
): string {
  const taskId = record.task_id;
  return typeof taskId === "string" && taskId.trim().length > 0
    ? taskId
    : `result[${resultIndex}]`;
}

function validateRequiredStringField(
  value: unknown,
  label: string,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  if (typeof value !== "string") {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: label,
      message: `${label} must be a string, got ${describeValue(value)}.`,
    });
    return;
  }

  if (value.trim().length === 0) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: label,
      message: `${label} must not be empty.`,
    });
  }
}

function validateExpectedStringField(
  value: unknown,
  label: string,
  expected: string,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    return;
  }

  if (value !== expected) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: label,
      message:
        `${label} must match the assigned task metadata ` +
        `(expected '${expected}', got '${value}').`,
    });
  }
}

function validateFindingRequiredFields(
  finding: Record<string, unknown>,
  label: string,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  for (const field of REQUIRED_FINDING_FIELDS) {
    validateRequiredStringField(
      finding[field],
      `${label}.${field}`,
      taskId,
      resultIndex,
      issues,
    );
  }
}

function validateFindingEnums(
  finding: Record<string, unknown>,
  label: string,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  if (
    typeof finding.severity === "string" &&
    !VALID_SEVERITIES.has(finding.severity)
  ) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.severity`,
      message: `Invalid severity '${finding.severity}'. Must be one of: ${[...VALID_SEVERITIES].join(", ")}.`,
    });
  }

  if (
    typeof finding.confidence === "string" &&
    !VALID_CONFIDENCES.has(finding.confidence)
  ) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.confidence`,
      message: `Invalid confidence '${finding.confidence}'. Must be one of: ${[...VALID_CONFIDENCES].join(", ")}.`,
    });
  }

  if (typeof finding.lens === "string" && !VALID_LENSES.has(finding.lens)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.lens`,
      message: `Invalid lens '${finding.lens}'. Must be one of: ${[...VALID_LENSES].join(", ")}.`,
    });
  }
}

function validateAffectedFiles(
  finding: Record<string, unknown>,
  label: string,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  const affectedFiles = finding.affected_files;
  if (!Array.isArray(affectedFiles) || affectedFiles.length === 0) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.affected_files`,
      message: "affected_files must be a non-empty array.",
    });
    return;
  }
  for (let k = 0; k < affectedFiles.length; k++) {
    const item = affectedFiles[k];
    if (!isRecord(item)) {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}.affected_files[${k}]`,
        message: `affected_files[${k}] must be an object, got ${describeValue(item)}.`,
      });
      continue;
    }
    if (!isNonEmptyString(item.path)) {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}.affected_files[${k}].path`,
        message: "affected_files entry has an empty path.",
      });
    }
    if (
      item.line_start !== undefined &&
      !Number.isInteger(item.line_start)
    ) {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}.affected_files[${k}].line_start`,
        message: `affected_files[${k}].line_start must be an integer, got ${describeValue(item.line_start)}.`,
      });
    }
    if (
      item.line_end !== undefined &&
      !Number.isInteger(item.line_end)
    ) {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}.affected_files[${k}].line_end`,
        message: `affected_files[${k}].line_end must be an integer, got ${describeValue(item.line_end)}.`,
      });
    }
    if (
      Number.isInteger(item.line_start) &&
      Number.isInteger(item.line_end) &&
      Number(item.line_start) > Number(item.line_end)
    ) {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}.affected_files[${k}]`,
        message: "affected_files line_start must be less than or equal to line_end.",
      });
    }
  }
}

function validateEvidence(
  finding: Record<string, unknown>,
  label: string,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  const evidence = finding.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.evidence`,
      message:
        "evidence is empty — provide an array of plain strings such as \"src/foo.ts:42 - variable overwritten before use\".",
    });
    return;
  }
  let hasSubstantiveEntry = false;
  for (let k = 0; k < evidence.length; k++) {
    const entry = evidence[k];
    if (typeof entry !== "string") {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}.evidence[${k}]`,
        message: `evidence[${k}] must be a string, got ${describeValue(entry)}.`,
      });
      continue;
    }
    if (entry.trim().length > 0) {
      hasSubstantiveEntry = true;
    }
  }

  if (!hasSubstantiveEntry) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.evidence`,
      message: "All evidence entries are empty strings.",
    });
  }
}

// Thin orchestrator: validates one finding by delegating to the per-concern
// validators (object-shape, required strings, enums, affected_files, evidence),
// each of which pushes into the shared issues array. Behavior and messages are
// identical to the former single 165-line function.
function validateFinding(
  finding: unknown,
  label: string,
  taskId: string,
  resultIndex: number,
): AuditResultIssue[] {
  const issues: AuditResultIssue[] = [];

  if (!isRecord(finding)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: label,
      message: `${label} must be an object, got ${describeValue(finding)}.`,
    });
    return issues;
  }

  validateFindingRequiredFields(finding, label, taskId, resultIndex, issues);
  validateFindingEnums(finding, label, taskId, resultIndex, issues);
  validateAffectedFiles(finding, label, taskId, resultIndex, issues);
  validateEvidence(finding, label, taskId, resultIndex, issues);

  return issues;
}

function validateOptionalStringArray(
  value: unknown,
  label: string,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: label,
      message: `${label} must be an array of strings, got ${describeValue(value)}.`,
    });
    return;
  }
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== "string") {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}[${index}]`,
        message: `${label}[${index}] must be a string, got ${describeValue(value[index])}.`,
      });
    }
  }
}

function validateVerificationFollowupTask(
  task: unknown,
  label: string,
  taskId: string,
  resultIndex: number,
  expectedLens: unknown,
  allowedPaths: Set<string>,
  issues: AuditResultIssue[],
): void {
  if (!isRecord(task)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: label,
      message: `${label} must be an AuditTask object, got ${describeValue(task)}.`,
    });
    return;
  }

  for (const field of ["task_id", "unit_id", "pass_id", "lens", "rationale"]) {
    validateRequiredStringField(
      task[field],
      `${label}.${field}`,
      taskId,
      resultIndex,
      issues,
    );
  }

  if (typeof task.lens === "string" && !VALID_LENSES.has(task.lens)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.lens`,
      message: `Invalid lens '${task.lens}'. Must be one of: ${[...VALID_LENSES].join(", ")}.`,
    });
  }
  if (
    typeof expectedLens === "string" &&
    typeof task.lens === "string" &&
    task.lens !== expectedLens
  ) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.lens`,
      message:
        `${label}.lens must match the lens verification task ` +
        `(expected '${expectedLens}', got '${task.lens}').`,
    });
  }

  if (
    task.priority !== undefined &&
    (typeof task.priority !== "string" || !VALID_PRIORITIES.has(task.priority))
  ) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.priority`,
      message: `${label}.priority must be one of: ${[...VALID_PRIORITIES].join(", ")}.`,
    });
  }

  if (!Array.isArray(task.file_paths) || task.file_paths.length === 0) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `${label}.file_paths`,
      message: `${label}.file_paths must be a non-empty array.`,
    });
  } else {
    for (let index = 0; index < task.file_paths.length; index++) {
      const path = task.file_paths[index];
      if (!isNonEmptyString(path)) {
        pushIssue(issues, {
          result_index: resultIndex,
          task_id: taskId,
          field: `${label}.file_paths[${index}]`,
          message: `${label}.file_paths[${index}] must be a non-empty string.`,
        });
        continue;
      }
      if (!allowedPaths.has(path)) {
        pushIssue(issues, {
          result_index: resultIndex,
          task_id: taskId,
          field: `${label}.file_paths[${index}]`,
          message:
            `${label}.file_paths[${index}] references '${path}', which is outside the verification task's file_coverage. ` +
            `Followup tasks list files in 'file_paths' (array of strings), not 'file_coverage'; allowed: ${[...allowedPaths].join(", ")}.`,
        });
      }
    }
  }

  validateOptionalStringArray(
    task.tags,
    `${label}.tags`,
    taskId,
    resultIndex,
    issues,
  );
}

function validateVerification(
  value: unknown,
  result: Record<string, unknown>,
  task: AuditTask | undefined,
  coverage: NormalizedFileCoverage[],
  normBoundary: Set<string>,
  taskId: string,
  resultIndex: number,
  issues: AuditResultIssue[],
): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "verification",
      message: `verification must be an object, got ${describeValue(value)}.`,
    });
    return;
  }

  if (typeof value.verified !== "boolean") {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "verification.verified",
      message: `verification.verified must be a boolean, got ${describeValue(value.verified)}.`,
    });
  }
  if (typeof value.needs_followup !== "boolean") {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "verification.needs_followup",
      message: `verification.needs_followup must be a boolean, got ${describeValue(value.needs_followup)}.`,
    });
  }

  if (task && !task.tags?.includes(LENS_VERIFICATION_TAG)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "verification",
      message: "verification is intended only for tasks tagged lens_verification.",
      severity: "warning",
    });
  }

  validateOptionalStringArray(
    value.concerns,
    "verification.concerns",
    taskId,
    resultIndex,
    issues,
  );
  validateOptionalStringArray(
    value.coverage_concerns,
    "verification.coverage_concerns",
    taskId,
    resultIndex,
    issues,
  );
  validateOptionalStringArray(
    value.confidence_concerns,
    "verification.confidence_concerns",
    taskId,
    resultIndex,
    issues,
  );

  if (value.followup_tasks === undefined) {
    return;
  }
  if (!Array.isArray(value.followup_tasks)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "verification.followup_tasks",
      message: `verification.followup_tasks must be an array, got ${describeValue(value.followup_tasks)}.`,
    });
    return;
  }

  // Followup tasks may target any file within the packet/unit boundary, not just
  // the assigned files surfaced in this result's coverage. Widen the allowed set
  // with the boundary (fail-closed: an empty boundary adds nothing, leaving the
  // gate at the per-result coverage paths).
  const allowedPaths = new Set([
    ...coverage.map((entry) => entry.path),
    ...normBoundary,
  ]);
  for (let index = 0; index < value.followup_tasks.length; index++) {
    validateVerificationFollowupTask(
      value.followup_tasks[index],
      `verification.followup_tasks[${index}]`,
      taskId,
      resultIndex,
      result.lens,
      allowedPaths,
      issues,
    );
  }
}

interface NormalizedFileCoverage {
  path: string;
  total_lines: number;
}

function coversAffectedSpan(
  coverage: NormalizedFileCoverage[],
  path: string,
  start: number,
  end: number,
): boolean {
  return coverage.some(
    (entry) =>
      entry.path === path &&
      start > 0 &&
      end > 0 &&
      end <= entry.total_lines,
  );
}

/** Context threaded through per-result validation helpers. */
interface ResultValidationContext {
  result: Record<string, unknown>;
  task: AuditTask | undefined;
  taskId: string;
  resultIndex: number;
  taskNormMap: Map<string, string>;
  normLineIndex: Map<string, number>;
  allTasks: AuditTask[];
  /**
   * Normalized packet/unit boundary paths (union of sibling task file_paths).
   * Empty when no boundary was supplied → gates fail closed to the per-task
   * assigned set.
   */
  normBoundary: Set<string>;
}

function validateResultIdentityFields(ctx: ResultValidationContext, issues: AuditResultIssue[]): void {
  const { result, task, taskId, resultIndex, allTasks } = ctx;
  validateRequiredStringField(result.task_id, "task_id", taskId, resultIndex, issues);
  validateRequiredStringField(result.unit_id, "unit_id", taskId, resultIndex, issues);
  validateRequiredStringField(result.pass_id, "pass_id", taskId, resultIndex, issues);
  validateRequiredStringField(result.lens, "lens", taskId, resultIndex, issues);

  if (typeof result.lens === "string" && !VALID_LENSES.has(result.lens)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "lens",
      message: `Invalid lens '${result.lens}'. Must be one of: ${[...VALID_LENSES].join(", ")}.`,
    });
  }

  if (task) {
    validateExpectedStringField(result.unit_id, "unit_id", task.unit_id, taskId, resultIndex, issues);
    validateExpectedStringField(result.pass_id, "pass_id", task.pass_id, taskId, resultIndex, issues);
    validateExpectedStringField(result.lens, "lens", task.lens, taskId, resultIndex, issues);
  }

  if (allTasks.length > 0 && !task) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "task_id",
      message:
        `Unknown task_id '${taskId}'. Use the active task manifest for valid ids: ` +
        allTasks.map((item) => item.task_id).join(", "),
    });
  }
}

function validateFileCoverageEntry(
  entry: unknown,
  j: number,
  ctx: ResultValidationContext,
  seenCoveragePaths: Set<string>,
  declaredAssignedCoveragePaths: Set<string>,
  normalizedFileCoverage: NormalizedFileCoverage[],
  issues: AuditResultIssue[],
): void {
  const { task, taskId, resultIndex, taskNormMap, normLineIndex, normBoundary } = ctx;
  if (!isRecord(entry)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `file_coverage[${j}]`,
      message: `file_coverage[${j}] must be an object, got ${describeValue(entry)}.`,
    });
    return;
  }

  const entryNorm = isNonEmptyString(entry.path) ? normalizeCoveragePath(entry.path as string) : "";
  const canonicalPath = taskNormMap.get(entryNorm);
  // Widen the hard-reject gate from the per-task assigned set to the packet/unit
  // boundary (union of sibling task file_paths). A coverage path the assigned
  // task didn't list, but a sibling in the packet did, is accepted rather than
  // hard-rejected. Fail-closed: an empty boundary leaves only assigned paths in
  // scope. `inBoundary` is the normalized boundary path used downstream so the
  // span-coverage check can reference in-boundary coverage entries.
  const inBoundary = entryNorm.length > 0 && normBoundary.has(entryNorm);
  const acceptedPath = canonicalPath ?? (inBoundary ? entryNorm : undefined);

  if (!isNonEmptyString(entry.path)) {
    pushIssue(issues, { result_index: resultIndex, task_id: taskId, field: `file_coverage[${j}].path`, message: "file_coverage entry has an empty path." });
  } else if (task && !acceptedPath) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `file_coverage[${j}].path`,
      message: `file_coverage path '${entry.path}' is not listed in the task file_paths. Declare only assigned files; allowed for this task: ${task.file_paths.join(", ")}.`,
    });
  } else if (seenCoveragePaths.has(entryNorm)) {
    pushIssue(issues, { result_index: resultIndex, task_id: taskId, field: `file_coverage[${j}].path`, message: `file_coverage path '${entry.path}' is duplicated. Declare each file once.` });
  } else {
    seenCoveragePaths.add(entryNorm);
  }

  if (entryNorm.length > 0 && (!task || acceptedPath)) {
    declaredAssignedCoveragePaths.add(acceptedPath ?? entryNorm);
  }

  if (!Number.isInteger(entry.total_lines)) {
    pushIssue(issues, { result_index: resultIndex, task_id: taskId, field: `file_coverage[${j}].total_lines`, message: `file_coverage[${j}].total_lines must be an integer, got ${describeValue(entry.total_lines)}.` });
  }
  if (Number.isInteger(entry.total_lines) && Number(entry.total_lines) < 0) {
    pushIssue(issues, { result_index: resultIndex, task_id: taskId, field: `file_coverage[${j}].total_lines`, message: "file_coverage total_lines must be zero or greater." });
  }
  const expectedLineCount = entryNorm.length > 0 ? normLineIndex.get(entryNorm) : undefined;
  if (Number.isInteger(entry.total_lines) && typeof expectedLineCount === "number" && Number(entry.total_lines) !== expectedLineCount) {
    // Advisory only (S7 anti-hallucination): total_lines is a coverage stat, not
    // a proof of reading. A matching line count attests breadth, is gameable
    // (read the count from a listing, never open the body), and proves nothing
    // about whether a finding is true — findings are now grounded by
    // quote-and-verify (`quoteGrounding.ts`), so this mismatch is a warning, not
    // a gate.
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: `file_coverage[${j}].total_lines`,
      message: `file_coverage[${j}].total_lines does not match the current line count for '${entry.path}' (expected ${expectedLineCount}, got ${entry.total_lines}). Advisory coverage stat — findings are grounded by quote-and-verify, not by this count.`,
      severity: "warning",
    });
  }

  if (entryNorm.length > 0 && Number.isInteger(entry.total_lines) && Number(entry.total_lines) >= 0 && (!task || acceptedPath)) {
    normalizedFileCoverage.push({ path: acceptedPath ?? entryNorm, total_lines: Number(entry.total_lines) });
  }
}

/**
 * Validate the file_coverage array of a single result.
 * Returns the normalized coverage entries and declared assigned path set.
 */
function validateResultFileCoverage(
  ctx: ResultValidationContext,
  issues: AuditResultIssue[],
): { normalizedFileCoverage: NormalizedFileCoverage[]; declaredAssignedCoveragePaths: Set<string> } {
  const { result, task, taskId, resultIndex } = ctx;
  const fileCoverage = result.file_coverage;
  const normalizedFileCoverage: NormalizedFileCoverage[] = [];
  const declaredAssignedCoveragePaths = new Set<string>();

  if (!Array.isArray(fileCoverage) || fileCoverage.length === 0) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: taskId,
      field: "file_coverage",
      message: "file_coverage is empty — each result must declare every assigned file it reviewed and the file's total line count.",
    });
    return { normalizedFileCoverage, declaredAssignedCoveragePaths };
  }

  const seenCoveragePaths = new Set<string>();
  for (let j = 0; j < fileCoverage.length; j++) {
    validateFileCoverageEntry(fileCoverage[j], j, ctx, seenCoveragePaths, declaredAssignedCoveragePaths, normalizedFileCoverage, issues);
  }

  if (task) {
    for (const path of task.file_paths) {
      if (!seenCoveragePaths.has(normalizeCoveragePath(path))) {
        pushIssue(issues, { result_index: resultIndex, task_id: taskId, field: "file_coverage", message: `file_coverage must include every assigned file. Missing '${path}'.` });
      }
    }
  }

  return { normalizedFileCoverage, declaredAssignedCoveragePaths };
}

function validateResultFindings(
  ctx: ResultValidationContext,
  normalizedFileCoverage: NormalizedFileCoverage[],
  declaredAssignedCoveragePaths: Set<string>,
  issues: AuditResultIssue[],
): boolean {
  const { result, task, taskId, resultIndex } = ctx;
  const findings = result.findings;
  if (!Array.isArray(findings)) {
    pushIssue(issues, { result_index: resultIndex, task_id: taskId, field: "findings", message: `findings must be an array, got ${describeValue(findings)}.` });
    return false; // signal to skip verification
  }

  for (let j = 0; j < findings.length; j++) {
    const label = `findings[${j}]`;
    const finding = findings[j];
    issues.push(...validateFinding(finding, label, taskId, resultIndex));

    if (!isRecord(finding) || !Array.isArray(finding.affected_files)) continue;

    const expectedFindingLens =
      task?.lens ??
      (typeof result.lens === "string" && VALID_LENSES.has(result.lens) ? result.lens : undefined);
    if (expectedFindingLens && typeof finding.lens === "string" && finding.lens !== expectedFindingLens) {
      pushIssue(issues, {
        result_index: resultIndex,
        task_id: taskId,
        field: `${label}.lens`,
        message: `${label}.lens must match the assigned task lens (expected '${expectedFindingLens}', got '${finding.lens}').`,
      });
    }

    for (let k = 0; k < finding.affected_files.length; k++) {
      const affected = finding.affected_files[k];
      if (!isRecord(affected) || !isNonEmptyString(affected.path)) continue;
      const affectedPathNorm = normalizeCoveragePath(affected.path as string);
      if (!declaredAssignedCoveragePaths.has(affectedPathNorm)) {
        // Out-of-scope: warn but retain the finding (INV-09 / FRIC-010).
        pushIssue(issues, {
          result_index: resultIndex,
          task_id: taskId,
          field: `${label}.affected_files[${k}].path`,
          severity: "warning",
          message:
            `affected_files path '${affected.path}' is not in the declared assigned file_coverage (out-of-scope). ` +
            `In-scope findings are retained; this entry is informational only.` +
            (task ? ` The task's assigned files are: ${task.file_paths.join(", ")}.` : ""),
        });
        continue;
      }
      if (!Number.isInteger(affected.line_start)) continue;
      const start = Number(affected.line_start);
      const end = Number.isInteger(affected.line_end) ? Number(affected.line_end) : start;
      if (!coversAffectedSpan(normalizedFileCoverage, affectedPathNorm, start, end)) {
        pushIssue(issues, {
          result_index: resultIndex,
          task_id: taskId,
          field: `${label}.affected_files[${k}]`,
          message:
            `affected_files line span ${affected.path}:${start}-${end} falls outside the declared file_coverage. ` +
            "Fix the affected_files location or correct file_coverage.total_lines.",
        });
      }
    }
  }

  return true;
}

/** Validate a single result record; push issues into `issues`. */
function validateSingleAuditResult(
  result: unknown,
  resultIndex: number,
  taskMap: Map<string, AuditTask>,
  allTasks: AuditTask[],
  normLineIndex: Map<string, number>,
  normBoundary: Set<string>,
  issues: AuditResultIssue[],
): void {
  if (!isRecord(result)) {
    pushIssue(issues, {
      result_index: resultIndex,
      task_id: `result[${resultIndex}]`,
      field: `results[${resultIndex}]`,
      message: `Each audit result must be an object, got ${describeValue(result)}.`,
    });
    return;
  }

  const taskId = issueTaskId(result, resultIndex);
  const task = taskMap.get(taskId);

  const taskNormMap = new Map<string, string>();
  if (task) {
    for (const fp of task.file_paths) {
      taskNormMap.set(normalizeCoveragePath(fp), fp);
    }
  }

  const ctx: ResultValidationContext = { result, task, taskId, resultIndex, taskNormMap, normLineIndex, allTasks, normBoundary };

  validateResultIdentityFields(ctx, issues);

  const { normalizedFileCoverage, declaredAssignedCoveragePaths } = validateResultFileCoverage(ctx, issues);

  const findingsOk = validateResultFindings(ctx, normalizedFileCoverage, declaredAssignedCoveragePaths, issues);
  if (!findingsOk) return;

  validateVerification(result.verification, result, task, normalizedFileCoverage, normBoundary, taskId, resultIndex, issues);
}

export function validateAuditResults(
  results: unknown,
  tasks: AuditTask[],
  options: ValidateAuditResultOptions = {},
): AuditResultIssue[] {
  const issues: AuditResultIssue[] = [];

  if (!Array.isArray(results)) {
    pushIssue(issues, {
      result_index: -1,
      task_id: "results",
      field: "results",
      message: `Audit results payload must be a JSON array, got ${describeValue(results)}.`,
    });
    return issues;
  }

  const taskMap = new Map(tasks.map((task) => [task.task_id, task]));
  const normLineIndex = new Map<string, number>();
  if (options.lineIndex) {
    for (const [k, v] of Object.entries(options.lineIndex)) {
      normLineIndex.set(normalizeCoveragePath(k), v);
    }
  }

  // Packet/unit boundary (union of sibling task file_paths) for widening the
  // two hard-reject evidence gates. Fail-closed: undefined/empty → no widening.
  const normBoundary = new Set<string>();
  for (const path of options.boundaryPaths ?? []) {
    if (isNonEmptyString(path)) {
      normBoundary.add(normalizeCoveragePath(path));
    }
  }

  for (let i = 0; i < results.length; i++) {
    validateSingleAuditResult(results[i], i, taskMap, tasks, normLineIndex, normBoundary, issues);
  }

  if (issues.length > 0) {
    const errors = issues.filter((i) => i.severity === "error").length;
    const warnings = issues.filter((i) => i.severity === "warning").length;
    process.stderr.write(
      `[audit-results validation] ${errors} error(s), ${warnings} warning(s) across ${results.length} result(s)\n`,
    );
  }

  return issues;
}

export function formatAuditResultIssues(issues: AuditResultIssue[]): string {
  return formatValidationIssues(
    issues.map((issue) => ({
      path: `${issue.task_id} / ${issue.field}`,
      message: issue.message,
      severity: issue.severity,
    })),
  );
}
