import {
  resolveAnalyzerDep,
  type AnalyzerSetting,
} from "@audit-tools/shared";
import type { AnalyzerPlanEntry, LanguageAnalyzer } from "./types.js";
import { typescriptAnalyzer } from "./typescript.js";

/**
 * Registered language analyzers, in within-phase order (seam → TS/JS → …).
 * Future tree-sitter analyzers (Python/HTML/CSS) register here.
 */
export const ANALYZER_REGISTRY: LanguageAnalyzer[] = [typescriptAnalyzer];

export function getAnalyzerById(id: string): LanguageAnalyzer | undefined {
  return ANALYZER_REGISTRY.find((analyzer) => analyzer.id === id);
}

function settingFor(
  analyzers: Record<string, AnalyzerSetting> | undefined,
  id: string,
): AnalyzerSetting {
  return analyzers?.[id] ?? "auto";
}

/**
 * Deterministically resolve, without installing anything, how each registered
 * analyzer would run for this repo. The conversation-first CLI uses this to
 * decide whether to propose an install before the enrichment executor runs.
 *
 * Resolution rules:
 *  - 0 supported in-scope files            → `not_applicable`
 *  - setting `skip`                         → `skip`
 *  - dependency resolves (repo|cache)       → `repo` | `cache`
 *  - dependency absent                      → `absent` (executor installs only
 *    for `ephemeral`/`permanent`; `auto` may prompt; `repo` falls to the floor)
 */
export function resolveAnalyzerPlan(
  root: string,
  analyzers: Record<string, AnalyzerSetting> | undefined,
  includedFiles: string[],
  options: { cacheRoot?: string } = {},
): AnalyzerPlanEntry[] {
  const depOptions = options.cacheRoot ? { cacheRoot: options.cacheRoot } : {};
  return ANALYZER_REGISTRY.map((analyzer) => {
    const setting = settingFor(analyzers, analyzer.id);
    const supportedCount = includedFiles.filter((file) =>
      analyzer.supports(file),
    ).length;

    if (supportedCount === 0) {
      return {
        id: analyzer.id,
        dependency: analyzer.dependency,
        setting,
        resolution: "not_applicable" as const,
        supportedCount,
      };
    }
    if (setting === "skip") {
      return {
        id: analyzer.id,
        dependency: analyzer.dependency,
        setting,
        resolution: "skip" as const,
        supportedCount,
      };
    }
    if (!analyzer.dependency) {
      // No dependency required: always available.
      return {
        id: analyzer.id,
        dependency: analyzer.dependency,
        setting,
        resolution: "repo" as const,
        supportedCount,
      };
    }

    const resolved = resolveAnalyzerDep(analyzer.dependency, root, depOptions);
    if (resolved.via === "repo" || resolved.via === "cache") {
      return {
        id: analyzer.id,
        dependency: analyzer.dependency,
        setting,
        resolution: resolved.via,
        path: resolved.path,
        supportedCount,
      };
    }
    return {
      id: analyzer.id,
      dependency: analyzer.dependency,
      setting,
      resolution: "absent" as const,
      supportedCount,
    };
  });
}

/**
 * A plan entry whose dependency is absent and whose setting is `auto` (or unset)
 * with in-scope files — the only case that warrants proposing an install in the
 * conversation-first flow. (ephemeral/permanent install silently; repo/skip fall
 * to the floor silently.)
 */
export function needsInstallDecision(entry: AnalyzerPlanEntry): boolean {
  return entry.resolution === "absent" && entry.setting === "auto";
}
