import { createHash } from "node:crypto";
import {
  SEVERITIES,
  CONFIDENCES,
  severityRank,
  confidenceRank,
} from "audit-tools/shared";
import type { AuditResult, AuditTask, Finding, Lens } from "../../types.js";
import type { ExternalAnalyzerResults } from "../../types/externalAnalyzer.js";

// Shared primitives for the selective-deepening strategies. Each strategy
// module under this directory builds one kind of follow-up task; they all draw
// the ranks, id/hash helpers, path utilities, and tag/limit constants from
// here. The public entry (`buildSelectiveDeepeningTasks`) lives in `index.ts`.

export const DEEPENING_TAG = "selective_deepening";
export const LENS_VERIFICATION_TAG = "lens_verification";
export const LENS_VERIFICATION_FOLLOWUP_TAG = "lens_verification_followup";
export const MAX_LENS_VERIFICATION_FILES = 12;
export const MAX_LENS_VERIFICATION_RESULT_SUMMARIES = 12;
export const MAX_VERIFICATION_FOLLOWUP_TASKS_PER_RESULT = 4;
export const IMPORTANT_LENS_VERIFICATION_LENSES = new Set<Lens>([
  "security",
  "data_integrity",
  "reliability",
]);

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

export function priorityRank(priority: AuditTask["priority"]): number {
  switch (priority) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
    default:
      return 1;
  }
}

export interface BuildSelectiveDeepeningTaskOptions {
  existingTasks?: AuditTask[];
  results: AuditResult[];
  lineIndex?: Record<string, number>;
  runtimeValidationTasks?: import("../../types/runtimeValidation.js").RuntimeValidationTaskManifest;
  runtimeValidationReport?: import("../../types/runtimeValidation.js").RuntimeValidationReport;
  externalAnalyzerResults?: ExternalAnalyzerResults;
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

export function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 10);
}

function resultLineIndex(result: AuditResult): Record<string, number> {
  return Object.fromEntries(
    result.file_coverage.map((coverage) => [
      coverage.path,
      coverage.total_lines,
    ]),
  );
}

export function lineCountForPath(
  path: string,
  task: AuditTask | undefined,
  result: AuditResult,
  lineIndex?: Record<string, number>,
): number {
  return (
    task?.file_line_counts?.[path] ??
    resultLineIndex(result)[path] ??
    lineIndex?.[path] ??
    0
  );
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function intersects(left: string[], right: string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
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
  return `deepening:${prefix}:${shortHash(values.join("\0"))}`;
}

export function lineCountFromSources(
  path: string,
  tasks: AuditTask[],
  results: AuditResult[],
  lineIndex?: Record<string, number>,
): number {
  for (const task of tasks) {
    const count = task.file_line_counts?.[path];
    if (count !== undefined) {
      return count;
    }
  }

  for (const result of results) {
    const coverage = result.file_coverage.find((item) => item.path === path);
    if (coverage) {
      return coverage.total_lines;
    }
  }

  return lineIndex?.[path] ?? 0;
}

export function formatList(values: string[], maxItems: number): string {
  const visible = values.slice(0, maxItems);
  const suffix =
    values.length > maxItems ? `, ... (+${values.length - maxItems} more)` : "";
  return `${visible.join(", ")}${suffix}`;
}

export function priorityLabel(
  priority: AuditTask["priority"],
): NonNullable<AuditTask["priority"]> {
  return priority ?? "low";
}

export function getExternalAnalyzerPaths(
  externalAnalyzerResults?: ExternalAnalyzerResults,
): Set<string> {
  return new Set(
    (externalAnalyzerResults?.results ?? [])
      .map((result) =>
        result && typeof result.path === "string" && result.path.length > 0
          ? result.path
          : null,
      )
      .filter((path): path is string => path !== null),
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizedSuggestedPriority(
  value: unknown,
  fallback: NonNullable<AuditTask["priority"]> = "medium",
): NonNullable<AuditTask["priority"]> {
  return value === "high" || value === "medium" || value === "low"
    ? value
    : fallback;
}
