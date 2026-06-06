import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, isCargoManifestPath } from "../graphPathUtils.js";
import { WorkspacePattern, addWorkspacePattern, normalizeWorkspacePattern, workspacePatternMatchesManifest } from "./workspace.js";
import { stripTomlComment, tomlArrayIsClosed, tomlStringArrayValues } from "./toml.js";

const CARGO_WORKSPACE_MEMBER_EDGE_CONFIDENCE = 0.87;

export function cargoWorkspacePatterns(content: string): WorkspacePattern[] {
  const patterns: WorkspacePattern[] = [];
  let currentSection: string | undefined;
  let collectingKey: "members" | "exclude" | undefined;
  let collectedValue = "";

  const flushCollectedValue = (): void => {
    if (!collectingKey) {
      return;
    }
    for (const value of tomlStringArrayValues(collectedValue)) {
      addWorkspacePattern(
        patterns,
        collectingKey === "exclude" ? `!${value}` : value,
      );
    }
    collectingKey = undefined;
    collectedValue = "";
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = stripTomlComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const sectionMatch = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (sectionMatch?.[1]) {
      if (collectingKey) {
        flushCollectedValue();
      }
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (collectingKey) {
      collectedValue = `${collectedValue}\n${trimmed}`;
      if (tomlArrayIsClosed(collectedValue)) {
        flushCollectedValue();
      }
      continue;
    }

    if (currentSection !== "workspace") {
      continue;
    }

    const arrayMatch = /^(members|exclude)\s*=\s*(.+)$/.exec(trimmed);
    if (!arrayMatch?.[1] || !arrayMatch[2]) {
      continue;
    }

    const value = arrayMatch[2].trim();
    if (!value.startsWith("[")) {
      continue;
    }

    collectingKey = arrayMatch[1] as "members" | "exclude";
    collectedValue = value;
    if (tomlArrayIsClosed(collectedValue)) {
      flushCollectedValue();
    }
  }

  if (collectingKey) {
    flushCollectedValue();
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
