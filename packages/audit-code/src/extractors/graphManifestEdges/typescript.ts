import { posix } from "node:path";
import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, normalizeGraphPath, resolveCandidate, isTypescriptProjectConfigPath } from "../graphPathUtils.js";
import { parseJsoncObject } from "./jsonc.js";

export const TYPESCRIPT_PROJECT_REFERENCE_EDGE_CONFIDENCE = 0.87;

function typescriptProjectReferenceSpecifiers(content: string): string[] {
  const parsed = parseJsoncObject(content);
  if (!parsed || !Array.isArray(parsed.references)) {
    return [];
  }

  return parsed.references
    .map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const referencePath = (item as Record<string, unknown>).path;
      return typeof referencePath === "string" ? referencePath.trim() : undefined;
    })
    .filter((specifier): specifier is string => Boolean(specifier));
}

function resolveTypescriptProjectReference(
  fromPath: string,
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

  const configDir = posix.dirname(normalizeGraphPath(fromPath));
  const target =
    configDir === "."
      ? normalizedSpecifier
      : posix.join(configDir, normalizedSpecifier);
  const direct = resolveCandidate(target, pathLookup);
  if (direct && isTypescriptProjectConfigPath(direct)) {
    return direct;
  }

  return pathLookup.get(posix.join(target, "tsconfig.json").toLowerCase());
}

export function extractTypescriptProjectReferenceEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isTypescriptProjectConfigPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const specifier of typescriptProjectReferenceSpecifiers(content)) {
    const target = resolveTypescriptProjectReference(
      fromPath,
      specifier,
      pathLookup,
    );
    if (!target) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "typescript-project-reference-link",
        confidence: TYPESCRIPT_PROJECT_REFERENCE_EDGE_CONFIDENCE,
        reason: `TypeScript project reference '${specifier}' resolves to '${target}'.`,
      }),
    );
  }
  return edges;
}
