import type {
  ExternalAnalyzerGraphEdge,
  ExternalAnalyzerParsedItem,
  ExternalAnalyzerResults,
} from "./types.js";
import {
  hashAnalyzerSnippet,
  type AnalyzerLeadProvenance,
} from "./provenance.js";
import { normalizeRepoRelPath } from "../paths.js";
import { normalizeRepoPath } from "../validation/findingGrounding.js";

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

/**
 * Repo-relative form of an analyzer-reported path, case PRESERVED.
 *
 * Seven of the twelve candidates hand their tool the ABSOLUTE repository root as a
 * positional target, so those tools echo absolute paths back. Persisting one makes
 * the lead machine-specific, un-joinable against every repo-relative consumer, and
 * unreadable by the provenance reader (`join(root, "/abs/path")` names nothing).
 * Containment is decided with the shared {@link normalizeRepoPath} (case- and
 * separator-folded, so win32 drive-letter and case drift still match); the returned
 * value is sliced out of the ORIGINAL string so on-disk case survives.
 *
 * A path outside the repository root is left as-is: it is not repo-relative, and
 * silently rewriting it would invent an identity the tool never reported.
 */
export function toRepoRelativeAnalyzerPath(
  repoRoot: string | undefined,
  rawPath: string,
): string {
  // normalizeRepoRelPath is `normalizeRepoPath` WITHOUT the case fold — the fold
  // is correct for membership matching and wrong for a path that is persisted
  // and later re-read from a case-sensitive filesystem. Trim stays caller-side:
  // analyzer output can carry stray whitespace the shared token helper must not
  // assume.
  const path = normalizeRepoRelPath(rawPath.trim());
  if (!repoRoot || path.length === 0) return path;
  const root = normalizeRepoRelPath(repoRoot.trim()).replace(/\/+$/, "");
  if (root.length === 0) return path;
  const foldedRoot = normalizeRepoPath(root);
  const foldedPath = normalizeRepoPath(path);
  if (foldedPath === foldedRoot) return "";
  if (!foldedPath.startsWith(`${foldedRoot}/`)) return path;
  return path.slice(root.length + 1);
}

/** A degradation observed while normalizing, reported to the caller rather than swallowed. */
export interface NormalizeExternalDiagnostics {
  /** Items dropped for a missing `path` or `summary`. */
  dropped_items: number;
  /**
   * Items that HAD a path + line_start but whose source could not be read, so their
   * provenance was dropped. Distinct from an item that simply has no anchor.
   */
  source_read_failures: number;
}

export interface NormalizeExternalOptions {
  /**
   * Source reader for content-anchored lead provenance (item C): given a
   * repo-relative path, return the file's contents, or undefined when
   * unreadable. When supplied, every item with a `path` + `line_start` whose
   * span hashes non-empty gains an {@link AnalyzerLeadProvenance}; absent or
   * failing, items simply carry no provenance (optional everywhere).
   */
  readSource?: (path: string) => string | undefined;
  /**
   * Absolute repository root. When supplied, every item path is normalized to its
   * repo-relative form BEFORE it is persisted and before `readSource` is called, so
   * an absolute-path emitter cannot leak a machine-specific path into the artifact
   * or silently lose provenance.
   */
  repoRoot?: string;
  /**
   * Receives the normalization degradations. The caller (the acquisition engine)
   * carries them onto the tool's status record, which is the only post-run evidence
   * that items were lost.
   */
  onDiagnostics?: (diagnostics: NormalizeExternalDiagnostics) => void;
}

export function normalizeGenericExternalResults(
  tool: string,
  items: ExternalAnalyzerParsedItem[],
  options: NormalizeExternalOptions = {},
): ExternalAnalyzerResults {
  // Repo-relative FIRST: every downstream step — validity, provenance read, and the
  // persisted `path` — must see the same normalized identity.
  const normalizedItems = items.map((item) =>
    typeof item?.path === "string"
      ? { ...item, path: toRepoRelativeAnalyzerPath(options.repoRoot, item.path) }
      : item,
  );
  const valid = normalizedItems.filter((item) => item.path && item.summary);
  const dropped = normalizedItems.length - valid.length;
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
  const sourceCache = new Map<string, string | undefined>();
  const readCached = (path: string): string | undefined => {
    if (!options.readSource) return undefined;
    if (!sourceCache.has(path)) sourceCache.set(path, options.readSource(path));
    return sourceCache.get(path);
  };
  // An item with BOTH a path and a line number is anchorable; if its source cannot
  // be read, provenance is lost for a reason the operator can act on. An item with
  // no line number simply has no anchor — a different, benign state. Counting only
  // the first keeps the two apart (they are byte-identical in the results array).
  let sourceReadFailures = 0;
  const provenanceFor = (item: {
    path?: string;
    line_start?: number;
    line_end?: number;
    rule?: string;
  }): AnalyzerLeadProvenance | undefined => {
    if (!item.path || item.line_start === undefined) return undefined;
    const source = readCached(item.path);
    if (source === undefined) {
      if (options.readSource) sourceReadFailures += 1;
      return undefined;
    }
    const snippet_hash = hashAnalyzerSnippet(source, item.line_start, item.line_end);
    if (snippet_hash === undefined) return undefined;
    return {
      analyzer_id: tool,
      ...(item.rule !== undefined ? { rule: item.rule } : {}),
      path: item.path,
      snippet_hash,
    };
  };
  const results = valid.map((item, index) => {
      const provenance = provenanceFor(item);
      return {
        id: item.id ?? `${tool}-${index + 1}`,
        category: item.category ?? "unknown",
        severity: normalizeExternalSeverity(item.severity),
        path: item.path as string,
        line_start: item.line_start,
        line_end: item.line_end,
        summary: item.summary as string,
        rule: item.rule,
        raw: item.raw,
        ...(provenance !== undefined ? { provenance } : {}),
      };
    });
  options.onDiagnostics?.({
    dropped_items: dropped,
    source_read_failures: sourceReadFailures,
  });
  return {
    tool,
    generated_at: new Date().toISOString(),
    results,
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
