import type {
  ExternalAnalyzerGraphEdge,
  ExternalAnalyzerResults,
} from "../types/externalAnalyzer.js";
import { normalizeGenericExternalEdges } from "./normalizeExternal.js";

/**
 * One match from `ast-grep scan --json`. The matched file is `file`; a capture
 * naming the edge target (e.g. a module specifier, a referenced path) is read
 * from `metaVariables.single.<TARGET_META_VAR>.text`. Both are optional so a
 * partial / malformed payload degrades rather than throwing.
 */
interface AstGrepMatch {
  file?: string;
  ruleId?: string;
  metaVariables?: {
    single?: Record<string, { text?: string } | undefined>;
  };
}

/** Default capture name holding the edge target path/specifier. */
const DEFAULT_TARGET_META_VAR = "TARGET";

/**
 * Normalize `ast-grep scan --json` output into language-neutral graph edges:
 * one `matched-file → captured-target` edge per match whose target meta-variable
 * resolves to a non-empty string distinct from the matched file. ast-grep is a
 * structural matcher, so the target capture is whatever the operator's rule
 * binds (a module specifier, a referenced symbol path); endpoint resolution
 * against the repo path lookup happens downstream in the graph extractor.
 *
 * Degrades to an empty edge list on any malformed / missing field and never
 * throws; `normalizeGenericExternalEdges` dedupes + sorts for determinism.
 */
export function normalizeAstGrepJson(
  matches: AstGrepMatch[] | undefined,
  targetMetaVar: string = DEFAULT_TARGET_META_VAR,
): ExternalAnalyzerResults {
  const candidates: Array<Partial<ExternalAnalyzerGraphEdge>> = [];
  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match || typeof match !== "object") continue;
    const from =
      typeof match.file === "string" && match.file.trim().length > 0
        ? match.file.trim()
        : undefined;
    const target = match.metaVariables?.single?.[targetMetaVar]?.text;
    const to =
      typeof target === "string" && target.trim().length > 0
        ? target.trim()
        : undefined;
    if (!from || !to) continue;
    candidates.push({
      from,
      to,
      kind: "analyzer-dataflow-edge",
      confidence: 0.7,
      reason:
        typeof match.ruleId === "string"
          ? `ast-grep rule '${match.ruleId}' links match to captured target.`
          : "ast-grep structural match links file to captured target.",
    });
  }
  return {
    tool: "ast-grep",
    generated_at: new Date().toISOString(),
    graph_edges: normalizeGenericExternalEdges(candidates),
    results: [],
  };
}
