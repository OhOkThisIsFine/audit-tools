import { posix } from "node:path";
import type { GraphEdge } from "audit-tools/shared";
import { graphEdge, normalizeGraphPath, isPyprojectPath } from "../graphPathUtils.js";
import { parseTomlSafe, asTomlTable, tomlStringArray } from "./toml.js";

export const PYPROJECT_TESTPATHS_LINK_CONFIDENCE = 0.85;

/**
 * pytest `testpaths` from `[tool.pytest.ini_options]`. Parsed with a vetted TOML
 * parser (`smol-toml`), so the dotted-header, nested-table, and inline-table
 * spellings all resolve to `tool.pytest.ini_options.testpaths`, and both the
 * array (`testpaths = ["a", "b"]`) and the bare scalar (`testpaths = "tests"`)
 * forms are handled — instead of the line scanner that matched only a literal
 * `[tool.pytest.ini_options]` header. Malformed TOML degrades to `[]`.
 */
function pyprojectTestpaths(content: string): string[] {
  const tool = asTomlTable(parseTomlSafe(content).tool);
  const pytest = asTomlTable(tool?.pytest);
  const iniOptions = asTomlTable(pytest?.ini_options);
  return tomlStringArray(iniOptions?.testpaths);
}

export function extractPyprojectTestpathLinks(
  fromPath: string,
  content: string,
  pathLookup: Map<string, string>,
): GraphEdge[] {
  if (!isPyprojectPath(fromPath)) {
    return [];
  }

  const testpaths = pyprojectTestpaths(content);
  if (testpaths.length === 0) {
    return [];
  }

  const pyprojectDir = posix.dirname(normalizeGraphPath(fromPath));
  const edges: GraphEdge[] = [];

  for (const testpath of testpaths) {
    const resolvedTestpath =
      pyprojectDir === "." ? testpath : posix.join(pyprojectDir, testpath);
    const conftestKey = posix.join(resolvedTestpath, "conftest.py").toLowerCase();
    const conftestTarget = pathLookup.get(conftestKey);
    if (!conftestTarget || conftestTarget === fromPath) continue;

    edges.push(
      graphEdge({
        from: fromPath,
        to: conftestTarget,
        kind: "pyproject-testpaths-link",
        confidence: PYPROJECT_TESTPATHS_LINK_CONFIDENCE,
        reason: `pyproject.toml testpaths entry '${testpath}' resolves to '${conftestTarget}'.`,
      }),
    );
  }

  return edges;
}
