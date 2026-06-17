import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, isCargoManifestPath } from "../graphPathUtils.js";
import { WorkspacePattern, addWorkspacePattern, normalizeWorkspacePattern, workspacePatternMatchesManifest } from "./workspace.js";
import { tomlTable, tomlStringArray } from "./toml.js";

const CARGO_WORKSPACE_MEMBER_EDGE_CONFIDENCE = 0.87;

/**
 * Cargo `[workspace]` member/exclude globs. Parsed with a vetted TOML parser
 * (`smol-toml`) rather than a line scanner, so every spelling of the table
 * resolves to the same shape — `[workspace]` headers, the dotted
 * `workspace.members = [...]`, and the inline `workspace = { members = [...] }`
 * form all yield `workspace.members` — instead of silently dropping the dotted
 * and inline forms (the dropped-edge bug). `exclude` entries are emitted as
 * `!`-prefixed negation patterns. Malformed TOML degrades to `[]` (the graph
 * builder never throws on a bad manifest).
 */
export function cargoWorkspacePatterns(content: string): WorkspacePattern[] {
  const workspace = tomlTable(content, "workspace");
  if (!workspace) {
    return [];
  }
  const patterns: WorkspacePattern[] = [];
  for (const member of tomlStringArray(workspace.members)) {
    addWorkspacePattern(patterns, member);
  }
  for (const excluded of tomlStringArray(workspace.exclude)) {
    addWorkspacePattern(patterns, `!${excluded}`);
  }
  return patterns;
}

export function extractCargoWorkspaceMemberEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isCargoManifestPath(fromPath)) {
    return [];
  }

  const rawPatterns = cargoWorkspacePatterns(content);
  if (rawPatterns.length === 0) {
    return [];
  }

  const positivePatterns: string[] = [];
  const negativePatterns: string[] = [];
  for (const { pattern, negated } of rawPatterns) {
    const normalized = normalizeWorkspacePattern(fromPath, pattern);
    if (!normalized) {
      continue;
    }
    if (negated) {
      negativePatterns.push(normalized);
    } else {
      positivePatterns.push(normalized);
    }
  }

  const edges: GraphEdge[] = [];
  for (const pattern of positivePatterns) {
    for (const target of pathLookup.values()) {
      if (target === fromPath || !isCargoManifestPath(target)) {
        continue;
      }
      if (!workspacePatternMatchesManifest(pattern, target, "Cargo.toml")) {
        continue;
      }
      if (
        negativePatterns.some((negativePattern) =>
          workspacePatternMatchesManifest(negativePattern, target, "Cargo.toml"),
        )
      ) {
        continue;
      }
      edges.push(
        graphEdge({
          from: fromPath,
          to: target,
          kind: "cargo-workspace-member-link",
          confidence: CARGO_WORKSPACE_MEMBER_EDGE_CONFIDENCE,
          reason: `Cargo workspace pattern '${pattern}' includes member manifest '${target}'.`,
        }),
      );
    }
  }
  return edges;
}
