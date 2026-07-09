import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { normalizeGraphPath } from "audit-tools/shared";

// `normalizeGraphPath` is single-sourced in `audit-tools/shared` (the shared
// continuity scorer needs it too). Re-exported here so all 28 audit import sites
// that read it from this module are unchanged.
export { normalizeGraphPath };

const RESOLVABLE_EXTENSIONS = [
  "",
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

/** True for `*.schema.json` files (JSON Schema documents). */
export function isJsonSchemaPath(path: string): boolean {
  return posix
    .basename(normalizeGraphPath(path))
    .toLowerCase()
    .endsWith(".schema.json");
}

/** True for pytest `conftest.py` files. */
export function isPytestConftestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "conftest.py";
}

// ---- Build-manifest path predicates ----
// One canonical set, shared by the graph manifest-edge extractor and the
// packetizer. Each preserves path case (so distinct files differing only by
// case are never collapsed) and matches the manifest filename
// case-insensitively, since manifest names are conventionally lowercase.

/** True for `package.json` files. */
export function isPackageManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "package.json";
}

/** True for `tsconfig.json` / `tsconfig.<name>.json` project config files. */
export function isTypescriptProjectConfigPath(path: string): boolean {
  const basename = posix.basename(normalizeGraphPath(path)).toLowerCase();
  return (
    basename === "tsconfig.json" ||
    (basename.startsWith("tsconfig.") && basename.endsWith(".json"))
  );
}

/** True for Go `go.mod` module manifests. */
export function isGoModuleManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "go.mod";
}

/** True for Go `go.work` workspace manifests. */
export function isGoWorkspaceManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "go.work";
}

/** True for Rust `Cargo.toml` manifests. */
export function isCargoManifestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "cargo.toml";
}

/** True for Maven `pom.xml` manifests. */
export function isMavenPomPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "pom.xml";
}

/** True for Python `pyproject.toml` manifests. */
export function isPyprojectPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "pyproject.toml";
}

/** True for `pnpm-workspace.yaml` workspace manifests. */
export function isPnpmWorkspaceManifestPath(path: string): boolean {
  return (
    posix.basename(normalizeGraphPath(path)).toLowerCase() ===
    "pnpm-workspace.yaml"
  );
}
