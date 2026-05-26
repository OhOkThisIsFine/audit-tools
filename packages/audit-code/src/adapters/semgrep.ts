import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { normalizeGenericExternalResults } from "./normalizeExternal.js";

interface SemgrepJson {
  results?: Array<{
    check_id?: string;
    path?: string;
    start?: { line?: number };
    end?: { line?: number };
    extra?: {
      severity?: string;
      message?: string;
      metadata?: { category?: string };
    };
  }>;
}

export function normalizeSemgrepJson(
  input: SemgrepJson,
): ExternalAnalyzerResults {
  return normalizeGenericExternalResults(
    "semgrep",
    (input.results ?? []).map((result) => ({
      id: result.check_id,
      category: result.extra?.metadata?.category ?? "security",
      severity: result.extra?.severity,
      path: result.path,
      line_start: result.start?.line,
      line_end: result.end?.line,
      summary: result.extra?.message,
      rule: result.check_id,
      raw: result,
    })),
  );
}
