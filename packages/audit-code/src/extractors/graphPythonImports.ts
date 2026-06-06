import { posix } from "node:path";
import type { GraphEdge } from "@audit-tools/shared";
import {
  graphEdge,
  normalizeGraphPath,
  resolveCandidate,
} from "./graphPathUtils.js";

const PYTHON_SOURCE_EXTENSIONS = [".py", ".pyi"] as const;
const PYTHON_PACKAGE_INDEX_FILES = ["__init__.py", "__init__.pyi"] as const;
const IMPORT_EDGE_CONFIDENCE = 0.95;

export function isPythonSourcePath(path: string): boolean {
  const normalized = normalizeGraphPath(path).toLowerCase();
  return PYTHON_SOURCE_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

function stripPythonLineComment(line: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index);
    }
  }

  return line;
}

function pythonParenDelta(line: string): number {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let delta = 0;

  for (const char of line) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") {
      delta += 1;
    } else if (char === ")") {
      delta -= 1;
    }
  }

  return delta;
}

function pythonLogicalLines(content: string): string[] {
  const logicalLines: string[] = [];
  let pending = "";
  let parenDepth = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const stripped = stripPythonLineComment(rawLine).trim();
    if (stripped.length === 0) {
      continue;
    }
    if (pending.length === 0 && !/^(?:import|from)\s+/i.test(stripped)) {
      continue;
    }

    const continued = stripped.endsWith("\\");
    const line = continued ? stripped.slice(0, -1).trimEnd() : stripped;
    pending = pending.length > 0 ? `${pending} ${line}` : line;
    parenDepth = Math.max(0, parenDepth + pythonParenDelta(line));

    if (!continued && parenDepth <= 0) {
      logicalLines.push(pending.replace(/\s+/g, " ").trim());
      pending = "";
      parenDepth = 0;
    }
  }

  if (pending.length > 0) {
    logicalLines.push(pending.replace(/\s+/g, " ").trim());
  }

  return logicalLines;
}

