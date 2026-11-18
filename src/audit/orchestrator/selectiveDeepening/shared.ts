// sites-pinned: tests/audit/lens-steward-surface.test.ts, tests/audit/orchestrator-remediation.test.ts
import {
  SEVERITIES,
  CONFIDENCES,
  severityRank,
  confidenceRank,
  hashContent,
  uniqueSorted,
} from "audit-tools/shared";
import type { AuditResult, AuditTask, Finding } from "../../types.js";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type {
  RuntimeValidationReport,
  RuntimeValidationTaskManifest,
} from "../../types/runtimeValidation.js";

// Shared primitives for the selective-deepening strategies. Each strategy
// module under this directory builds one kind of follow-up task; they all draw
// the ranks, id/hash helpers, path utilities, and tag/limit constants from
// here. The public entry (`buildSelectiveDeepeningTasks`) lives in `index.ts`.

export const DEEPENING_TAG = "selective_deepening";
export const LENS_VERIFICATION_TAG = "lens_verification";
export const LENS_VERIFICATION_FOLLOWUP_TAG = "lens_verification_followup";
// There is deliberately NO cap on a lens steward's file list or on its source
// summaries. A steward is granted the whole surface its lens was applied to, and
// it chooses what to review — see `coverage_policy` on `AuditTask` and
// `docs/reviews/lens-steward-redesign-2026-09-17.md`. The two caps that used to
// live here — both 12, one over the file list and one over the source summaries
// (named in that review; deliberately unbackticked, because a comment citing a
// deleted symbol is what the comment-drift gate exists to refuse) — counted
// FILES, which measures no cost the tool cares about.
export const MAX_VERIFICATION_FOLLOWUP_TASKS_PER_RESULT = 4;

// Derived from the shared single-source rank functions (no hand-copied table).
// Kept as Record lookups because consumers index by severity/confidence AND
// reference named levels (e.g. SEVERITY_RANK.high) as a priority threshold.
export const SEVERITY_RANK: Record<Finding["severity"], number> =
  Object.fromEntries(SEVERITIES.map((s) => [s, severityRank(s)])) as Record<
    Finding["severity"],
    number
  >;

export const CONFIDENCE_RANK: Record<Finding["confidence"], number> =
  Object.fromEntries(CONFIDENCES.map((c) => [c, confidenceRank(c)])) as Record<
    Finding["confidence"],
    number
  >;

export interface BuildSelectiveDeepeningTaskOptions {
  existingTasks?: AuditTask[];
  results: AuditResult[];
  lineIndex?: Record<string, number>;
  runtimeValidationTasks?: RuntimeValidationTaskManifest;
  runtimeValidationReport?: RuntimeValidationReport;
  externalAnalyzerResults?: ExternalAnalyzerResults[];
}

export interface FindingContext {
  result: AuditResult;
  task?: AuditTask;
  finding: Finding;
  paths: string[];
}

export function isDeepeningTask(task: AuditTask | undefined): boolean {
  return task?.tags?.includes(DEEPENING_TAG) ?? false;
}

export function isLensVerificationTask(task: AuditTask | undefined): boolean {
  return task?.tags?.includes(LENS_VERIFICATION_TAG) ?? false;
}

export function sanitizeSegment(value: string): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "followup";
}

/** Whether any of `values` is in `set`; the caller builds the set once per comparison target. */
export function intersects(
  values: readonly string[],
  set: ReadonlySet<string>,
): boolean {
  return values.some((value) => set.has(value));
}

/**
 * The files a follow-up on one result re-reads: the task's assigned paths, or
 * the result's covered paths when the task assigned none.
 */
export function assignedOrCoveredPaths(
  result: AuditResult,
  task: AuditTask | undefined,
): string[] {
  return uniqueSorted(
    task?.file_paths && task.file_paths.length > 0
      ? task.file_paths
      : result.file_coverage.map((coverage) => coverage.path),
  );
}

export function pathsForFinding(
  finding: Finding,
  result: AuditResult,
  task: AuditTask | undefined,
): string[] {
  const assignedPaths = new Set([
    ...(task?.file_paths ?? []),
    ...result.file_coverage.map((coverage) => coverage.path),
  ]);
  const affected = finding.affected_files
    .map((file) => file.path)
    .filter((path) => assignedPaths.size === 0 || assignedPaths.has(path));
  return uniqueSorted(
    affected.length > 0
      ? affected
      : result.file_coverage.map((coverage) => coverage.path),
  );
}

export function taskIdFor(prefix: string, values: string[]): string {
  // The truncated digest routes through the shared hash home. Length is
  // explicit per hashContent's contract; a bare `.slice(0, N)` on an inline
  // createHash chain is the banned construction (check:shared-primitives).
  return `deepening:${prefix}:${hashContent(values.join("\0"), { length: 10 })}`;
}

export function formatList(values: string[], maxItems: number): string {
  const visible = values.slice(0, maxItems);
  const suffix =
    values.length > maxItems ? `, ... (+${values.length - maxItems} more)` : "";
  return `${visible.join(", ")}${suffix}`;
}

/** A host-suggested priority when it names a known level, else `medium`. */
export function normalizedSuggestedPriority(
  value: unknown,
): NonNullable<AuditTask["priority"]> {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : "medium";
}
