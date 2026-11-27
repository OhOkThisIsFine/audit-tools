import type { ExternalAnalyzerResults } from "audit-tools/shared";

/**
 * Extract the file paths with at least one external analyzer finding for question planning.
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
