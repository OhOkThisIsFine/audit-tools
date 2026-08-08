import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { graphEdge, normalizeGraphPath } from "../graphPathUtils.js";

export interface WorkspacePattern {
  pattern: string;
  negated: boolean;
}

export function addWorkspacePattern(
  patterns: WorkspacePattern[],
  rawPattern: string,
): void {
  const trimmedPattern = rawPattern.trim();
  if (trimmedPattern.length === 0) {
    return;
  }
  const negated = trimmedPattern.startsWith("!");
  const pattern = negated ? trimmedPattern.slice(1).trim() : trimmedPattern;
  if (pattern.length > 0) {
    patterns.push({ pattern, negated });
  }
}

export function collectWorkspacePatternValues(
  value: unknown,
  patterns: WorkspacePattern[],
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    addWorkspacePattern(patterns, item);
  }
}

export function normalizeWorkspacePattern(
  workspacePath: string,
  pattern: string,
): string | undefined {
  const normalizedPattern = pattern
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    normalizedPattern.length === 0 ||
    normalizedPattern.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedPattern)
  ) {
    return undefined;
  }

  const workspaceDir = posix.dirname(normalizeGraphPath(workspacePath));
  return workspaceDir === "."
    ? normalizedPattern
    : posix.join(workspaceDir, normalizedPattern);
}

export function globPatternToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

export function workspacePatternMatchesManifest(
  workspacePattern: string,
  manifestPath: string,
  manifestName: string,
): boolean {
  const normalizedManifestPath = normalizeGraphPath(manifestPath);
  const manifestDir = posix.dirname(normalizedManifestPath);
  const lowerManifestPattern = `/${manifestName.toLowerCase()}`;
  const patternTarget = workspacePattern.toLowerCase().endsWith(lowerManifestPattern)
    ? normalizedManifestPath
    : manifestDir;
  return globPatternToRegExp(workspacePattern).test(patternTarget);
}

/**
 * The workspace member-resolution algorithm shared by every manifest ecosystem:
 * normalize each raw pattern against the declaring manifest, split positive from
 * negated, cross-product the positives against the repo path lookup, and drop
 * any target a negation also matches.
 *
 * Ecosystems differ only in the four values passed in — which manifest filename
 * marks a member, which paths count as a manifest, and the edge's kind /
 * confidence / reason. Those are genuine INPUT, not policy knobs selected here.
 *
 * Iteration order of `pathLookup` does NOT reach the artifact: these edges land
 * in `acc.references`, which `uniqueSortedEdges` dedupes and sorts by
 * from/to/kind before it is hashed, so the content-derived order invariant holds
 * downstream rather than here.
 */
export function workspaceMemberEdges(options: {
  fromPath: string;
  rawPatterns: WorkspacePattern[];
  pathLookup: Map<string, string>;
  manifestName: string;
  isMemberManifest: (path: string) => boolean;
  kind: string;
  confidence: number;
  reason: (pattern: string, target: string) => string;
}): GraphEdge[] {
  const {
    fromPath,
    rawPatterns,
    pathLookup,
    manifestName,
    isMemberManifest,
    kind,
    confidence,
    reason,
  } = options;

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
      if (target === fromPath || !isMemberManifest(target)) {
        continue;
      }
      if (!workspacePatternMatchesManifest(pattern, target, manifestName)) {
        continue;
      }
      if (
        negativePatterns.some((negativePattern) =>
          workspacePatternMatchesManifest(negativePattern, target, manifestName),
        )
      ) {
        continue;
      }
      edges.push(
        graphEdge({
          from: fromPath,
          to: target,
          kind,
          confidence,
          reason: reason(pattern, target),
        }),
      );
    }
  }
  return edges;
}
