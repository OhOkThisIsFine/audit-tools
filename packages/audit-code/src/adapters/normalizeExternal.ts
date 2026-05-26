import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";

export function normalizeGenericExternalResults(
  tool: string,
  items: Array<{
    id?: string;
    category?: string;
    severity?: string;
    path?: string;
    line_start?: number;
    line_end?: number;
    summary?: string;
    rule?: string;
    raw?: unknown;
  }>,
): ExternalAnalyzerResults {
  return {
    tool,
    generated_at: new Date().toISOString(),
    results: items
      .filter((item) => item.path && item.summary)
      .map((item, index) => ({
        id: item.id ?? `${tool}-${index + 1}`,
        category: item.category ?? "unknown",
        severity: item.severity ?? "unknown",
        path: item.path as string,
        line_start: item.line_start,
        line_end: item.line_end,
        summary: item.summary as string,
        rule: item.rule,
        raw: item.raw,
      })),
  };
}
