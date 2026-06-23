import type {
  ExternalAnalyzerGraphEdge,
  ExternalAnalyzerResults,
} from "../types/externalAnalyzer.js";

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
      JSON.stringify({
        event: "normalizer_findings_dropped",
        tool,
        dropped,
        total: items.length,
        reason: "missing path or summary",
      }) + "\n",
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

function clampUnitInterval(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : undefined;
}

/**
 * Normalize a raw list of edge candidates (from an external dataflow analyzer:
 * ast-grep / broader-semgrep dataflow / CodeQL) into the language-neutral
 * {@link ExternalAnalyzerGraphEdge} contract.
 *
 * Degrade-to-empty + deterministic by construction:
 *  - any candidate missing a non-empty string `from`/`to`, or a self-edge
 *    (`from === to`), is dropped — never throws on a malformed payload;
 *  - duplicate (from,to,kind) triples collapse to one;
 *  - output is sorted by from-then-to-then-kind so identical input yields
 *    byte-identical output run to run.
 *
 * The returned shape is the wire contract carried on
 * `ExternalAnalyzerResults.graph_edges`; the graph extractor resolves the
 * endpoints against the repo path lookup and merges them into the edge set.
 */
export function normalizeGenericExternalEdges(
  candidates: Array<{
    from?: unknown;
    to?: unknown;
    kind?: unknown;
    confidence?: unknown;
    reason?: unknown;
  }>,
): ExternalAnalyzerGraphEdge[] {
  const deduped = new Map<string, ExternalAnalyzerGraphEdge>();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate || typeof candidate !== "object") continue;
    const from = typeof candidate.from === "string" ? candidate.from.trim() : "";
    const to = typeof candidate.to === "string" ? candidate.to.trim() : "";
    if (from.length === 0 || to.length === 0 || from === to) continue;
    const kind =
      typeof candidate.kind === "string" && candidate.kind.trim().length > 0
        ? candidate.kind.trim()
        : undefined;
    const confidence = clampUnitInterval(candidate.confidence);
    const reason =
      typeof candidate.reason === "string" && candidate.reason.trim().length > 0
        ? candidate.reason.trim()
        : undefined;
    const edge: ExternalAnalyzerGraphEdge = { from, to };
    if (kind !== undefined) edge.kind = kind;
    if (confidence !== undefined) edge.confidence = confidence;
    if (reason !== undefined) edge.reason = reason;
    deduped.set(`${from}\0${to}\0${kind ?? ""}`, edge);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      (a.kind ?? "").localeCompare(b.kind ?? ""),
  );
}
