import { posix } from "node:path";
import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, normalizeGraphPath, resolveCandidate } from "../graphPathUtils.js";
import { stripYamlComment, unquoteYamlScalar } from "./yaml.js";

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

function extractYamlScalarValues(content: string): string[] {
  const values: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    let rawValue: string | undefined;

    // key: value
    const keyValueMatch = /^[^:[\]{}]+:\s+(.+)$/.exec(trimmed);
    if (keyValueMatch?.[1]) {
      rawValue = keyValueMatch[1].trim();
    } else {
      // - value (list item)
      const listItemMatch = /^-\s+(.+)$/.exec(trimmed);
      if (listItemMatch?.[1]) {
        rawValue = listItemMatch[1].trim();
      }
    }

    if (!rawValue) continue;
    const value = unquoteYamlScalar(rawValue);
    if (looksLikeConfigFilePath(value)) {
      values.push(value);
    }
  }
  return values;
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
