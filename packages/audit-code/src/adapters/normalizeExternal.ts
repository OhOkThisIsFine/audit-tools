import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";

type SeverityEnum = "critical" | "high" | "medium" | "low" | "info";

function normalizeExternalSeverity(value: string | undefined): SeverityEnum {
  switch (value?.toLowerCase()) {
    case "critical": return "critical";
    case "error":
    case "high": return "high";
    case "warning":
    case "moderate":
    case "medium": return "medium";
    case "low": return "low";
    case "info":
    case "note":
    case "hint": return "info";
    default: return "info";
  }
}

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
  const valid = items.filter((item) => item.path && item.summary);
  const dropped = items.length - valid.length;
  if (dropped > 0) {
    process.stderr.write(
      `[audit-code] normalizeExternal: dropped ${dropped}/${items.length} ${tool} finding(s) missing path or summary\n`,
    );
  }
  return {
    tool,
    generated_at: new Date().toISOString(),
    results: valid.map((item, index) => ({
      id: item.id ?? `${tool}-${index + 1}`,
      category: item.category ?? "unknown",
      severity: normalizeExternalSeverity(item.severity),
      path: item.path as string,
      line_start: item.line_start,
      line_end: item.line_end,
      summary: item.summary as string,
      rule: item.rule,
      raw: item.raw,
    })),
  };
}
