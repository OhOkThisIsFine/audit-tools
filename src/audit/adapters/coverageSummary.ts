import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { normalizeGenericExternalResults } from "./normalizeExternal.js";

/** Minimum acceptable line coverage percentage; files below this are flagged. */
const COVERAGE_THRESHOLD_LOW = 80;
/** Line coverage percentage below which severity is escalated to "high" (otherwise "medium"). */
const COVERAGE_SEVERITY_HIGH = 50;

interface CoverageFileSummary {
  path: string;
  lines_pct: number;
  branches_pct?: number;
}

export function normalizeCoverageSummary(
  files: CoverageFileSummary[],
): ExternalAnalyzerResults {
  return normalizeGenericExternalResults(
    "coverage-summary",
    files
      .filter((file) => file.lines_pct < COVERAGE_THRESHOLD_LOW)
      .map((file, index) => ({
        id: `coverage-${index + 1}`,
        category: "tests",
        severity: file.lines_pct < COVERAGE_SEVERITY_HIGH ? "high" : "medium",
        path: file.path,
        summary: `Low line coverage: ${file.lines_pct}%${typeof file.branches_pct === "number" ? `, branch coverage ${file.branches_pct}%` : ""}.`,
        raw: file,
      })),
  );
}
