import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { posix } from "node:path";
import type { RepoManifest } from "../types.js";
import type { FileDisposition, GraphBundle, GraphEdge, RouteEdge } from "@audit-tools/shared";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { buildDispositionMap, isAuditExcludedStatus } from "./disposition.js";
import {
  extractChromeExtensionManifestEdges,
  extractHtmlResourceEdges,
} from "./browserExtension.js";
import {
  extractCargoWorkspaceMemberEdges,
  extractGoWorkspaceModuleEdges,
  extractMavenModuleEdges,
  extractPackageEntrypointEdges,
  extractPackageScriptEdges,
  extractPyprojectTestpathLinks,
  extractTypescriptProjectReferenceEdges,
  extractWorkspacePackageEdges,
  extractYamlPathReferenceEdges,
  isCargoManifestPath,
  isGoWorkspaceManifestPath,
  isMavenPomPath,
  isPyprojectPath,
} from "./graphManifestEdges.js";
import {
  graphEdge,
  graphLookupKey,
  isPytestConftestPath,
  normalizeGraphPath,
  resolveCandidate,
  resolveReferenceLiteral,
  resolveSpecifier,
  SOURCE_EXTENSIONS,
  STRING_LITERAL_PATTERN,
} from "./graphPathUtils.js";
import { extractPythonImportEdges } from "./graphPythonImports.js";
import { isTestPath, normalizeExtractorPath } from "./pathPatterns.js";
import {
  extractConventionalRouteEvidence,
  extractFrameworkRouteEvidence,
  extractRegisteredRouteEvidence,
  fallbackRouteEdge,
  uniqueSortedRoutes,
} from "./graphRoutes.js";
import {
  extractBoundedSuiteEdges,
  extractJsonSchemaReferenceEdges,
  extractSchemaContractTestEdges,
} from "./graphSuites.js";
import { extractTestSourceEdges } from "./graphTestSources.js";

export interface BuildGraphBundleOptions {
  fileContents?: Record<string, string>;
  externalAnalyzerResults?: ExternalAnalyzerResults;
}

const MAX_GRAPH_SOURCE_BYTES = 512 * 1024;
const SOURCE_LANGUAGES = new Set([
  "typescript",
  "javascript",
  "json",
  "html",
  "yaml",
  "python",
  "go",
  "rust",
  "java",
  "csharp",
]);
const IMPORT_PATTERNS: Array<{ pattern: RegExp; kind: string }> = [
  {
    pattern: /\bimport\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
    kind: "esm",
  },
  {
    pattern: /\bexport\s+(?:type\s+)?[^"']*?\s+from\s+["']([^"']+)["']/g,
    kind: "re-export",
  },
  {
    pattern: /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    kind: "dynamic-import",
  },
  {
    pattern: /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    kind: "commonjs",
  },
];
const IMPORT_EDGE_CONFIDENCE = 0.95;
const REFERENCE_EDGE_CONFIDENCE = 0.72;
const RELATIVE_REFERENCE_EDGE_CONFIDENCE = 0.82;
const CONFTEST_LINK_CONFIDENCE = 0.85;
const ANALYZER_OWNERSHIP_EDGE_CONFIDENCE = 0.84;
const CONTAINER_EDGE_CONFIDENCE = 0.25;
const AUTH_SESSION_EDGE_CONFIDENCE = 0.55;

/** Named graph edge-kind keys (was a scatter of inline string literals). */
const EDGE_KIND = {
  heuristicContainer: "heuristic-container-edge",
  heuristicAuthSession: "heuristic-auth-session-link",
  conftestLink: "conftest-link",
  analyzerOwnershipRootLink: "analyzer-ownership-root-link",
  relativeStringReference: "relative-string-reference",
  repoPathReference: "repo-path-reference",
} as const;

