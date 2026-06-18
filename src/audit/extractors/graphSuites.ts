import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import {
  graphEdge,
  isJsonSchemaPath,
  isPytestConftestPath,
  normalizeGraphPath,
  resolveCandidate,
  STRING_LITERAL_PATTERN,
} from "./graphPathUtils.js";
import { isTestPath, normalizeExtractorPath } from "./pathPatterns.js";

const JSON_SCHEMA_REF_EDGE_CONFIDENCE = 0.93;
const SCHEMA_CONTRACT_TEST_EDGE_CONFIDENCE = 0.86;
const SCHEMA_SUITE_EDGE_CONFIDENCE = 0.78;
const GITHUB_WORKFLOW_SUITE_EDGE_CONFIDENCE = 0.78;
const PACKAGE_SCRIPT_SUITE_EDGE_CONFIDENCE = 0.78;
const TYPESCRIPT_TYPE_SUITE_EDGE_CONFIDENCE = 0.78;
const PYTHON_TEST_UTIL_SUITE_EDGE_CONFIDENCE = 0.72;
const PYTHON_TEST_UTIL_SEGMENT_NAMES = new Set(["utils", "helpers", "support"]);
const MAX_BOUNDED_SUITE_EDGE_FILES = 12;
const MAX_BOUNDED_TYPE_SUITE_EDGE_FILES = 16;
const MAX_TYPE_CONTRACT_SOURCE_BYTES = 64 * 1024;
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

export function extractJsonSchemaReferenceEdges(
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
  } catch (e) {
    process.stderr.write(
      `[audit-code] graphSuites: JSON parse error in '${fromPath}', skipping schema $ref extraction: ${(e as Error).message ?? String(e)}\n`,
    );
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

export function extractSchemaContractTestEdges(
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

export function extractBoundedSuiteEdges(
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