function unwrapPythonImportList(value: string): string {
  let trimmed = value.trim();
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitPythonImportList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let parenDepth = 0;

  for (const char of unwrapPythonImportList(value)) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (quote) {
      current += char;
      if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      current += char;
      continue;
    }
    if (char === "," && parenDepth === 0) {
      const item = current.trim();
      if (item.length > 0) {
        items.push(item);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const item = current.trim();
  if (item.length > 0) {
    items.push(item);
  }
  return items;
}

function stripPythonAlias(value: string): string {
  return value.replace(/\s+as\s+[A-Za-z_]\w*$/i, "").trim();
}

function isPythonIdentifier(value: string): boolean {
  return /^[A-Za-z_]\w*$/.test(value);
}

function isPythonAbsoluteModuleSpecifier(value: string): boolean {
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value);
}

function isPythonRelativeModuleSpecifier(value: string): boolean {
  return /^\.+(?:[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/.test(value);
}

function isPythonModuleSpecifier(value: string): boolean {
  return (
    isPythonAbsoluteModuleSpecifier(value) ||
    isPythonRelativeModuleSpecifier(value)
  );
}

function pythonModulePath(specifier: string): string {
  return specifier.split(".").filter(Boolean).join("/");
}

function resolvePythonPathCandidate(
  candidate: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalized = normalizeGraphPath(candidate).replace(/\/+$/, "");
  if (normalized.length === 0 || normalized === "." || normalized === "..") {
    return undefined;
  }
  return resolveCandidate(normalized, pathLookup);
}

function pythonPathMatchesModule(path: string, modulePath: string): boolean {
  const normalizedPath = normalizeGraphPath(path).toLowerCase();
  const normalizedModulePath = normalizeGraphPath(modulePath).toLowerCase();
  return (
    PYTHON_SOURCE_EXTENSIONS.some((extension) => {
      const moduleFile = `${normalizedModulePath}${extension}`;
      return (
        normalizedPath === moduleFile ||
        normalizedPath.endsWith(`/${moduleFile}`)
      );
    }) ||
    PYTHON_PACKAGE_INDEX_FILES.some((indexFile) => {
      const packageFile = posix.join(normalizedModulePath, indexFile);
      return (
        normalizedPath === packageFile ||
        normalizedPath.endsWith(`/${packageFile}`)
      );
    })
  );
}

function commonDirectoryPrefixLength(left: string, right: string): number {
  const leftParts = normalizeGraphPath(left).split("/").filter(Boolean);
  const rightParts = normalizeGraphPath(right).split("/").filter(Boolean);
  let count = 0;
  while (
    count < leftParts.length &&
    count < rightParts.length &&
    leftParts[count]!.toLowerCase() === rightParts[count]!.toLowerCase()
  ) {
    count += 1;
  }
  return count;
}

function resolvePythonAbsoluteModuleSpecifier(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const modulePath = pythonModulePath(specifier);
  const direct = resolvePythonPathCandidate(modulePath, pathLookup);
  if (direct) {
    return direct;
  }

  const matches = [...new Set(pathLookup.values())].filter(
    (path) =>
      isPythonSourcePath(path) && pythonPathMatchesModule(path, modulePath),
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    return undefined;
  }

  const fromDir = posix.dirname(normalizeGraphPath(fromPath));
  const scored = matches
    .map((target) => ({
      target,
      score: commonDirectoryPrefixLength(
        fromDir,
        posix.dirname(normalizeGraphPath(target)),
      ),
    }))
    .sort((a, b) => b.score - a.score || a.target.localeCompare(b.target));
  const bestScore = scored[0]?.score ?? 0;
  const bestMatches = scored.filter((item) => item.score === bestScore);
  if (bestScore > 0 && bestMatches.length === 1) {
    return bestMatches[0]!.target;
  }

  const srcMatches = matches.filter((target) =>
    normalizeGraphPath(target).toLowerCase().startsWith("src/"),
  );
  return srcMatches.length === 1 ? srcMatches[0] : undefined;
}

function resolvePythonRelativeModuleSpecifier(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const match = /^(\.+)(.*)$/.exec(specifier);
  if (!match) {
    return undefined;
  }

  const level = match[1]!.length;
  const remainder = match[2] ?? "";
  let baseDir = posix.dirname(normalizeGraphPath(fromPath));
  for (let index = 1; index < level; index++) {
    const next = posix.dirname(baseDir);
    if (next === baseDir) {
      return undefined;
    }
    baseDir = next;
  }

  const modulePath = pythonModulePath(remainder);
  const candidate = modulePath.length > 0 ? posix.join(baseDir, modulePath) : baseDir;
  return resolvePythonPathCandidate(candidate, pathLookup);
}

function resolvePythonModuleSpecifier(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  if (isPythonRelativeModuleSpecifier(specifier)) {
    return resolvePythonRelativeModuleSpecifier(fromPath, specifier, pathLookup);
  }
  if (isPythonAbsoluteModuleSpecifier(specifier)) {
    return resolvePythonAbsoluteModuleSpecifier(fromPath, specifier, pathLookup);
  }
  return undefined;
}

function appendPythonImportedSpecifier(
  moduleSpecifier: string,
  importedName: string,
): string {
  return moduleSpecifier.endsWith(".")
    ? `${moduleSpecifier}${importedName}`
    : `${moduleSpecifier}.${importedName}`;
}

function addPythonImportEdge(
  edges: GraphEdge[],
  fromPath: string,
  target: string | undefined,
  kind: "python-import" | "python-from-import",
  specifier: string,
): void {
  if (!target || target === fromPath) {
    return;
  }
  edges.push(
    graphEdge({
      from: fromPath,
      to: target,
      kind,
      confidence: IMPORT_EDGE_CONFIDENCE,
      reason: `Resolved Python import specifier '${specifier}'.`,
    }),
  );
}

/**
 * Resolve a single `import <spec>` module specifier to a repo file, or
 * undefined. Shared with the tree-sitter Python analyzer so AST-extracted
 * imports resolve to exactly the same targets as the regex floor.
 */
export function resolvePythonImportTarget(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  if (!isPythonAbsoluteModuleSpecifier(specifier)) {
    return undefined;
  }
  return resolvePythonModuleSpecifier(fromPath, specifier, pathLookup);
}

/**
 * Resolve a `from <module> import <names>` statement to repo files. Mirrors the
 * floor: prefer submodule files (`module.name`), else the module itself. Shared
 * with the tree-sitter Python analyzer.
 */
export function resolvePythonFromImportTargets(
  fromPath: string,
  moduleSpecifier: string,
  importedNames: string[],
  pathLookup: Map<string, string>,
): Array<{ specifier: string; target: string }> {
  if (!isPythonModuleSpecifier(moduleSpecifier)) {
    return [];
  }
  const submoduleTargets = importedNames
    .filter((name) => name !== "*" && isPythonIdentifier(name))
    .map((name) => appendPythonImportedSpecifier(moduleSpecifier, name))
    .map((specifier) => ({
      specifier,
      target: resolvePythonModuleSpecifier(fromPath, specifier, pathLookup),
    }))
    .filter(
      (item): item is { specifier: string; target: string } =>
        item.target !== undefined && item.target !== fromPath,
    );
  if (submoduleTargets.length > 0) {
    return submoduleTargets;
  }
  const moduleTarget = resolvePythonModuleSpecifier(
    fromPath,
    moduleSpecifier,
    pathLookup,
  );
  return moduleTarget && moduleTarget !== fromPath
    ? [{ specifier: moduleSpecifier, target: moduleTarget }]
    : [];
}

export function extractPythonImportEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isPythonSourcePath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const line of pythonLogicalLines(content)) {
    const importMatch = /^import\s+(.+)$/i.exec(line);
    if (importMatch) {
      for (const rawSpecifier of splitPythonImportList(importMatch[1] ?? "")) {
        const specifier = stripPythonAlias(rawSpecifier);
        if (!isPythonAbsoluteModuleSpecifier(specifier)) {
          continue;
        }
        addPythonImportEdge(
          edges,
          fromPath,
          resolvePythonModuleSpecifier(fromPath, specifier, pathLookup),
          "python-import",
          specifier,
        );
      }
      continue;
    }

    const fromImportMatch = /^from\s+([.\w]+)\s+import\s+(.+)$/i.exec(line);
    if (!fromImportMatch) {
      continue;
    }

    const moduleSpecifier = fromImportMatch[1] ?? "";
    const rawNames = splitPythonImportList(fromImportMatch[2] ?? "").map(stripPythonAlias);
    for (const { specifier, target } of resolvePythonFromImportTargets(
      fromPath,
      moduleSpecifier,
      rawNames,
      pathLookup,
    )) {
      addPythonImportEdge(edges, fromPath, target, "python-from-import", specifier);
    }
  }

  return edges;
}
