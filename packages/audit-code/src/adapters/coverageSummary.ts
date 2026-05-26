import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { normalizeGenericExternalResults } from "./normalizeExternal.js";

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
      .filter((file) => file.lines_pct < 80)
      .map((file, index) => ({
        id: `coverage-${index + 1}`,
        category: "tests",
        severity: file.lines_pct < 50 ? "high" : "medium",
        path: file.path,
        summary: `Low line coverage: ${file.lines_pct}%${typeof file.branches_pct === "number" ? `, branch coverage ${file.branches_pct}%` : ""}.`,
        raw: file,
      })),
  );
}
