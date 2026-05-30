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
  normalizeGraphPath,
  resolveCandidate,
} from "./graphPathUtils.js";
import {
  extractPythonImportEdges,
  isPythonSourcePath,
} from "./graphPythonImports.js";
import { isTestPath, normalizeExtractorPath } from "./pathPatterns.js";

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
const SOURCE_EXTENSIONS = [
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
const TYPESCRIPT_TYPE_CONTRACT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
] as const;
const PACKAGE_SCRIPT_SUITE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
] as const;
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
const STRING_LITERAL_PATTERN = /["'`]([^"'`\r\n]{1,260})["'`]/g;
const IMPORT_EDGE_CONFIDENCE = 0.95;
const REFERENCE_EDGE_CONFIDENCE = 0.72;
const RELATIVE_REFERENCE_EDGE_CONFIDENCE = 0.82;
const TEST_SOURCE_EDGE_CONFIDENCE = 0.88;
const CONFTEST_LINK_CONFIDENCE = 0.85;
const ANALYZER_OWNERSHIP_EDGE_CONFIDENCE = 0.84;
const JSON_SCHEMA_REF_EDGE_CONFIDENCE = 0.93;
const SCHEMA_CONTRACT_TEST_EDGE_CONFIDENCE = 0.86;
const SCHEMA_SUITE_EDGE_CONFIDENCE = 0.78;
const GITHUB_WORKFLOW_SUITE_EDGE_CONFIDENCE = 0.78;
const PACKAGE_SCRIPT_SUITE_EDGE_CONFIDENCE = 0.78;
const TYPESCRIPT_TYPE_SUITE_EDGE_CONFIDENCE = 0.78;
const PYTHON_TEST_UTIL_SUITE_EDGE_CONFIDENCE = 0.72;
const PYTHON_TEST_UTIL_SEGMENT_NAMES = new Set(["utils", "helpers", "support"]);
const ROUTE_HANDLER_EDGE_CONFIDENCE = 0.92;
const CONTAINER_EDGE_CONFIDENCE = 0.25;
const AUTH_SESSION_EDGE_CONFIDENCE = 0.55;
const MAX_BOUNDED_SUITE_EDGE_FILES = 12;
const MAX_BOUNDED_TYPE_SUITE_EDGE_FILES = 16;
const MAX_TYPE_CONTRACT_SOURCE_BYTES = 64 * 1024;
const TOP_LEVEL_TEST_SEGMENTS = new Set(["test", "tests", "spec", "specs"]);
const COLOCATED_TEST_SEGMENTS = new Set([
  "__test__",
  "__tests__",
  "__spec__",
  "__specs__",
  "test",
  "tests",
  "spec",
  "specs",
]);
const ROUTE_REGISTRATION_PATTERN =
  /\b(?:app|router|server|fastify)\s*\.\s*(get|post|put|patch|delete|del|options|head|all)\s*\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/gi;
const ROUTE_OBJECT_PATTERN =
  /\b(?:app|router|server|fastify)\s*\.\s*route\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\)/gi;
const ROUTE_METHOD_EXPORT_PATTERN =
  /\bexport\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g;
const ROUTE_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "ALL",
]);
const IMPORT_BINDING_PATTERN =
  /\bimport\s+(?:type\s+)?([^;"'](?:[^;]*?))\s+from\s+["']([^"']+)["']/g;
const REQUIRE_BINDING_PATTERN =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
const REQUIRE_DESTRUCTURING_PATTERN =
  /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

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

function resolveSpecifier(
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

function resolveReferenceLiteral(
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
          kind: "analyzer-ownership-root-link",
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

function routeSignature(route: RouteEdge): string {
  return `${route.method ?? ""}\0${route.path}\0${route.handler}`;
}

function uniqueSortedRoutes(routes: RouteEdge[]): RouteEdge[] {
  const deduped = new Map<string, RouteEdge>();
  for (const route of routes) {
    deduped.set(routeSignature(route), route);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.handler.localeCompare(b.handler) ||
      (a.method ?? "").localeCompare(b.method ?? ""),
  );
}

function normalizeRoutePath(routePath: string): string {
  const trimmed = routePath.trim();
  if (trimmed === "*" || trimmed === "/*") {
    return trimmed;
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/{2,}/g, "/");
}

function normalizeHttpMethod(method: string): string {
  const upper = method.toUpperCase();
  return upper === "DEL" ? "DELETE" : upper;
}

function isIdentifier(value: string | undefined): value is string {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

interface ImportBinding {
  target: string;
  specifier: string;
}

function addImportBinding(
  bindings: Map<string, ImportBinding>,
  localName: string | undefined,
  binding: ImportBinding,
): void {
  if (isIdentifier(localName)) {
    bindings.set(localName, binding);
  }
}

function parseNamedImportLocal(rawName: string): string | undefined {
  const normalized = rawName.trim().replace(/^type\s+/i, "").trim();
  if (!normalized) {
    return undefined;
  }
  const [, aliasedName] = normalized.split(/\s+as\s+/i);
  const localName = (aliasedName ?? normalized.split(/\s*:\s*/).at(-1) ?? "")
    .trim()
    .replace(/=.*$/, "")
    .trim();
  return isIdentifier(localName) ? localName : undefined;
}

function addNamedImportBindings(
  bindings: Map<string, ImportBinding>,
  rawBindings: string,
  binding: ImportBinding,
): void {
  for (const rawName of rawBindings.split(",")) {
    addImportBinding(bindings, parseNamedImportLocal(rawName), binding);
  }
}

function extractImportBindings(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();

  IMPORT_BINDING_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(IMPORT_BINDING_PATTERN)) {
    const clause = match[1]?.trim();
    const specifier = match[2];
    if (!clause || !specifier) continue;
    const target = resolveSpecifier(fromPath, specifier, pathLookup);
    if (!target) continue;
    const binding = { target, specifier };

    const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    addImportBinding(bindings, namespaceMatch?.[1], binding);

    const namedMatch = clause.match(/\{([^}]*)\}/);
    if (namedMatch?.[1]) {
      addNamedImportBindings(bindings, namedMatch[1], binding);
    }

    const defaultCandidate = clause
      .split(/[,{]/, 1)[0]
      ?.trim()
      .replace(/^type\s+/i, "");
    addImportBinding(bindings, defaultCandidate, binding);
  }

  REQUIRE_BINDING_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(REQUIRE_BINDING_PATTERN)) {
    const localName = match[1];
    const specifier = match[2];
    if (!localName || !specifier) continue;
    const target = resolveSpecifier(fromPath, specifier, pathLookup);
    if (target) {
      addImportBinding(bindings, localName, { target, specifier });
    }
  }

  REQUIRE_DESTRUCTURING_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(REQUIRE_DESTRUCTURING_PATTERN)) {
    const rawBindings = match[1];
    const specifier = match[2];
    if (!rawBindings || !specifier) continue;
    const target = resolveSpecifier(fromPath, specifier, pathLookup);
    if (target) {
      addNamedImportBindings(bindings, rawBindings, { target, specifier });
    }
  }

  return bindings;
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
          ? "relative-string-reference"
          : "repo-path-reference",
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

function isJsonSchemaPath(path: string): boolean {
  return posix
    .basename(normalizeGraphPath(path))
    .toLowerCase()
    .endsWith(".schema.json");
}

function collectJsonSchemaRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonSchemaRefs(item, refs);
    }
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string" && item.trim().length > 0) {
      refs.add(item.trim());
      continue;
    }
    collectJsonSchemaRefs(item, refs);
  }
}

function resolveJsonSchemaRef(
  fromPath: string,
  ref: string,
  pathLookup: Map<string, string>,
): string | undefined {
  const targetSpecifier = (ref.split("#", 1)[0] ?? "").trim();
  if (targetSpecifier.length === 0) {
    return undefined;
  }

  const normalizedSpecifier = normalizeGraphPath(targetSpecifier);
  if (
    normalizedSpecifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalizedSpecifier)
  ) {
    return undefined;
  }

  const baseDir = posix.dirname(normalizeGraphPath(fromPath));
  const candidate =
    targetSpecifier.startsWith(".") || !normalizedSpecifier.includes("/")
      ? posix.join(baseDir, normalizedSpecifier)
      : normalizedSpecifier;
  return resolveCandidate(candidate, pathLookup);
}

function extractJsonSchemaReferenceEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isJsonSchemaPath(fromPath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const refs = new Set<string>();
  collectJsonSchemaRefs(parsed, refs);

  const edges: GraphEdge[] = [];
  for (const ref of refs) {
    const target = resolveJsonSchemaRef(fromPath, ref, pathLookup);
    if (!target || target === fromPath) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "json-schema-ref",
        confidence: JSON_SCHEMA_REF_EDGE_CONFIDENCE,
        reason: `JSON Schema $ref '${ref}' resolves to '${target}'.`,
      }),
    );
  }
  return edges;
}

function extractSchemaContractTestEdges(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (
    !isTestPath(normalizeExtractorPath(fromPath)) ||
    !/schema/i.test(fromPath) ||
    !/\.schema\.json/i.test(content)
  ) {
    return [];
  }

  const literalBasenames = new Set<string>();
  STRING_LITERAL_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(STRING_LITERAL_PATTERN)) {
    const literal = match[1];
    if (!literal || !literal.toLowerCase().endsWith(".schema.json")) {
      continue;
    }
    literalBasenames.add(
      posix.basename(normalizeGraphPath(literal)).toLowerCase(),
    );
  }
  if (
    literalBasenames.size === 0 ||
    literalBasenames.size > MAX_BOUNDED_SUITE_EDGE_FILES
  ) {
    return [];
  }

  const targets = [...new Set(pathLookup.values())]
    .filter((path) => {
      const normalized = normalizeGraphPath(path);
      return (
        isJsonSchemaPath(normalized) &&
        literalBasenames.has(posix.basename(normalized).toLowerCase())
      );
    })
    .sort((a, b) => a.localeCompare(b));
  if (targets.length > MAX_BOUNDED_SUITE_EDGE_FILES) {
    return [];
  }

  return targets.map((target) =>
    graphEdge({
      from: fromPath,
      to: target,
      kind: "schema-contract-test-link",
      confidence: SCHEMA_CONTRACT_TEST_EDGE_CONFIDENCE,
      reason: `Schema contract test references '${posix.basename(target)}'.`,
    }),
  );
}

function isGithubWorkflowPath(path: string): boolean {
  const normalized = normalizeGraphPath(path).toLowerCase();
  return (
    normalized.startsWith(".github/workflows/") &&
    (normalized.endsWith(".yml") || normalized.endsWith(".yaml"))
  );
}

function isTypescriptTypeContractPath(
  path: string,
  fileContents: Record<string, string>,
): boolean {
  const normalized = normalizeGraphPath(path);
  const segments = normalized.split("/").filter(Boolean);
  if (
    !segments.includes("types") ||
    isTestPath(normalizeExtractorPath(normalized)) ||
    !TYPESCRIPT_TYPE_CONTRACT_EXTENSIONS.some((extension) =>
      normalized.endsWith(extension),
    )
  ) {
    return false;
  }

  const content = fileContents[path];
  if (!content || content.length > MAX_TYPE_CONTRACT_SOURCE_BYTES) {
    return false;
  }

  return /\bexport\s+(?:declare\s+)?(?:interface|type|enum|const)\b/.test(
    content,
  );
}

function packageScriptSuiteDirectories(graphEdges: GraphEdge[]): Set<string> {
  const directories = new Set<string>();
  for (const edge of graphEdges) {
    if (edge.kind !== "package-script-link") {
      continue;
    }
    const directory = posix.dirname(normalizeGraphPath(edge.to));
    const basename = posix.basename(directory);
    if (basename === "scripts" || basename === "bin") {
      directories.add(directory);
    }
  }
  return directories;
}

function isPackageScriptSuitePath(
  path: string,
  suiteDirectories: Set<string>,
): boolean {
  const normalized = normalizeGraphPath(path);
  return (
    suiteDirectories.has(posix.dirname(normalized)) &&
    PACKAGE_SCRIPT_SUITE_EXTENSIONS.some((extension) =>
      normalized.endsWith(extension),
    )
  );
}

function isPythonTestUtilSuitePath(path: string): boolean {
  const normalized = normalizeGraphPath(path);
  if (!normalized.endsWith(".py")) return false;
  if (isPytestConftestPath(normalized)) return false;
  const dir = posix.dirname(normalized);
  if (!PYTHON_TEST_UTIL_SEGMENT_NAMES.has(posix.basename(dir).toLowerCase())) return false;
  return isTestPath(normalizeExtractorPath(dir));
}

function extractBoundedSuiteEdges(
  pathLookup: Map<string, string>,
  fileContents: Record<string, string>,
  graphEdges: GraphEdge[],
): GraphEdge[] {
  const files = [...new Set(pathLookup.values())].sort((a, b) =>
    a.localeCompare(b),
  );
  const edges: GraphEdge[] = [];
  const scriptSuiteDirectories = packageScriptSuiteDirectories(graphEdges);

  const addSuiteEdges = (params: {
    predicate: (path: string) => boolean;
    kind: string;
    confidence: number;
    label: string;
    maxFiles?: number;
  }): void => {
    const groups = new Map<string, string[]>();
    for (const file of files) {
      if (!params.predicate(file)) {
        continue;
      }
      const directory = posix.dirname(normalizeGraphPath(file));
      const group = groups.get(directory) ?? [];
      group.push(file);
      groups.set(directory, group);
    }

    for (const [directory, group] of groups) {
      const maxFiles = params.maxFiles ?? MAX_BOUNDED_SUITE_EDGE_FILES;
      if (
        group.length < 2 ||
        group.length > maxFiles
      ) {
        continue;
      }
      const suiteName = directory === "." ? "repository root" : directory;
      for (let index = 1; index < group.length; index++) {
        edges.push(
          graphEdge({
            from: group[index - 1]!,
            to: group[index]!,
            kind: params.kind,
            direction: "undirected",
            confidence: params.confidence,
            reason: `${params.label} suite '${suiteName}' groups ${group.length} related file(s).`,
          }),
        );
      }
    }
  };

  addSuiteEdges({
    predicate: isJsonSchemaPath,
    kind: "schema-suite-link",
    confidence: SCHEMA_SUITE_EDGE_CONFIDENCE,
    label: "JSON Schema",
  });
  addSuiteEdges({
    predicate: isGithubWorkflowPath,
    kind: "github-workflow-suite-link",
    confidence: GITHUB_WORKFLOW_SUITE_EDGE_CONFIDENCE,
    label: "GitHub Actions workflow",
  });
  addSuiteEdges({
    predicate: (path) =>
      isPackageScriptSuitePath(path, scriptSuiteDirectories),
    kind: "package-script-suite-link",
    confidence: PACKAGE_SCRIPT_SUITE_EDGE_CONFIDENCE,
    label: "Package script",
  });
  addSuiteEdges({
    predicate: (path) => isTypescriptTypeContractPath(path, fileContents),
    kind: "typescript-type-suite-link",
    confidence: TYPESCRIPT_TYPE_SUITE_EDGE_CONFIDENCE,
    label: "TypeScript type contract",
    maxFiles: MAX_BOUNDED_TYPE_SUITE_EDGE_FILES,
  });
  addSuiteEdges({
    predicate: isPythonTestUtilSuitePath,
    kind: "python-test-util-suite-link",
    confidence: PYTHON_TEST_UTIL_SUITE_EDGE_CONFIDENCE,
    label: "Python test utility",
  });

  return edges;
}

function importedHandlerBinding(
  handlerExpression: string,
  bindings: Map<string, ImportBinding>,
): ImportBinding | undefined {
  const rootIdentifier = handlerExpression.split(".")[0];
  return rootIdentifier ? bindings.get(rootIdentifier) : undefined;
}

function addRouteEvidence(params: {
  fromPath: string;
  routes: RouteEdge[];
  calls: GraphEdge[];
  method?: string;
  routePath: string;
  handlerExpression?: string;
  bindings: Map<string, ImportBinding>;
}): void {
  const method = params.method ? normalizeHttpMethod(params.method) : undefined;
  if (method && !ROUTE_METHODS.has(method)) {
    return;
  }

  const handlerBinding = params.handlerExpression
    ? importedHandlerBinding(params.handlerExpression, params.bindings)
    : undefined;
  const handlerPath = handlerBinding?.target ?? params.fromPath;
  const route: RouteEdge = {
    path: normalizeRoutePath(params.routePath),
    handler: handlerPath,
  };
  if (method) {
    route.method = method;
  }
  params.routes.push(route);

  if (handlerBinding && handlerPath !== params.fromPath) {
    params.calls.push(
      graphEdge({
        from: params.fromPath,
        to: handlerPath,
        kind: "route-handler-link",
        confidence: ROUTE_HANDLER_EDGE_CONFIDENCE,
        reason: `Route ${method ?? "handler"} '${route.path}' passes handler '${params.handlerExpression}' from '${handlerBinding.specifier}'.`,
      }),
    );
  }
}

function extractRegisteredRouteEvidence(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): { calls: GraphEdge[]; routes: RouteEdge[] } {
  const bindings = extractImportBindings(fromPath, content, pathLookup);
  const calls: GraphEdge[] = [];
  const routes: RouteEdge[] = [];

  ROUTE_REGISTRATION_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(ROUTE_REGISTRATION_PATTERN)) {
    const method = match[1];
    const routePath = match[2];
    const handlerExpression = match[3];
    if (!method || !routePath) continue;
    addRouteEvidence({
      fromPath,
      routes,
      calls,
      method,
      routePath,
      handlerExpression,
      bindings,
    });
  }

  ROUTE_OBJECT_PATTERN.lastIndex = 0;
  for (const match of content.matchAll(ROUTE_OBJECT_PATTERN)) {
    const body = match[1];
    if (!body) continue;
    const method = body.match(/\bmethod\s*:\s*["'`]([A-Za-z]+)["'`]/i)?.[1];
    const routePath = body.match(/\b(?:url|path)\s*:\s*["'`]([^"'`]+)["'`]/i)?.[1];
    const handlerExpression = body.match(
      /\bhandler\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)/,
    )?.[1];
    if (!routePath) continue;
    addRouteEvidence({
      fromPath,
      routes,
      calls,
      method,
      routePath,
      handlerExpression,
      bindings,
    });
  }

  return { calls, routes };
}

function stripSourceExtension(path: string): string {
  const lowerPath = path.toLowerCase();
  const extension = SOURCE_EXTENSIONS.find((item) => lowerPath.endsWith(item));
  return extension ? path.slice(0, -extension.length) : path;
}

function nextRouteSegment(segment: string): string | undefined {
  if (!segment || (segment.startsWith("(") && segment.endsWith(")"))) {
    return undefined;
  }
  const catchAll = segment.match(/^\[\.\.\.(.+)\]$/);
  if (catchAll?.[1]) {
    return `:${catchAll[1]}*`;
  }
  const dynamic = segment.match(/^\[(.+)\]$/);
  if (dynamic?.[1]) {
    return `:${dynamic[1]}`;
  }
  return segment;
}

function routePathFromSegments(segments: string[]): string | undefined {
  const routeSegments = segments
    .map(nextRouteSegment)
    .filter((segment): segment is string => segment !== undefined);
  if (routeSegments.length === 0) {
    return undefined;
  }
  return normalizeRoutePath(routeSegments.join("/"));
}

function conventionalRoutePath(filePath: string): string | undefined {
  const normalized = normalizeGraphPath(filePath);
  const parts = normalized.split("/").filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const fileName = lowerParts.at(-1);
  if (!fileName) {
    return undefined;
  }

  const appIndex = lowerParts.lastIndexOf("app");
  if (appIndex >= 0 && fileName.startsWith("route.")) {
    return routePathFromSegments(parts.slice(appIndex + 1, -1));
  }

  const pagesIndex = lowerParts.lastIndexOf("pages");
  const apiIndex =
    pagesIndex >= 0
      ? lowerParts.indexOf("api", pagesIndex + 1)
      : lowerParts.indexOf("api");
  if (apiIndex >= 0 && apiIndex < parts.length - 1) {
    const withoutExtension = stripSourceExtension(parts.at(-1) ?? "");
    return routePathFromSegments([...parts.slice(apiIndex, -1), withoutExtension]);
  }

  return undefined;
}

function extractConventionalRouteEvidence(
  fromPath: string,
  content: string | undefined,
): RouteEdge[] {
  const routePath = conventionalRoutePath(fromPath);
  if (!routePath) {
    return [];
  }

  const routes: RouteEdge[] = [];
  if (content) {
    ROUTE_METHOD_EXPORT_PATTERN.lastIndex = 0;
    for (const match of content.matchAll(ROUTE_METHOD_EXPORT_PATTERN)) {
      const method = match[1];
      if (method) {
        routes.push({
          path: routePath,
          handler: fromPath,
          method,
        });
      }
    }
  }

  return routes.length > 0 ? routes : [{ path: routePath, handler: fromPath }];
}

function fallbackRouteEdge(filePath: string): RouteEdge | undefined {
  const normalized = filePath.toLowerCase();
  if (normalized.includes("api/") || normalized.includes("route")) {
    return {
      path: `/${filePath.replaceAll("/", "_")}`,
      handler: filePath,
      method: "GET",
    };
  }
  return undefined;
}

function stripKnownSourceExtension(path: string): string | undefined {
  const lowerPath = path.toLowerCase();
  const extension = SOURCE_EXTENSIONS.find((item) => lowerPath.endsWith(item));
  if (!extension) {
    return undefined;
  }
  return path.slice(0, -extension.length);
}

function stripTestSuffix(pathWithoutExtension: string): string | undefined {
  const stripped = pathWithoutExtension.replace(/[._-](?:test|spec)$/i, "");
  return stripped === pathWithoutExtension ? undefined : stripped;
}

function stripPythonTestPrefix(pathWithoutExtension: string): string | undefined {
  const basename = posix.basename(pathWithoutExtension);
  const match = /^test[._-](.+)$/i.exec(basename);
  if (!match?.[1]) {
    return undefined;
  }
  const directory = posix.dirname(pathWithoutExtension);
  return directory === "." ? match[1] : posix.join(directory, match[1]);
}

function addTestSourceCandidatesForBase(
  basePath: string,
  candidates: Set<string>,
): void {
  candidates.add(basePath);
  const parts = basePath.split("/").filter(Boolean);
  const topLevelSegment = parts[0]?.toLowerCase();
  if (topLevelSegment && TOP_LEVEL_TEST_SEGMENTS.has(topLevelSegment)) {
    const mirroredParts = parts.slice(1);
    if (mirroredParts.length > 0) {
      candidates.add(posix.join("src", ...mirroredParts));
    }
  }

  for (let index = 1; index < parts.length; index++) {
    if (COLOCATED_TEST_SEGMENTS.has(parts[index]!.toLowerCase())) {
      const colocatedParts = [
        ...parts.slice(0, index),
        ...parts.slice(index + 1),
      ];
      if (colocatedParts.length > 0) {
        candidates.add(posix.join(...colocatedParts));
      }
    }
  }
}

function testSourceCandidates(testPath: string): string[] {
  const normalizedPath = normalizeGraphPath(testPath);
  const withoutExtension = stripKnownSourceExtension(normalizedPath);
  if (!withoutExtension) {
    return [];
  }

  const baseCandidates = new Set<string>();
  const withoutTestSuffix = stripTestSuffix(withoutExtension);
  if (withoutTestSuffix) {
    baseCandidates.add(withoutTestSuffix);
  }
  if (isPythonSourcePath(normalizedPath)) {
    const withoutPythonPrefix = stripPythonTestPrefix(withoutExtension);
    if (withoutPythonPrefix) {
      baseCandidates.add(withoutPythonPrefix);
    }
  }

  const candidates = new Set<string>();
  for (const basePath of baseCandidates) {
    addTestSourceCandidatesForBase(basePath, candidates);
  }

  return [...candidates];
}

function extractTestSourceEdges(
  fromPath: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isTestPath(normalizeExtractorPath(fromPath))) {
    return [];
  }

  const edges: GraphEdge[] = [];
  for (const candidate of testSourceCandidates(fromPath)) {
    const target = resolveCandidate(candidate, pathLookup);
    if (!target || isTestPath(normalizeExtractorPath(target))) {
      continue;
    }
    edges.push(
      graphEdge({
        from: fromPath,
        to: target,
        kind: "test-source-link",
        confidence: TEST_SOURCE_EDGE_CONFIDENCE,
        reason: `Test path naming maps to source path '${target}'.`,
      }),
    );
  }
  return edges;
}

function isPytestConftestPath(path: string): boolean {
  return posix.basename(normalizeGraphPath(path)).toLowerCase() === "conftest.py";
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
          kind: "conftest-link",
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
      } catch {
        // Best-effort graph extraction should not block structure planning.
      }
    }),
  );

  return buildGraphBundle(repoManifest, disposition, { ...options, fileContents });
}

export function buildGraphBundle(
  repoManifest: RepoManifest,
  disposition?: FileDisposition,
  options: BuildGraphBundleOptions = {},
): GraphBundle {
  const imports: GraphEdge[] = [];
  const calls: GraphEdge[] = [];
  const references: GraphEdge[] = [];
  const routes: RouteEdge[] = [];
  const dispositionMap = buildDispositionMap(disposition);
  const pathLookup = buildPathLookup(repoManifest, dispositionMap);

  for (const file of repoManifest.files) {
    const status = dispositionMap.get(file.path);
    if (file.excluded || (status && isAuditExcludedStatus(status))) {
      continue;
    }

    const parts = file.path.split("/");
    if (parts.length > 2) {
      imports.push(
        graphEdge({
          from: file.path,
          to: `${parts[0]}/${parts[1]}`,
          kind: "heuristic-container-edge",
          direction: "undirected",
          confidence: CONTAINER_EDGE_CONFIDENCE,
          reason: "Path hierarchy suggests shared module ownership.",
        }),
      );
    }

    const normalized = file.path.toLowerCase();
    if (
      normalized.includes("auth") &&
      normalized.includes("session") === false
    ) {
      for (const other of repoManifest.files) {
        if (other.path === file.path) continue;
        const otherStatus = dispositionMap.get(other.path);
        if (otherStatus && isAuditExcludedStatus(otherStatus)) continue;
        if (other.path.toLowerCase().includes("session")) {
          imports.push(
            graphEdge({
              from: file.path,
              to: other.path,
              kind: "heuristic-auth-session-link",
              confidence: AUTH_SESSION_EDGE_CONFIDENCE,
              reason:
                "Security-sensitive auth path appears coupled to a session path by naming convention.",
            }),
          );
        }
      }
    }

    const content = options.fileContents?.[file.path];
    const fileRoutes: RouteEdge[] = [];
    if (content) {
      imports.push(...extractImportEdges(file.path, content, pathLookup));
      imports.push(...extractPythonImportEdges(file.path, content, pathLookup));
      references.push(...extractReferenceEdges(file.path, content, pathLookup));
      references.push(
        ...extractJsonSchemaReferenceEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractPackageEntrypointEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractChromeExtensionManifestEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractHtmlResourceEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractPackageScriptEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractWorkspacePackageEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractTypescriptProjectReferenceEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractGoWorkspaceModuleEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractCargoWorkspaceMemberEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractMavenModuleEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractPyprojectTestpathLinks(file.path, content, pathLookup),
      );
      references.push(
        ...extractYamlPathReferenceEdges(file.path, content, pathLookup),
      );
      references.push(
        ...extractSchemaContractTestEdges(file.path, content, pathLookup),
      );
      const registeredRoutes = extractRegisteredRouteEvidence(
        file.path,
        content,
        pathLookup,
      );
      calls.push(...registeredRoutes.calls);
      fileRoutes.push(...registeredRoutes.routes);
    }
    fileRoutes.push(...extractConventionalRouteEvidence(file.path, content));
    if (fileRoutes.length === 0) {
      const fallbackRoute = fallbackRouteEdge(file.path);
      if (fallbackRoute) {
        fileRoutes.push(fallbackRoute);
      }
    }
    routes.push(...fileRoutes);
    references.push(...extractTestSourceEdges(file.path, pathLookup));
  }
  references.push(
    ...extractAnalyzerOwnershipEdges(
      options.externalAnalyzerResults,
      pathLookup,
    ),
  );
  references.push(...extractPytestConftestLinks(pathLookup));
  references.push(
    ...extractBoundedSuiteEdges(
      pathLookup,
      options.fileContents ?? {},
      references,
    ),
  );

  return {
    graphs: {
      imports: uniqueSortedEdges(imports),
      calls: uniqueSortedEdges(calls),
      references: uniqueSortedEdges(references),
      routes: uniqueSortedRoutes(routes),
    },
  };
}
