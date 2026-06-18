import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { scanStringAware } from "audit-tools/shared";
import { graphEdge, normalizeGraphPath, isGoModuleManifestPath, isGoWorkspaceManifestPath } from "../graphPathUtils.js";

export const GO_WORKSPACE_MODULE_EDGE_CONFIDENCE = 0.87;

const GO_SCAN_OPTIONS = {
  quoteChars: ['"', "`"] as const,
  // Backtick raw strings do not honour backslash escapes.
  escapedQuotes: ['"'] as const,
};

export function stripGoLineComment(line: string): string {
  let commentIndex: number | undefined;

  scanStringAware(
    line,
    GO_SCAN_OPTIONS,
    {
      onUnquoted(char, i) {
        if (char === "/" && line[i + 1] === "/") {
          commentIndex = i;
          return false;
        }
      },
    },
  );

  return commentIndex !== undefined ? line.slice(0, commentIndex) : line;
}

function unquoteGoWorkspaceSpecifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  if (trimmed[0] === '"' && trimmed.at(-1) === '"') {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed.trim() : trimmed;
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }

  if (trimmed[0] === "`" && trimmed.at(-1) === "`") {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function splitGoWorkspaceSpecifiers(value: string): string[] {
  const specifiers: string[] = [];
  let tokenStart: number | undefined;

  // Use scanStringAware to correctly skip over quoted string content, and
  // detect whitespace-delimited token boundaries in unquoted regions.
  // Quoted tokens are captured from the opening quote (tokenStart) through
  // the closing quote (flushed on the next whitespace event), so that
  // unquoteGoWorkspaceSpecifier sees the delimiters and can strip them.
  scanStringAware(
    value,
    GO_SCAN_OPTIONS,
    {
      onQuoteOpen(_q, i) {
        tokenStart ??= i; // quoted token begins at the opening quote
      },
      onUnquoted(char, i) {
        if (/\s/.test(char)) {
          if (tokenStart !== undefined) {
            const specifier = unquoteGoWorkspaceSpecifier(value.slice(tokenStart, i));
            if (specifier.length > 0) {
              specifiers.push(specifier);
            }
            tokenStart = undefined;
          }
        } else {
          tokenStart ??= i;
        }
      },
    },
  );

  // Flush final token (no trailing whitespace).
  if (tokenStart !== undefined) {
    const specifier = unquoteGoWorkspaceSpecifier(value.slice(tokenStart));
    if (specifier.length > 0) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function goWorkspaceUseSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let inUseBlock = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = stripGoLineComment(rawLine).trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (inUseBlock) {
      const closeIndex = trimmed.indexOf(")");
      const body =
        closeIndex >= 0 ? trimmed.slice(0, closeIndex).trim() : trimmed;
      specifiers.push(...splitGoWorkspaceSpecifiers(body));
      if (closeIndex >= 0) {
        inUseBlock = false;
      }
      continue;
    }

    const useMatch = /^use(?:\s+(.+)|\s*)$/.exec(trimmed);
    if (!useMatch) {
      continue;
    }

    let body = useMatch[1]?.trim() ?? "";
    if (!body.startsWith("(")) {
      specifiers.push(...splitGoWorkspaceSpecifiers(body));
      continue;
    }

    body = body.slice(1).trim();
    const closeIndex = body.indexOf(")");
    if (closeIndex >= 0) {
      specifiers.push(
        ...splitGoWorkspaceSpecifiers(body.slice(0, closeIndex).trim()),
      );
    } else {
      specifiers.push(...splitGoWorkspaceSpecifiers(body));
      inUseBlock = true;
    }
  }

  return specifiers;
}

function resolveGoWorkspaceModuleReference(
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

  const workspaceDir = posix.dirname(normalizeGraphPath(fromPath));
  const target =
    workspaceDir === "."
      ? normalizedSpecifier
      : posix.join(workspaceDir, normalizedSpecifier);
  const direct = pathLookup.get(target.toLowerCase());
  if (direct && isGoModuleManifestPath(direct)) {
    return direct;
  }

  return pathLookup.get(posix.join(target, "go.mod").toLowerCase());
}

export function extractGoWorkspaceModuleEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isGoWorkspaceManifestPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const specifier of goWorkspaceUseSpecifiers(content)) {
    const target = resolveGoWorkspaceModuleReference(
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
        kind: "go-workspace-module-link",
        confidence: GO_WORKSPACE_MODULE_EDGE_CONFIDENCE,
        reason: `Go workspace use directive '${specifier}' resolves to module '${target}'.`,
      }),
    );
  }
  return edges;
}
