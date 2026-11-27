// sites-pinned: tests/audit/graph-path-utils.test.ts, tests/audit/graph-manifest-edges.test.ts
import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { compareCodeUnits, normalizeGraphPath } from "audit-tools/shared";

// Retain the extractor entry point for the shared normalizer in `src/shared/graph/graphPaths.ts`.
export { normalizeGraphPath };

// No "" entry: `resolveCandidate` tries the bare path first.
const RESOLVABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".py",
  ".pyi",
] as const;

const INDEX_EXTENSIONS = [
  "index.ts",
  "index.tsx",
  "index.mts",
  "index.cts",
  "index.js",
  "index.jsx",
  "index.mjs",
  "index.cjs",
  "index.json",
  "__init__.py",
  "__init__.pyi",
] as const;

const RUNTIME_SOURCE_EXTENSION_ALIASES: Record<string, readonly string[]> = {
  ".js": [".ts", ".tsx", ".jsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export function graphLookupKey(path: string): string {
  return normalizeGraphPath(path).toLowerCase();
}

/** Construct a manifest-local graph target; callers own probing and admission. */
export function resolveManifestRelativeTarget(
  fromPath: string,
  specifier: string,
): string | undefined {
  const normalizedSpecifier = normalizeGraphPath(specifier);
  if (
    normalizedSpecifier.length === 0 ||
    normalizedSpecifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedSpecifier)
  ) {
    return undefined;
  }

  const baseDir = posix.dirname(normalizeGraphPath(fromPath));
  return baseDir === "."
    ? normalizedSpecifier
    : posix.join(baseDir, normalizedSpecifier);
}

export function resolveCandidate(
  candidate: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalized = normalizeGraphPath(candidate);
  const direct = pathLookup.get(normalized.toLowerCase());
  if (direct) return direct;

  const runtimeExtension = posix.extname(normalized).toLowerCase();
  const sourceExtensionAliases =
    RUNTIME_SOURCE_EXTENSION_ALIASES[runtimeExtension];
  if (sourceExtensionAliases) {
    const withoutRuntimeExtension = normalized.slice(
      0,
      -runtimeExtension.length,
    );
    for (const sourceExtension of sourceExtensionAliases) {
      const match = pathLookup.get(
        `${withoutRuntimeExtension}${sourceExtension}`.toLowerCase(),
      );
      if (match) return match;
    }
  }

  for (const extension of RESOLVABLE_EXTENSIONS) {
    const withExtension = `${normalized}${extension}`;
    const match = pathLookup.get(withExtension.toLowerCase());
    if (match) return match;
  }

  for (const indexFile of INDEX_EXTENSIONS) {
    const match = pathLookup.get(
      posix.join(normalized, indexFile).toLowerCase(),
    );
    if (match) return match;
  }

  return undefined;
}

export function graphEdge(params: GraphEdge): GraphEdge {
  return {
    ...params,
    direction: params.direction ?? "directed",
  };
}

/** The identity of an edge: its endpoints and kind. Two edges with one signature are one edge. */
export function edgeSignature(edge: GraphEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.kind ?? ""}`;
}

/** The canonical edge order: `(from, to, kind)` by code units. */
export function compareGraphEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    compareCodeUnits(a.from, b.from) ||
    compareCodeUnits(a.to, b.to) ||
    compareCodeUnits(a.kind ?? "", b.kind ?? "")
  );
}

// ---- Cross-cluster shared helpers ----
// These are used by more than one graph extractor cluster (import/reference
// edges, routes, schemas, suites, test-source). They live here so each
// extractor module imports one implementation rather than re-forking it.

/** Source file extensions the graph extractors read and reason about. */
export const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".html",
  ".htm",
  ".yml",
  ".yaml",
  ".py",
  ".pyi",
  ".go",
  ".rs",
  ".java",
  ".cs",
] as const;

/** Matches any single/double/back-quoted string literal (bounded length). */
export const STRING_LITERAL_PATTERN = /["'`]([^"'`\r\n]{1,260})["'`]/g;

/** Resolve a relative import specifier to a repository path, if one exists. */
export function resolveSpecifier(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const baseDir = posix.dirname(normalizeGraphPath(fromPath));
  return resolveCandidate(posix.join(baseDir, specifier), pathLookup);
}

/** Resolve a string literal (relative or repo-rooted) to a repository path. */
export function resolveReferenceLiteral(
  fromPath: string,
  literal: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalizedLiteral = normalizeGraphPath(literal);
  if (literal.startsWith(".")) {
    return resolveSpecifier(fromPath, literal, pathLookup);
  }
  if (!normalizedLiteral.includes("/")) {
    return undefined;
  }
  return resolveCandidate(normalizedLiteral, pathLookup);
}

/**
 * The path without its `SOURCE_EXTENSIONS` extension (matched case-insensitively),
 * or `undefined` when the path has none of them.
 */
export function stripSourceExtension(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  const extension = SOURCE_EXTENSIONS.find((item) => lowerPath.endsWith(item));
  return extension ? path.slice(0, -extension.length) : undefined;
}

/** The lower-cased basename of a graph path: the key every filename predicate below reads. */
function lowerBasename(path: string): string {
  return posix.basename(normalizeGraphPath(path)).toLowerCase();
}

/** True for `*.schema.json` files (JSON Schema documents). */
export function isJsonSchemaPath(path: string): boolean {
  return lowerBasename(path).endsWith(".schema.json");
}

/** True for pytest `conftest.py` files. */
export function isPytestConftestPath(path: string): boolean {
  return lowerBasename(path) === "conftest.py";
}

// ---- Build-manifest path predicates ----
// One canonical set, shared by the graph manifest-edge extractor and the
// packetizer. Each preserves path case (so distinct files differing only by
// case are never collapsed) and matches the manifest filename
// case-insensitively, since manifest names are conventionally lowercase.

/** True for `package.json` files. */
export function isPackageManifestPath(path: string): boolean {
  return lowerBasename(path) === "package.json";
}

/** True for `tsconfig.json` / `tsconfig.<name>.json` project config files. */
export function isTypescriptProjectConfigPath(path: string): boolean {
  const basename = lowerBasename(path);
  return (
    basename === "tsconfig.json" ||
    (basename.startsWith("tsconfig.") && basename.endsWith(".json"))
  );
}

/** True for Go `go.mod` module manifests. */
export function isGoModuleManifestPath(path: string): boolean {
  return lowerBasename(path) === "go.mod";
}

/** True for Go `go.work` workspace manifests. */
export function isGoWorkspaceManifestPath(path: string): boolean {
  return lowerBasename(path) === "go.work";
}

/** True for Rust `Cargo.toml` manifests. */
export function isCargoManifestPath(path: string): boolean {
  return lowerBasename(path) === "cargo.toml";
}

/** True for Maven `pom.xml` manifests. */
export function isMavenPomPath(path: string): boolean {
  return lowerBasename(path) === "pom.xml";
}

/** True for Python `pyproject.toml` manifests. */
export function isPyprojectPath(path: string): boolean {
  return lowerBasename(path) === "pyproject.toml";
}

/** True for `pnpm-workspace.yaml` workspace manifests. */
export function isPnpmWorkspaceManifestPath(path: string): boolean {
  return lowerBasename(path) === "pnpm-workspace.yaml";
}