function shouldReadForGraph(file: RepoManifest["files"][number]): boolean {
  const normalized = normalizeGraphPath(file.path);
  return (
    file.size_bytes <= MAX_GRAPH_SOURCE_BYTES &&
    (SOURCE_LANGUAGES.has(file.language) ||
      SOURCE_EXTENSIONS.some((extension) => normalized.endsWith(extension)) ||
      isGoWorkspaceManifestPath(normalized) ||
      isCargoManifestPath(normalized) ||
      isMavenPomPath(normalized) ||
      isPyprojectPath(normalized))
  );
}

export function buildPathLookup(
  repoManifest: RepoManifest,
  dispositionMap: Map<string, FileDisposition["files"][number]["status"]>,
): Map<string, string> {
  return new Map(
    repoManifest.files
      .filter((file) => {
        const status = dispositionMap.get(file.path);
        return !(file.excluded || (status && isAuditExcludedStatus(status)));
      })
      .map((file) => [graphLookupKey(file.path), file.path]),
  );
}

function edgeSignature(edge: GraphEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.kind ?? ""}`;
}

function clampConfidence(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : fallback;
}

function uniqueSortedEdges(edges: GraphEdge[]): GraphEdge[] {
  const deduped = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    deduped.set(edgeSignature(edge), edge);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      (a.kind ?? "").localeCompare(b.kind ?? ""),
  );
}

function normalizeOwnershipRoot(root: string): string | undefined {
  const normalized = normalizeGraphPath(root.trim()).replace(/\/+$/, "");
  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    isAbsolute(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function extractAnalyzerOwnershipEdges(
  externalAnalyzerResults: ExternalAnalyzerResults | undefined,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  const roots = Array.isArray(externalAnalyzerResults?.ownership_roots)
    ? externalAnalyzerResults.ownership_roots
    : [];
  const edges: GraphEdge[] = [];

  for (const rootHint of roots) {
    if (
      !rootHint ||
      typeof rootHint.root !== "string" ||
      !Array.isArray(rootHint.paths)
    ) {
      continue;
    }
    const root = normalizeOwnershipRoot(rootHint.root);
    if (!root) {
      continue;
    }

    const normalizedRoot = root.toLowerCase();
    const confidence = clampConfidence(
      rootHint.confidence,
      ANALYZER_OWNERSHIP_EDGE_CONFIDENCE,
    );
    const ownershipKind =
      typeof rootHint.kind === "string" && rootHint.kind.trim().length > 0
        ? rootHint.kind.trim()
        : undefined;
    const providedReason =
      typeof rootHint.reason === "string" && rootHint.reason.trim().length > 0
        ? rootHint.reason.trim()
        : undefined;

    for (const rawPath of rootHint.paths) {
      if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
        continue;
      }
      const target = resolveCandidate(rawPath, pathLookup);
      if (!target) {
        continue;
      }
      const normalizedTarget = normalizeGraphPath(target).toLowerCase();
      if (
        normalizedTarget !== normalizedRoot &&
        !normalizedTarget.startsWith(`${normalizedRoot}/`)
      ) {
        continue;
      }

      edges.push(
        graphEdge({
          from: root,
          to: target,
          kind: EDGE_KIND.analyzerOwnershipRootLink,
          direction: "undirected",
          confidence,
          reason:
            providedReason ??
            (ownershipKind
              ? `${externalAnalyzerResults?.tool ?? "analyzer"} reports ${ownershipKind} ownership root '${root}' contains '${target}'.`
              : `${externalAnalyzerResults?.tool ?? "analyzer"} reports ownership root '${root}' contains '${target}'.`),
        }),
      );
    }
  }

  return edges;
}

function extractImportEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const { pattern, kind } of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const target = resolveSpecifier(fromPath, specifier, pathLookup);
      if (target) {
        edges.push(
          graphEdge({
            from: fromPath,
            to: target,
            kind,
            confidence: IMPORT_EDGE_CONFIDENCE,
            reason: `Resolved ${kind} specifier '${specifier}'.`,
          }),
        );
      }
    }
  }
  return edges;
}

function importSpecifierRanges(
  content: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const { pattern } of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const fullMatch = match[0];
      const doubleQuotedOffset = fullMatch.lastIndexOf(`"${specifier}"`);
      const singleQuotedOffset = fullMatch.lastIndexOf(`'${specifier}'`);
      const quotedOffset =
        doubleQuotedOffset >= 0 ? doubleQuotedOffset : singleQuotedOffset;
      if (quotedOffset < 0) continue;
      const start = (match.index ?? 0) + quotedOffset + 1;
      ranges.push({ start, end: start + specifier.length });
    }
  }
  return ranges;
}

function isImportSpecifierRange(
  start: number,
  end: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((range) => range.start === start && range.end === end);
}

function extractReferenceEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const importRanges = importSpecifierRanges(content);
  STRING_LITERAL_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(STRING_LITERAL_PATTERN)) {
    const literal = match[1];
    if (!literal) continue;
    const literalStart = (match.index ?? 0) + 1;
    if (
      isImportSpecifierRange(
        literalStart,
        literalStart + literal.length,
        importRanges,
      )
    ) {
      continue;
    }
    const target = resolveReferenceLiteral(fromPath, literal, pathLookup);
    if (target) {
      const relativeReference = literal.startsWith(".");
      edges.push({
        from: fromPath,
        to: target,
        kind: relativeReference
          ? EDGE_KIND.relativeStringReference
          : EDGE_KIND.repoPathReference,
        direction: "directed",
        confidence: relativeReference
          ? RELATIVE_REFERENCE_EDGE_CONFIDENCE
          : REFERENCE_EDGE_CONFIDENCE,
        reason: relativeReference
          ? `Resolved relative string literal '${literal}'.`
          : `Resolved repository path string literal '${literal}'.`,
      });
    }
  }
  return edges;
}

function extractPytestConftestLinks(
  pathLookup: Map<string, string>,
): GraphEdge[] {
  const allPaths = [...new Set(pathLookup.values())];
  const conftestPaths = allPaths.filter((p) => isPytestConftestPath(p));
  if (conftestPaths.length === 0) return [];

  const edges: GraphEdge[] = [];

  for (const conftestPath of conftestPaths) {
    const conftestDir = posix.dirname(normalizeGraphPath(conftestPath));
    if (!isTestPath(normalizeExtractorPath(conftestDir))) continue;

    const scopePrefix = `${conftestDir}/`;

    for (const targetPath of allPaths) {
      if (targetPath === conftestPath) continue;
      const normalizedTarget = normalizeGraphPath(targetPath);
      if (!normalizedTarget.startsWith(scopePrefix)) continue;
      if (!normalizedTarget.endsWith(".py")) continue;
      if (isPytestConftestPath(normalizedTarget)) continue;

      edges.push(
        graphEdge({
          from: conftestPath,
          to: targetPath,
          kind: EDGE_KIND.conftestLink,
          confidence: CONFTEST_LINK_CONFIDENCE,
          reason: `Pytest conftest '${conftestPath}' applies to all Python files in its scope directory.`,
        }),
      );
    }
  }

  return edges;
}

export async function buildGraphBundleFromFs(
  repoManifest: RepoManifest,
  root: string,
  disposition?: FileDisposition,
  options: Pick<BuildGraphBundleOptions, "externalAnalyzerResults"> = {},
): Promise<GraphBundle> {
  const rootPath = resolve(root);
  const dispositionMap = buildDispositionMap(disposition);
  const fileContents: Record<string, string> = {};
  const skippedFiles: { path: string; error: string }[] = [];

  await Promise.all(
    repoManifest.files.map(async (file) => {
      const status = dispositionMap.get(file.path);
      if (
        (status && isAuditExcludedStatus(status)) ||
        file.excluded ||
        !shouldReadForGraph(file)
      ) {
        return;
      }

      const absolutePath = resolve(rootPath, file.path);
      const relativeToRoot = relative(rootPath, absolutePath);
      if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
        return;
      }

      try {
        fileContents[file.path] = await readFile(absolutePath, "utf8");
      } catch (e) {
        // Best-effort graph extraction should not block structure planning,
        // but record the skip so a coverage gap is observable to operators.
        skippedFiles.push({ path: file.path, error: (e as NodeJS.ErrnoException).code ?? String(e) });
      }
    }),
  );

  if (skippedFiles.length > 0) {
    process.stderr.write(
      "[audit-code] graph: skipped " +
        skippedFiles.length +
        " unreadable file(s): " +
        skippedFiles.map((s) => s.path + " (" + s.error + ")").join(", ") +
        "\n",
    );
  }

  return buildGraphBundle(repoManifest, disposition, { ...options, fileContents });
}

/**
 * Heuristic "container" edge: a file two-or-more directories deep is linked to
 * its top-two-segment module root, suggesting shared module ownership.
 */
function extractHeuristicContainerEdges(filePath: string): GraphEdge[] {
  const parts = filePath.split("/");
  if (parts.length <= 2) return [];
  return [
    graphEdge({
      from: filePath,
      to: `${parts[0]}/${parts[1]}`,
      kind: EDGE_KIND.heuristicContainer,
      direction: "undirected",
      confidence: CONTAINER_EDGE_CONFIDENCE,
      reason: "Path hierarchy suggests shared module ownership.",
    }),
  ];
}

/**
 * Heuristic security edge: an auth-named (non-session) file is linked to every
 * session-named file by naming convention, flagging likely auth↔session coupling.
 */
function extractHeuristicAuthSessionEdges(
  filePath: string,
  repoManifest: RepoManifest,
  dispositionMap: Map<string, FileDisposition["files"][number]["status"]>,
): GraphEdge[] {
  const normalized = filePath.toLowerCase();
  if (!(normalized.includes("auth") && normalized.includes("session") === false)) {
    return [];
  }
  const edges: GraphEdge[] = [];
  for (const other of repoManifest.files) {
    if (other.path === filePath) continue;
    const otherStatus = dispositionMap.get(other.path);
    if (otherStatus && isAuditExcludedStatus(otherStatus)) continue;
    if (other.path.toLowerCase().includes("session")) {
      edges.push(
        graphEdge({
          from: filePath,
          to: other.path,
          kind: EDGE_KIND.heuristicAuthSession,
          confidence: AUTH_SESSION_EDGE_CONFIDENCE,
          reason:
            "Security-sensitive auth path appears coupled to a session path by naming convention.",
        }),
      );
    }
  }
  return edges;
}

/** Accumulator the per-file extractors push into during a graph build. */
interface GraphEdgeAccumulator {
  imports: GraphEdge[];
  calls: GraphEdge[];
  references: GraphEdge[];
  routes: RouteEdge[];
}

/**
 * Run every content-driven edge extractor over one file's source, appending its
 * import / call / reference / route edges into the accumulator. Mirrors the
 * original inline body exactly (including push order) so the deduped/sorted
 * result is byte-identical.
 */
function extractContentEdgesForFile(
  filePath: string,
  content: string,
  pathLookup: Map<string, string>,
  acc: GraphEdgeAccumulator,
  fileRoutes: RouteEdge[],
): void {
  acc.imports.push(...extractImportEdges(filePath, content, pathLookup));
  acc.imports.push(...extractPythonImportEdges(filePath, content, pathLookup));
  acc.references.push(...extractReferenceEdges(filePath, content, pathLookup));
  acc.references.push(
    ...extractJsonSchemaReferenceEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractPackageEntrypointEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractChromeExtensionManifestEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractHtmlResourceEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractPackageScriptEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractWorkspacePackageEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractTypescriptProjectReferenceEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractGoWorkspaceModuleEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractCargoWorkspaceMemberEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractMavenModuleEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractPyprojectTestpathLinks(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractYamlPathReferenceEdges(filePath, content, pathLookup),
  );
  acc.references.push(
    ...extractSchemaContractTestEdges(filePath, content, pathLookup),
  );
  const registeredRoutes = extractRegisteredRouteEvidence(
    filePath,
    content,
    pathLookup,
  );
  acc.calls.push(...registeredRoutes.calls);
  fileRoutes.push(...registeredRoutes.routes);
  const frameworkRoutes = extractFrameworkRouteEvidence(
    filePath,
    content,
    pathLookup,
  );
  acc.calls.push(...frameworkRoutes.calls);
  fileRoutes.push(...frameworkRoutes.routes);
}

/** Concrete (all-present) graph map produced by `buildGraphBundle`. */
interface BuiltGraphs {
  imports: GraphEdge[];
  calls: GraphEdge[];
  references: GraphEdge[];
  routes: RouteEdge[];
}

/**
 * Emit the OBS-003 graph-extraction metric. No RunLogger is in scope in this
 * leaf extractor, so it uses the established structured-stderr summary
 * (FINDING-012 pattern): node count, total edge count, and the number of
 * non-empty graph types.
 */
function logGraphExtractionMetric(graphs: BuiltGraphs): void {
  const edgeCount =
    graphs.imports.length +
    graphs.calls.length +
    graphs.references.length +
    graphs.routes.length;
  const nodes = new Set<string>();
  for (const edge of [...graphs.imports, ...graphs.calls, ...graphs.references]) {
    nodes.add(edge.from);
    nodes.add(edge.to);
  }
  for (const route of graphs.routes) {
    nodes.add(route.path);
    nodes.add(route.handler);
  }
  const graphTypeCount = [
    graphs.imports,
    graphs.calls,
    graphs.references,
    graphs.routes,
  ].filter((edges) => edges.length > 0).length;
  process.stderr.write(
    `[audit-code] graph: built bundle — ${nodes.size} nodes, ${edgeCount} edges across ${graphTypeCount} graph type(s)\n`,
  );
}

export function buildGraphBundle(
  repoManifest: RepoManifest,
  disposition?: FileDisposition,
  options: BuildGraphBundleOptions = {},
): GraphBundle {
  const acc: GraphEdgeAccumulator = {
    imports: [],
    calls: [],
    references: [],
    routes: [],
  };
  const dispositionMap = buildDispositionMap(disposition);
  const pathLookup = buildPathLookup(repoManifest, dispositionMap);

  for (const file of repoManifest.files) {
    const status = dispositionMap.get(file.path);
    if (file.excluded || (status && isAuditExcludedStatus(status))) {
      continue;
    }

    acc.imports.push(...extractHeuristicContainerEdges(file.path));
    acc.imports.push(
      ...extractHeuristicAuthSessionEdges(file.path, repoManifest, dispositionMap),
    );

    const content = options.fileContents?.[file.path];
    const fileRoutes: RouteEdge[] = [];
    if (content) {
      extractContentEdgesForFile(file.path, content, pathLookup, acc, fileRoutes);
    }
    fileRoutes.push(...extractConventionalRouteEvidence(file.path, content));
    if (fileRoutes.length === 0) {
      const fallbackRoute = fallbackRouteEdge(file.path);
      if (fallbackRoute) {
        fileRoutes.push(fallbackRoute);
      }
    }
    acc.routes.push(...fileRoutes);
    acc.references.push(...extractTestSourceEdges(file.path, pathLookup));
  }
  acc.references.push(
    ...extractAnalyzerOwnershipEdges(
      options.externalAnalyzerResults,
      pathLookup,
    ),
  );
  acc.references.push(...extractPytestConftestLinks(pathLookup));
  acc.references.push(
    ...extractBoundedSuiteEdges(
      pathLookup,
      options.fileContents ?? {},
      acc.references,
    ),
  );

  const graphs = {
    imports: uniqueSortedEdges(acc.imports),
    calls: uniqueSortedEdges(acc.calls),
    references: uniqueSortedEdges(acc.references),
    routes: uniqueSortedRoutes(acc.routes),
  };

  logGraphExtractionMetric(graphs);

  return { graphs };
}
