import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";

/**
 * Extract the set of file paths that have at least one external-analyzer
 * finding. Shared by all requeue generators (file-level requeue, flow requeue)
 * so the extraction logic never drifts between them.
 *
 * Note: `taskPriority` is intentionally NOT shared here — the file-level and
 * flow-requeue generators apply different priority rules (file requeue treats
 * any external signal as "high"; flow requeue only does so when the lens is
 * also sensitive). Each module defines its own `taskPriority` to keep those
 * rules explicit and independently adjustable.
 */
export function getExternalSignalPaths(
  externalAnalyzerResults?: ExternalAnalyzerResults[],
): Set<string> {
  const results = (externalAnalyzerResults ?? []).flatMap((tool) =>
    Array.isArray(tool.results) ? tool.results : [],
  );
  return new Set(
    results
      .map((item) =>
        item && typeof item.path === "string" && item.path.length > 0
          ? item.path
          : null,
      )
      .filter((path): path is string => path !== null),
  );
}
