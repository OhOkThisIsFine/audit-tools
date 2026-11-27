import type { ArtifactBundle } from "../io/artifacts.js";
import {
  stableStringify, upsertExternalToolResults,
  type ExternalAnalyzerResults,
} from "audit-tools/shared";
import type { ExecutorRunResult } from "./executorResult.js";

export function runExternalAnalyzerImportExecutor(
  bundle: ArtifactBundle,
  externalResults: ExternalAnalyzerResults,
): ExecutorRunResult {
  const prior = bundle.external_analyzer_results?.find(report => report.tool === externalResults.tool);
  // This door accepts normalized leads, not evidence about an invocation. It
  // cannot replace native receipt provenance or retract earlier positives.
  const withoutReceipt = (row: ExternalAnalyzerResults["results"][number]) => {
    if (!row.provenance?.comparison_fingerprint) return row;
    const { comparison_fingerprint: _receipt, ...provenance } = row.provenance;
    return { ...row, provenance };
  };
  const merge = <T>(oldRows: T[], newRows: T[], key: (row: T) => string = stableStringify): T[] => {
    const seen = new Set(oldRows.map(key));
    return [...oldRows, ...newRows.filter(row => {
      const id = key(row);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })];
  };
  const previous = prior?.results ?? [];
  const results = merge(previous, externalResults.results.map(withoutReceipt), row => stableStringify(withoutReceipt(row)));
  const graph = merge(prior?.graph_edges ?? [], externalResults.graph_edges ?? []);
  const roots = merge(prior?.ownership_roots ?? [], externalResults.ownership_roots ?? []);
  if (prior && results.length === previous.length && graph.length === (prior.graph_edges?.length ?? 0) &&
      roots.length === (prior.ownership_roots?.length ?? 0)) {
    return { updated: bundle, artifacts_written: [], progress_summary: `Reused existing normalized findings from ${externalResults.tool}.` };
  }
  const merged: ExternalAnalyzerResults = {
    ...prior, tool: externalResults.tool, generated_at: externalResults.generated_at ?? prior?.generated_at, results,
    ...(graph.length ? { graph_edges: graph } : {}), ...(roots.length ? { ownership_roots: roots } : {}),
  };
  const summary = `Imported ${results.length - previous.length} new normalized findings from ${externalResults.tool}.`;
  return {
    updated: {
      ...bundle,
      external_analyzer_results: upsertExternalToolResults(
        bundle.external_analyzer_results,
        merged,
      ),
      audit_report: undefined,
    },
    artifacts_written: ["external_analyzer_results.json"],
    progress_summary: summary,
  };
}
