/**
 * Shared test helpers for audit test suite.
 * Extracted to eliminate duplication across test files.
 */

import type { GraphBundle, GraphEdge } from "audit-tools/shared";
import type { RepoManifest } from "../../src/audit/types.js";

export interface FixtureFile {
  path: string;
  content?: string;
  size_bytes?: number;
  language?: string;
}

/**
 * Build a minimal RepoManifest fixture from a list of fixture files.
 */
export function manifest(files: FixtureFile[]): RepoManifest {
  return {
    generated_at: new Date(0).toISOString(),
    repository: { name: "fixture-repo" },
    files: files.map((f) => ({
      path: f.path,
      size_bytes: f.size_bytes ?? (f.content ? f.content.length : 0),
      language: f.language ?? "typescript",
      excluded: false,
    })),
  };
}

/**
 * Build a GraphBundle fixture from edge lists.
 */
export function edgeBundle(edges: GraphEdge[], extra: Partial<GraphBundle> = {}): GraphBundle {
  return { graphs: { imports: edges, calls: [], references: [], routes: [] }, ...extra };
}
