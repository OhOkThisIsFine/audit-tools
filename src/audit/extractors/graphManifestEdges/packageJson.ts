// sites-pinned: tests/audit/graph-manifest-edges.test.ts, tests/audit/graph-edge-cache.test.ts
import type { GraphEdge } from "audit-tools/shared";
import { isRecord } from "audit-tools/shared";
import {
  graphEdge,
  isPackageManifestPath,
  isPnpmWorkspaceManifestPath,
  resolveCandidate,
  resolveManifestRelativeTarget,
} from "../graphPathUtils.js";
import {
  WorkspacePattern,
  collectWorkspacePatternValues,
  workspaceMemberEdges,
} from "./workspace.js";
import { pnpmWorkspacePatterns } from "./pnpm.js";

export const PACKAGE_ENTRYPOINT_EDGE_CONFIDENCE = 0.9;
export const PACKAGE_SCRIPT_EDGE_CONFIDENCE = 0.88;
export const WORKSPACE_PACKAGE_EDGE_CONFIDENCE = 0.86;
export const PACKAGE_SCRIPT_REFERENCE_PATTERN =
  /(?:^|[\s"'`])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx))(?:$|[\s"'`])/gi;

// The graph builder shares one parsed object among the three package readers;
// standalone readers can still take raw text. Undefined is a failed parse.
type PackageContent = string | Record<string, unknown> | undefined;

function packageRecord(content: PackageContent): Record<string, unknown> | undefined {
  return typeof content === "string" ? parsePackageRecord(content) : content;
}

function collectPackageEntrypointValues(
  value: unknown,
  fieldPath: string,
  entries: Array<{ field: string; specifier: string }>,
): void {
  if (typeof value === "string") {
    if (value.trim().length > 0) {
      entries.push({ field: fieldPath, specifier: value });
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectPackageEntrypointValues(item, `${fieldPath}.${index}`, entries),
    );
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    collectPackageEntrypointValues(item, `${fieldPath}.${key}`, entries);
  }
}

export function packageEntrypointCandidates(
  content: PackageContent,
): Array<{ field: string; specifier: string }> {
  const record = packageRecord(content);
  if (!record) return [];

  const entries: Array<{ field: string; specifier: string }> = [];
  for (const field of ["main", "module", "types", "typings", "browser"]) {
    collectPackageEntrypointValues(record[field], field, entries);
  }
  collectPackageEntrypointValues(record.bin, "bin", entries);
  collectPackageEntrypointValues(record.exports, "exports", entries);
  return entries;
}

export function resolvePackageEntrypoint(
  packagePath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const target = resolveManifestRelativeTarget(packagePath, specifier);
  if (target === undefined) return undefined;
  return resolveCandidate(target, pathLookup);
}

export function extractPackageEntrypointEdges(
  fromPath: string,
  content: PackageContent,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isPackageManifestPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const { field, specifier } of packageEntrypointCandidates(content)) {
    const target = resolvePackageEntrypoint(fromPath, specifier, pathLookup);
    if (!target) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "package-entrypoint-link",
        confidence: PACKAGE_ENTRYPOINT_EDGE_CONFIDENCE,
        reason: `Package manifest field '${field}' points to '${specifier}'.`,
      }),
    );
  }
  return edges;
}

export function packageScriptCandidates(
  content: PackageContent,
): Array<{ script: string; specifier: string }> {
  const scripts = packageRecord(content)?.scripts;
  if (!isRecord(scripts)) return [];

  const entries: Array<{ script: string; specifier: string }> = [];
  for (const [script, command] of Object.entries(scripts)) {
    if (typeof command !== "string") {
      continue;
    }
    PACKAGE_SCRIPT_REFERENCE_PATTERN.lastIndex = 0;
    for (const match of command.matchAll(PACKAGE_SCRIPT_REFERENCE_PATTERN)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        entries.push({ script, specifier });
      }
    }
  }
  return entries;
}

export function extractPackageScriptEdges(
  fromPath: string,
  content: PackageContent,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isPackageManifestPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const { script, specifier } of packageScriptCandidates(content)) {
    const target = resolvePackageEntrypoint(fromPath, specifier, pathLookup);
    if (!target) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "package-script-link",
        confidence: PACKAGE_SCRIPT_EDGE_CONFIDENCE,
        reason: `Package script '${script}' references '${specifier}'.`,
      }),
    );
  }
  return edges;
}

export function packageWorkspacePatterns(content: PackageContent): WorkspacePattern[] {
  const record = packageRecord(content);
  if (!record) return [];

  const patterns: WorkspacePattern[] = [];
  collectWorkspacePatternValues(record.workspaces, patterns);
  if (isRecord(record.workspaces)) {
    collectWorkspacePatternValues(record.workspaces.packages, patterns);
  }
  return patterns;
}

/**
 * The package.json object, or `undefined` when the text is not JSON or not a
 * JSON object: each reader then degrades to empty and never throws.
 */
export function parsePackageRecord(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function workspacePatternsForFile(
  path: string,
  content: PackageContent,
): WorkspacePattern[] {
  if (isPackageManifestPath(path)) {
    return packageWorkspacePatterns(content);
  }
  if (isPnpmWorkspaceManifestPath(path) && typeof content === "string") {
    return pnpmWorkspacePatterns(content);
  }
  return [];
}

export function extractWorkspacePackageEdges(
  fromPath: string,
  content: PackageContent,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  return workspaceMemberEdges({
    fromPath,
    rawPatterns: workspacePatternsForFile(fromPath, content),
    pathLookup,
    manifestName: "package.json",
    isMemberManifest: isPackageManifestPath,
    kind: "workspace-package-link",
    confidence: WORKSPACE_PACKAGE_EDGE_CONFIDENCE,
    reason: (pattern, target) =>
      `Workspace pattern '${pattern}' includes package manifest '${target}'.`,
  });
}
