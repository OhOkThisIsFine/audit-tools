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

/**
 * Maps semgrep's native uppercase severity strings to the lowercase enum values
 * required by external_analyzer_results.schema.json. Case-insensitive lookup so
 * any casing variant is handled uniformly.
 *
 * Semgrep → schema:
 *   CRITICAL → 'critical'
 *   ERROR    → 'high'
 *   WARNING  → 'medium'
 *   INFO     → 'info'
 *
 * Any other / undefined value returns undefined so
 * normalizeGenericExternalResults can apply its own fallback.
 */
function normalizeSemgrepSeverity(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  switch (raw.toUpperCase()) {
    case "CRITICAL": return "critical";
    case "ERROR":    return "high";
    case "WARNING":  return "medium";
    case "INFO":     return "info";
    default:         return undefined;
  }
}

export function normalizeSemgrepJson(
  input: SemgrepJson,
): ExternalAnalyzerResults {
  return normalizeGenericExternalResults(
    "semgrep",
    (input.results ?? []).map((result) => ({
      id: result.check_id,
      category: result.extra?.metadata?.category ?? "security",
      severity: normalizeSemgrepSeverity(result.extra?.severity),
      path: result.path,
      line_start: result.start?.line,
      line_end: result.end?.line,
      summary: result.extra?.message,
      rule: result.check_id,
      raw: result,
    })),
  );
}
