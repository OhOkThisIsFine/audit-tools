import { posix } from "node:path";
import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, normalizeGraphPath, resolveCandidate } from "../graphPathUtils.js";
import { parseYamlSafe, collectYamlStringScalars } from "./yaml.js";

export const YAML_PATH_REFERENCE_LINK_CONFIDENCE = 0.8;
export const YAML_CONFIG_EXTENSIONS = [".yaml", ".yml", ".json", ".toml"] as const;

function isYamlSourcePath(path: string): boolean {
  const lower = normalizeGraphPath(path).toLowerCase();
  return lower.endsWith(".yaml") || lower.endsWith(".yml");
}

function looksLikeConfigFilePath(value: string): boolean {
  if (!value.includes("/")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (value.startsWith("/")) return false;
  const lower = value.toLowerCase();
  return YAML_CONFIG_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Every config-path-looking string anywhere in the YAML document. Parsing with
 * a vetted parser then walking ALL string scalars (vs the prior line regex that
 * saw only top-level `key: value` and `- item` lines) recovers path references
 * nested inside maps, block sequences, and flow collections the scanner missed.
 */
function extractYamlScalarValues(content: string): string[] {
  const root = parseYamlSafe(content);
  if (root === undefined) return [];
  return collectYamlStringScalars(root)
    .map((s) => s.trim())
    .filter((value) => looksLikeConfigFilePath(value));
}

function resolveYamlPathReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const normalized = normalizeGraphPath(specifier.replace(/^\.\//, ""));
  if (normalized.length === 0) return undefined;

  // Try as repo-root-relative first (many YAML configs use repo-root paths)
  const repoRootTarget = resolveCandidate(normalized, pathLookup);
  if (repoRootTarget) return repoRootTarget;

  // Fallback: relative to the YAML file's directory
  const fromDir = posix.dirname(normalizeGraphPath(fromPath));
  if (fromDir !== ".") {
    const dirRelative = posix.join(fromDir, normalized);
    const dirTarget = resolveCandidate(dirRelative, pathLookup);
    if (dirTarget) return dirTarget;
  }

  return undefined;
}

export function extractYamlPathReferenceEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isYamlSourcePath(fromPath)) return [];

  const values = extractYamlScalarValues(content);
  if (values.length === 0) return [];

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const target = resolveYamlPathReference(fromPath, value, pathLookup);
    if (!target || target === fromPath || seen.has(target)) continue;
    seen.add(target);
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "yaml-path-reference-link",
        confidence: YAML_PATH_REFERENCE_LINK_CONFIDENCE,
        reason: `YAML file references path '${value}'.`,
      }),
    );
  }
  return edges;
}
