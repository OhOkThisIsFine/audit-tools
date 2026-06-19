import { z } from "zod";
import type { GraphEdge, RouteEdge, AnalyzerSetting } from "audit-tools/shared";
import type { FileDisposition } from "audit-tools/shared";
import type { RepoManifest } from "../../types.js";

/**
 * The compiler/parser graph seam (Phase 5.0). A `LanguageAnalyzer` enriches the
 * deterministic regex floor with edges derived from a real parser/compiler. Each
 * analyzer is optional: its dependency resolves from the audited repo's
 * node_modules, a shared version-keyed cache, or not at all — and when it cannot
 * resolve, the orchestrator simply keeps the regex floor.
 */
export interface AnalyzerOutput {
  edges: GraphEdge[];
  routes?: RouteEdge[];
}

export interface AnalyzerContext {
  /** Absolute repository root. */
  root: string;
  repoManifest: RepoManifest;
  disposition?: FileDisposition;
  /** Repo-relative, audit-included file paths (the analyzer's working set). */
  includedFiles: string[];
  /** graphLookupKey(path) → repo-relative path, for resolving targets. */
  pathLookup: Map<string, string>;
  /** Resolved npm package directory for this analyzer's dependency, if any. */
  dependencyPath?: string;
}

export interface LanguageAnalyzer {
  /** Stable id; also the `analyzers.<id>` session-config key. */
  id: string;
  /** Optional npm dependency spec ("name" or "name@range") this analyzer needs. */
  dependency?: string;
  /** Whether this analyzer can contribute edges for the given repo-relative file. */
  supports(file: string): boolean;
  /** Analyze the supported subset of `files` and return enrichment edges/routes. */
  analyze(
    files: string[],
    context: AnalyzerContext,
  ): Promise<AnalyzerOutput> | AnalyzerOutput;
}

/** How an analyzer's dependency resolved (or why it will not run). */
export const AnalyzerResolutionSchema = z.enum([
  "repo",
  "cache",
  "installed",
  "absent",
  "skip",
  "not_applicable",
]);
export type AnalyzerResolution = z.infer<typeof AnalyzerResolutionSchema>;

/**
 * Deterministic pre-install resolution for one analyzer. Computed without
 * mutating anything (no install), so the conversation-first CLI can decide
 * whether to propose an install before the executor runs.
 */
export interface AnalyzerPlanEntry {
  id: string;
  dependency?: string;
  setting: AnalyzerSetting;
  resolution: AnalyzerResolution;
  /** Resolved package directory when resolution is repo/cache. */
  path?: string;
  /** Count of in-scope files the analyzer supports. */
  supportedCount: number;
}
