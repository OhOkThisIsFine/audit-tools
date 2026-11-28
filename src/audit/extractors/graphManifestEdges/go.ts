// sites-pinned: tests/audit/graph-manifest-edges.test.ts, tests/audit/graph-edge-cache.test.ts
import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { scanStringAware } from "audit-tools/shared";
import { graphEdge, resolveManifestRelativeTarget, isGoModuleManifestPath, isGoWorkspaceManifestPath } from "../graphPathUtils.js";

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

function unquoteGoWorkspaceSpecifier(value: string): string | undefined {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  if (/^`[^`]*`$/.test(value)) {
    return value.slice(1, -1).trim();
  }

  return /["`]/.test(value) ? undefined : value;
}

export function splitGoWorkspaceSpecifiers(value: string): string[] {
  const specifiers: string[] = [];
  let tokenStart: number | undefined;
  function flushToken(end: number): void {
    if (tokenStart === undefined) return;
    const specifier = unquoteGoWorkspaceSpecifier(value.slice(tokenStart, end));
    if (specifier) specifiers.push(specifier);
    tokenStart = undefined;
  }

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
          flushToken(i);
        } else {
          tokenStart ??= i;
        }
      },
    },
  );

  // Flush final token (no trailing whitespace).
  flushToken(value.length);

  return specifiers;
}

function goWorkspaceBlockEnd(line: string): number {
  let closeIndex = -1;
  scanStringAware(line, GO_SCAN_OPTIONS, {
    onUnquoted(char, i) {
      if (char === ")") {
        closeIndex = i;
        return false;
      }
    },
  });
  return closeIndex;
}

function goWorkspaceUseSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  let blockSpecifiers: string[] | undefined;

  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = stripGoLineComment(rawLine).trim();
    if (trimmed.length === 0) {
      continue;
    }

    let body = trimmed;
    if (blockSpecifiers === undefined) {
      const useMatch = /^use(?:\s+(.+)|\s*)$/.exec(trimmed);
      if (!useMatch) {
        continue;
      }

      body = useMatch[1]?.trim() ?? "";
      if (!body.startsWith("(")) {
        specifiers.push(...splitGoWorkspaceSpecifiers(body));
        continue;
      }
      body = body.slice(1);
      blockSpecifiers = [];
    }

    const closeIndex = goWorkspaceBlockEnd(body);
    blockSpecifiers.push(...splitGoWorkspaceSpecifiers(
      closeIndex < 0 ? body : body.slice(0, closeIndex),
    ));
    if (closeIndex >= 0) {
      specifiers.push(...blockSpecifiers);
      blockSpecifiers = undefined;
    }
  }

  return specifiers;
}

function resolveGoWorkspaceModuleReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const target = resolveManifestRelativeTarget(fromPath, specifier);
  if (target === undefined) return undefined;
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
