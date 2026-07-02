import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { GraphBundle, GraphEdge } from "audit-tools/shared";

export type FileAnchorKind =
  | "boundary"
  | "import"
  | "export"
  | "symbol"
  | "route"
  | "keyword"
  | "graph"
  | "analyzer_signal";

export interface FileAnchor {
  kind: FileAnchorKind;
  name: string;
  line?: number;
  detail?: string;
}

export interface FileAnchorSummary {
  contract_version: "audit-code-file-anchors/v1alpha1";
  path: string;
  total_lines: number;
  review_mode: "isolated_large_file";
  scope_basis: string[];
  anchors: FileAnchor[];
  omitted_anchor_count: number;
  counts: {
    symbols: number;
    routes: number;
    keywords: number;
    graph_edges: number;
    analyzer_signals: number;
  };
}

/**
 * Graph buckets in `graph_bundle.json` that carry file-to-file edges relevant to
 * large-file anchoring. Named here (rather than inlined as bare strings in the
 * collection loop) so the set of scanned buckets is a single typed source of
 * truth and each bucket key doubles as a typed fallback edge `kind`. `as const`
 * narrows the element type from `string` to the literal union.
 */
const GRAPH_EDGE_BUCKETS = ["imports", "calls", "references"] as const;

const MAX_ANCHORS = 160;
// Keywords that signal elevated-risk or review-worthy lines, grouped by concern:
// auth/access:              auth, password, permission, role, secret, token
// injection/execution:      deserialize, eval, exec, query, spawn, sql
// crypto:                   decrypt, encrypt
// concurrency/reliability:  cache, lock, race, retry, timeout, transaction
// debt markers:             FIXME, TODO
const KEYWORD_PATTERN =
  /\b(auth|password|permission|role|secret|token|deserialize|eval|exec|query|spawn|sql|decrypt|encrypt|cache|lock|race|retry|timeout|transaction|FIXME|TODO)\b/i;
