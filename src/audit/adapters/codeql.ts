import type {
  ExternalAnalyzerGraphEdge,
  ExternalAnalyzerResults,
} from "../types/externalAnalyzer.js";
import { normalizeGenericExternalEdges } from "./normalizeExternal.js";

/**
 * Minimal SARIF 2.1.0 shape for CodeQL dataflow queries. Only the fields needed
 * to recover source→sink file edges from `codeFlows` are typed; everything is
 * optional so a partial / malformed report degrades rather than throwing.
 */
interface SarifArtifactLocation {
  uri?: string;
}
interface SarifLocation {
  physicalLocation?: { artifactLocation?: SarifArtifactLocation };
}
interface SarifThreadFlowLocation {
  location?: SarifLocation;
}
interface SarifThreadFlow {
  locations?: SarifThreadFlowLocation[];
}
interface SarifCodeFlow {
  threadFlows?: SarifThreadFlow[];
}
interface SarifResult {
  ruleId?: string;
  codeFlows?: SarifCodeFlow[];
}
interface SarifRun {
  results?: SarifResult[];
}
export interface CodeqlSarif {
  runs?: SarifRun[];
}

function locationUri(location: SarifThreadFlowLocation | undefined): string | undefined {
  const uri = location?.location?.physicalLocation?.artifactLocation?.uri;
  return typeof uri === "string" && uri.trim().length > 0 ? uri.trim() : undefined;
}

/**
 * Normalize a CodeQL SARIF dataflow report into language-neutral graph edges:
 * for each result's code flow, emit one `source-file → sink-file` edge from the
 * first to the last thread-flow location whose file paths differ. CodeQL's
 * dataflow queries already model taint propagation, so the first/last locations
 * are the source and sink; downstream the graph extractor resolves the URIs
 * against the repo path lookup.
 *
 * Degrades to an empty edge list on any malformed / missing SARIF field and
 * never throws; `normalizeGenericExternalEdges` dedupes + sorts for determinism.
 */
export function normalizeCodeqlSarif(input: CodeqlSarif): ExternalAnalyzerResults {
  const candidates: Array<Partial<ExternalAnalyzerGraphEdge>> = [];
  for (const run of input.runs ?? []) {
    for (const result of run?.results ?? []) {
      for (const codeFlow of result?.codeFlows ?? []) {
        for (const threadFlow of codeFlow?.threadFlows ?? []) {
          if (!threadFlow || typeof threadFlow !== "object") continue;
          const locations = Array.isArray(threadFlow.locations)
            ? threadFlow.locations
            : [];
          const from = locationUri(locations[0]);
          const to = locationUri(locations[locations.length - 1]);
          if (!from || !to) continue;
          candidates.push({
            from,
            to,
            kind: "analyzer-dataflow-edge",
            confidence: 0.7,
            reason:
              typeof result.ruleId === "string"
                ? `CodeQL query '${result.ruleId}' flows source → sink.`
                : "CodeQL dataflow flows source → sink.",
          });
        }
      }
    }
  }
  return {
    tool: "codeql",
    generated_at: new Date().toISOString(),
    graph_edges: normalizeGenericExternalEdges(candidates),
    results: [],
  };
}
