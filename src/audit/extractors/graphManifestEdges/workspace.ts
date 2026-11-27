// sites-pinned: tests/audit/graph-manifest-edges.test.ts, tests/audit/graph-edge-cache.test.ts
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

/**
 * Coerce a post-parse manifest value to a string[]: a string scalar → `[s]`
 * (both TOML and YAML allow a bare scalar where a list is expected), a string
 * array → its string elements, anything else → `[]`. Trims and drops empties
 * to match the prior line-scanner extractors' behavior. Operates on plain JS
 * values, so it is parser-agnostic — shared by the TOML (`smol-toml`) and YAML
 * (`yaml`) sides without coupling the parsers.
 */
export function manifestStringArray(value: unknown): string[] {
  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
  return raw.map((s) => s.trim()).filter((s) => s.length > 0);
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

function globPatternToRegExp(pattern: string): RegExp {
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

function workspaceMatcher(pattern: string, manifestSuffix: string) {
  const regex = globPatternToRegExp(pattern);
  const targetsFile = pattern.toLowerCase().endsWith(manifestSuffix);
  return (member: { path: string; dir: string }) => regex.test(targetsFile ? member.path : member.dir);
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

  const manifestSuffix = `/${manifestName.toLowerCase()}`;
  const positives: Array<{ pattern: string; matches: ReturnType<typeof workspaceMatcher> }> = [];
  const negatives: Array<ReturnType<typeof workspaceMatcher>> = [];
  for (const { pattern, negated } of rawPatterns) {
    const normalized = normalizeWorkspacePattern(fromPath, pattern);
    if (!normalized) continue;
    const matches = workspaceMatcher(normalized, manifestSuffix);
    if (negated) negatives.push(matches);
    else positives.push({ pattern: normalized, matches });
  }
  if (positives.length === 0) return [];

  const members: Array<{ target: string; path: string; dir: string }> = [];
  for (const target of pathLookup.values()) {
    if (target === fromPath || !isMemberManifest(target)) continue;
    const path = normalizeGraphPath(target);
    members.push({ target, path, dir: posix.dirname(path) });
  }

  const edges: GraphEdge[] = [];
  for (const { pattern, matches } of positives) {
    for (const member of members) {
      if (!matches(member) || negatives.some(excludes => excludes(member))) continue;
      const { target } = member;
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
