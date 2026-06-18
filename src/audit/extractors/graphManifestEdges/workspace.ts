import { posix } from "node:path";
import { normalizeGraphPath } from "../graphPathUtils.js";

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

export function workspacePatternMatchesPackage(
  workspacePattern: string,
  packagePath: string,
): boolean {
  return workspacePatternMatchesManifest(
    workspacePattern,
    packagePath,
    "package.json",
  );
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
