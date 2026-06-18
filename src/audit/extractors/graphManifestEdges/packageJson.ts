import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { graphEdge, normalizeGraphPath, resolveCandidate, isPackageManifestPath } from "../graphPathUtils.js";
import {
  WorkspacePattern,
  addWorkspacePattern,
  collectWorkspacePatternValues,
  normalizeWorkspacePattern,
  workspacePatternMatchesPackage,
} from "./workspace.js";
import { pnpmWorkspacePatterns } from "./pnpm.js";
import { isPnpmWorkspaceManifestPath } from "../graphPathUtils.js";

export const PACKAGE_ENTRYPOINT_EDGE_CONFIDENCE = 0.9;
export const PACKAGE_SCRIPT_EDGE_CONFIDENCE = 0.88;
export const WORKSPACE_PACKAGE_EDGE_CONFIDENCE = 0.86;
export const PACKAGE_SCRIPT_REFERENCE_PATTERN =
  /(?:^|[\s"'`])((?:\.{1,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx))(?:$|[\s"'`])/gi;

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
  content: string,
): Array<{ field: string; specifier: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const record = parsed as Record<string, unknown>;
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
  const normalizedSpecifier = normalizeGraphPath(specifier);
  if (
    normalizedSpecifier.length === 0 ||
    normalizedSpecifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedSpecifier)
  ) {
    return undefined;
  }

  const packageDir = posix.dirname(normalizeGraphPath(packagePath));
  const packageRelative =
    packageDir === "."
      ? normalizedSpecifier
      : posix.join(packageDir, normalizedSpecifier);
  return resolveCandidate(packageRelative, pathLookup);
}

export function extractPackageEntrypointEdges(
  fromPath: string,
  content: string,
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
  content: string,
): Array<{ script: string; specifier: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const scripts = (parsed as Record<string, unknown>).scripts;
  if (
    scripts === null ||
    typeof scripts !== "object" ||
    Array.isArray(scripts)
  ) {
    return [];
  }

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
  content: string,
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

export function packageWorkspacePatterns(content: string): WorkspacePattern[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [];
  }

  const record = parsed as Record<string, unknown>;
  const patterns: WorkspacePattern[] = [];
  collectWorkspacePatternValues(record.workspaces, patterns);
  if (
    record.workspaces !== null &&
    typeof record.workspaces === "object" &&
    !Array.isArray(record.workspaces)
  ) {
    collectWorkspacePatternValues(
      (record.workspaces as Record<string, unknown>).packages,
      patterns,
    );
  }
  return patterns;
}

function workspacePatternsForFile(
  path: string,
  content: string,
): WorkspacePattern[] {
  if (isPackageManifestPath(path)) {
    return packageWorkspacePatterns(content);
  }
  if (isPnpmWorkspaceManifestPath(path)) {
    return pnpmWorkspacePatterns(content);
  }
  return [];
}

export function extractWorkspacePackageEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  const rawPatterns = workspacePatternsForFile(fromPath, content);
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
      if (target === fromPath || !isPackageManifestPath(target)) {
        continue;
      }
      if (!workspacePatternMatchesPackage(pattern, target)) {
        continue;
      }
      if (
        negativePatterns.some((negativePattern) =>
          workspacePatternMatchesPackage(negativePattern, target),
        )
      ) {
        continue;
      }
      edges.push(
        graphEdge({
          from: fromPath,
          to: target,
          kind: "workspace-package-link",
          confidence: WORKSPACE_PACKAGE_EDGE_CONFIDENCE,
          reason: `Workspace pattern '${pattern}' includes package manifest '${target}'.`,
        }),
      );
    }
  }
  return edges;
}
