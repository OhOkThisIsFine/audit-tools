import type {
  ExternalAnalyzerGraphEdge,
  ExternalAnalyzerResults,
} from "../types/externalAnalyzer.js";
import {
  normalizeGenericExternalEdges,
  normalizeGenericExternalResults,
} from "./normalizeExternal.js";

interface SemgrepDataflowTraceNode {
  location?: { path?: string };
}

interface SemgrepResult {
  check_id?: string;
  path?: string;
  start?: { line?: number };
  end?: { line?: number };
  extra?: {
    severity?: string;
    message?: string;
    metadata?: { category?: string };
    dataflow_trace?: {
      taint_source?: SemgrepDataflowTraceNode | SemgrepDataflowTraceNode[];
      intermediate_vars?: SemgrepDataflowTraceNode[];
      taint_sink?: SemgrepDataflowTraceNode | SemgrepDataflowTraceNode[];
    };
  };
}

interface SemgrepJson {
  results?: SemgrepResult[];
}

/**
 * Maps semgrep's native uppercase severity strings to the lowercase enum values
 * required by ExternalAnalyzerResultsSchema. Case-insensitive lookup so
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

function dataflowNodePath(
  node: SemgrepDataflowTraceNode | undefined,
): string | undefined {
  const path = node?.location?.path;
  return typeof path === "string" && path.trim().length > 0
    ? path.trim()
    : undefined;
}

function firstDataflowPath(
  value: SemgrepDataflowTraceNode | SemgrepDataflowTraceNode[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    for (const node of value) {
      const path = dataflowNodePath(node);
      if (path) return path;
    }
    return undefined;
  }
  return dataflowNodePath(value);
}

/**
 * Normalize semgrep's broader `--dataflow-traces` output into language-neutral
 * graph edges: one `taint-source → taint-sink` edge per result whose source and
 * sink resolve to distinct file paths. Intermediate vars are not edges (they are
 * within-file steps). Malformed / missing traces degrade to an empty edge list;
 * `normalizeGenericExternalEdges` dedupes + sorts so output is deterministic.
 */
export function normalizeSemgrepDataflowJson(
  input: SemgrepJson,
): ExternalAnalyzerResults {
  const candidates: Array<Partial<ExternalAnalyzerGraphEdge>> = [];
  for (const result of input.results ?? []) {
    if (!result || typeof result !== "object") continue;
    const trace = result.extra?.dataflow_trace;
    if (!trace) continue;
    const from = firstDataflowPath(trace.taint_source);
    const to = firstDataflowPath(trace.taint_sink);
    if (!from || !to) continue;
    candidates.push({
      from,
      to,
      kind: "analyzer-dataflow-edge",
      confidence: 0.7,
      reason:
        typeof result.check_id === "string"
          ? `semgrep dataflow trace '${result.check_id}' flows source → sink.`
          : "semgrep dataflow trace flows source → sink.",
    });
  }
  return {
    tool: "semgrep-dataflow",
    generated_at: new Date().toISOString(),
    graph_edges: normalizeGenericExternalEdges(candidates),
    results: [],
  };
}
