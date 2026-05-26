import { posix } from "node:path";
import type { GraphEdge } from "../types/graph.js";

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

export function normalizeGraphPath(path: string): string {
  return posix
    .normalize(path.replace(/\\/g, "/"))
    .replace(/^\.\//, "");
}

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