const SYMBOL_PATTERNS: Array<{ kind: FileAnchorKind; pattern: RegExp; label: string }> = [
  {
    kind: "import",
    pattern: /^\s*import\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/,
    label: "import",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b/,
    label: "function",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/,
    label: "class",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/,
    label: "interface",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/,
    label: "type",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/,
    label: "binding",
  },
  {
    kind: "export",
    pattern: /^\s*export\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+["']([^"']+)["']|(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z_$][\w$-]*))/,
    label: "export",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:export\s+)?def\s+([A-Za-z_][\w]*)\b/,
    label: "function",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:export\s+)?func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\b/,
    label: "function",
  },
  {
    kind: "symbol",
    pattern: /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\b/,
    label: "function",
  },
  {
    kind: "route",
    pattern: /\b(?:app|router|server)\s*\.\s*(get|post|put|patch|delete|use)\s*\(/i,
    label: "route",
  },
  {
    kind: "route",
    pattern: /^\s*@(?:Get|Post|Put|Patch|Delete|Route|Controller)\b/,
    label: "route",
  },
];

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function addAnchor(
  anchors: FileAnchor[],
  seen: Set<string>,
  anchor: FileAnchor,
): void {
  const key = `${anchor.kind}\0${anchor.line ?? ""}\0${anchor.name}\0${anchor.detail ?? ""}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  anchors.push(anchor);
}

/**
 * Path-keyed index of external-analyzer signal anchors (rule/line/summary),
 * built ONCE per dispatch from the whole `externalAnalyzerResults` set so
 * per-task/per-file prompt rendering is an O(1) map read rather than an
 * O(tasks × files × total-results) re-flatten. Key = normalized lowercased
 * path; each bucket is pre-sorted by (line_start, id), matching the original
 * per-path ordering. See {@link analyzerSignalAnchorsForPath} for the reader.
 */
export type AnalyzerSignalAnchorIndex = Map<string, FileAnchor[]>;

export function buildAnalyzerSignalAnchorIndex(
  externalAnalyzerResults: ExternalAnalyzerResults[] | undefined,
): AnalyzerSignalAnchorIndex {
  // Group raw signals by path first so the (line_start, id) sort — and thus the
  // rendered order — is byte-identical to the pre-index per-path extraction.
  const grouped = new Map<string, ExternalAnalyzerResults["results"]>();
  for (const tool of externalAnalyzerResults ?? []) {
    for (const result of tool.results ?? []) {
      const key = normalizePath(result.path).toLowerCase();
      const bucket = grouped.get(key);
      if (bucket) {
        bucket.push(result);
      } else {
        grouped.set(key, [result]);
      }
    }
  }
  const index: AnalyzerSignalAnchorIndex = new Map();
  for (const [key, results] of grouped) {
    results.sort(
      (a, b) =>
        (a.line_start ?? 0) - (b.line_start ?? 0) ||
        a.id.localeCompare(b.id),
    );
    index.set(
      key,
      results.map((signal) => ({
        kind: "analyzer_signal" as const,
        name: truncate(signal.rule ?? signal.category, 80),
        line: signal.line_start,
        detail: truncate(signal.summary, 180),
      })),
    );
  }
  return index;
}

/**
 * External-analyzer signal anchors (rule/line/summary) for one path — an O(1)
 * read of the pre-built {@link AnalyzerSignalAnchorIndex}. Split out of
 * {@link buildFileAnchorSummary} so packet-level prompt rendering (any
 * multi-file packet, not just isolated-large-file mode) can surface the same
 * grounded lead detail without paying for whole-file content scanning.
 */
export function analyzerSignalAnchorsForPath(
  path: string,
  index: AnalyzerSignalAnchorIndex | undefined,
): FileAnchor[] {
  return index?.get(normalizePath(path).toLowerCase()) ?? [];
}

function collectGraphEdges(graphBundle: GraphBundle | undefined, path: string): GraphEdge[] {
  if (!graphBundle?.graphs) {
    return [];
  }
  const normalizedPath = normalizePath(path).toLowerCase();
  const edges: GraphEdge[] = [];
  // Typed as `string` (not the literal union) so the lookup resolves through the
  // `[key: string]: unknown` index signature on `graphs` — the loop body then
  // re-validates each entry's shape, matching the original deterministic parse.
  for (const bucket of GRAPH_EDGE_BUCKETS as readonly string[]) {
    const raw = graphBundle.graphs[bucket];
    if (!Array.isArray(raw)) {
      continue;
    }
    for (const item of raw) {
      const record = item as Record<string, unknown>;
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof record.from === "string" &&
        typeof record.to === "string"
      ) {
        const from = normalizePath(record.from).toLowerCase();
        const to = normalizePath(record.to).toLowerCase();
        if (from === normalizedPath || to === normalizedPath) {
          edges.push({
            from: record.from,
            to: record.to,
            kind: typeof record.kind === "string" ? record.kind : bucket,
          });
        }
      }
    }
  }
  return edges.sort(
    (a, b) =>
      (a.kind ?? "").localeCompare(b.kind ?? "") ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to),
  );
}

function scanSymbol(
  line: string,
  lineNumber: number,
  anchors: FileAnchor[],
  seen: Set<string>,
): string | null {
  for (const { kind, pattern, label } of SYMBOL_PATTERNS) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const name = match.slice(1).find((value) => value && value.trim().length > 0) ?? label;
    addAnchor(anchors, seen, {
      kind,
      name: truncate(name, 80),
      line: lineNumber,
      detail: truncate(`${label}: ${line}`, 180),
    });
    return kind;
  }
  return null;
}

function scanKeyword(
  line: string,
  lineNumber: number,
  anchors: FileAnchor[],
  seen: Set<string>,
): boolean {
  if (!KEYWORD_PATTERN.test(line)) {
    return false;
  }
  addAnchor(anchors, seen, {
    kind: "keyword",
    name: truncate(line.match(KEYWORD_PATTERN)?.[1] ?? "keyword", 80),
    line: lineNumber,
    detail: truncate(line, 180),
  });
  return true;
}

export function buildFileAnchorSummary(params: {
  path: string;
  content: string;
  totalLines: number;
  graphBundle?: GraphBundle;
  externalAnalyzerResults?: ExternalAnalyzerResults[];
}): FileAnchorSummary {
  const anchors: FileAnchor[] = [];
  const seen = new Set<string>();
  const path = normalizePath(params.path);
  const lines = params.content.split(/\r?\n/);
  let symbolCount = 0;
  let routeCount = 0;
  let keywordCount = 0;

  addAnchor(anchors, seen, {
    kind: "boundary",
    name: "file_start",
    line: 1,
    detail: "Start of isolated large-file review boundary.",
  });

  if (params.totalLines > 1) {
    addAnchor(anchors, seen, {
      kind: "boundary",
      name: "file_end",
      line: params.totalLines,
      detail: "End of isolated large-file review boundary.",
    });
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const symbolKind = scanSymbol(line, lineNumber, anchors, seen);
    if (symbolKind === "route") routeCount += 1;
    else if (symbolKind === "symbol") symbolCount += 1;
    if (scanKeyword(line, lineNumber, anchors, seen)) keywordCount += 1;
  });

  const graphEdges = collectGraphEdges(params.graphBundle, path);
  for (const edge of graphEdges) {
    addAnchor(anchors, seen, {
      kind: "graph",
      name: edge.kind ?? "edge",
      detail:
        normalizePath(edge.from).toLowerCase() === path.toLowerCase()
          ? `outbound: ${edge.to}`
          : `inbound: ${edge.from}`,
    });
  }

  const analyzerSignals = analyzerSignalAnchorsForPath(
    path,
    buildAnalyzerSignalAnchorIndex(params.externalAnalyzerResults),
  );
  for (const signal of analyzerSignals) {
    addAnchor(anchors, seen, signal);
  }

  const sorted = anchors.sort(
    (a, b) =>
      (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER) ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  );
  const boundedAnchors = sorted.slice(0, MAX_ANCHORS);

  return {
    contract_version: "audit-code-file-anchors/v1alpha1",
    path,
    total_lines: params.totalLines,
    review_mode: "isolated_large_file",
    scope_basis: [
      "single assigned file",
      "single review packet",
      "mechanically extracted symbols, routes, graph edges, keywords, and analyzer signals",
      "backend-owned submit-packet result write path",
    ],
    anchors: boundedAnchors,
    omitted_anchor_count: Math.max(0, sorted.length - boundedAnchors.length),
    counts: {
      symbols: symbolCount,
      routes: routeCount,
      keywords: keywordCount,
      graph_edges: graphEdges.length,
      analyzer_signals: analyzerSignals.length,
    },
  };
}
