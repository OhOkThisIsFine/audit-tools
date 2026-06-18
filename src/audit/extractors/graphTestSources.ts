import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import {
  graphEdge,
  normalizeGraphPath,
  resolveCandidate,
  SOURCE_EXTENSIONS,
} from "./graphPathUtils.js";
import { isTestPath, normalizeExtractorPath } from "./pathPatterns.js";
import { isPythonSourcePath } from "./graphPythonImports.js";

const TEST_SOURCE_EDGE_CONFIDENCE = 0.88;
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

export function extractTestSourceEdges(
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
