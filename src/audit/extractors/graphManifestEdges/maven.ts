// sites-pinned: tests/audit/graph-manifest-edges.test.ts, tests/audit/graph-edge-cache.test.ts
import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { graphEdge, normalizeGraphPath, resolveManifestRelativeTarget, isMavenPomPath } from "../graphPathUtils.js";

export const MAVEN_MODULE_EDGE_CONFIDENCE = 0.87;

function stripXmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "");
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function mavenModuleSpecifiers(content: string): string[] {
  const specifiers: string[] = [];
  const withoutComments = stripXmlComments(content);
  const modulesPattern = /<modules(?:\s[^>]*)?>([\s\S]*?)<\/modules>/gi;
  let modulesMatch: RegExpExecArray | null;

  while ((modulesMatch = modulesPattern.exec(withoutComments))) {
    const body = modulesMatch[1] ?? "";
    const modulePattern = /<module(?:\s[^>]*)?>([\s\S]*?)<\/module>/gi;
    let moduleMatch: RegExpExecArray | null;
    while ((moduleMatch = modulePattern.exec(body))) {
      const specifier = decodeXmlText(moduleMatch[1] ?? "").trim();
      if (specifier.length > 0) {
        specifiers.push(specifier);
      }
    }
  }

  return specifiers;
}

function resolveMavenModuleReference(
  fromPath: string,
  specifier: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const target = resolveManifestRelativeTarget(fromPath, specifier);
  if (target === undefined) return undefined;
  const normalizedTarget = normalizeGraphPath(target);
  if (normalizedTarget === ".." || normalizedTarget.startsWith("../")) {
    return undefined;
  }

  const direct = pathLookup.get(normalizedTarget.toLowerCase());
  if (direct && isMavenPomPath(direct)) {
    return direct;
  }

  return pathLookup.get(posix.join(normalizedTarget, "pom.xml").toLowerCase());
}

export function extractMavenModuleEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isMavenPomPath(fromPath)) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const specifier of mavenModuleSpecifiers(content)) {
    const target = resolveMavenModuleReference(fromPath, specifier, pathLookup);
    if (!target || target === fromPath) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "maven-module-link",
        confidence: MAVEN_MODULE_EDGE_CONFIDENCE,
        reason: `Maven module '${specifier}' resolves to module manifest '${target}'.`,
      }),
    );
  }
  return edges;
}
