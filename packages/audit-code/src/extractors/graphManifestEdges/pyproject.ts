import { posix } from "node:path";
import type { GraphEdge } from "@audit-tools/shared";
import { graphEdge, normalizeGraphPath, isPyprojectPath } from "../graphPathUtils.js";
import { stripTomlComment, tomlArrayIsClosed, tomlStringArrayValues } from "./toml.js";

export const PYPROJECT_TESTPATHS_LINK_CONFIDENCE = 0.85;

function pyprojectTestpaths(content: string): string[] {
  const values: string[] = [];
  let currentSection = "";
  let collectingKey: string | undefined;
  let collectedValue = "";

  const flush = (): void => {
    if (!collectingKey) return;
    for (const v of tomlStringArrayValues(collectedValue)) {
      values.push(v);
    }
    collectingKey = undefined;
    collectedValue = "";
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const withoutComment = stripTomlComment(rawLine);
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    const sectionMatch = /^\[([^\]]+)\]\s*$/.exec(trimmed);
    if (sectionMatch?.[1]) {
      flush();
      currentSection = sectionMatch[1].trim();
      continue;
    }

    if (collectingKey) {
      collectedValue = `${collectedValue}\n${trimmed}`;
      if (tomlArrayIsClosed(collectedValue)) {
        flush();
      }
      continue;
    }

    if (currentSection !== "tool.pytest.ini_options") continue;

    const keyMatch = /^testpaths\s*=\s*(.+)$/.exec(trimmed);
    if (!keyMatch?.[1]) continue;

    const value = keyMatch[1].trim();
    if (!value.startsWith("[")) {
      const bare = value.replace(/^["']|["']$/g, "").trim();
      if (bare.length > 0) values.push(bare);
      continue;
    }

    collectingKey = "testpaths";
    collectedValue = value;
    if (tomlArrayIsClosed(collectedValue)) {
      flush();
    }
  }

  flush();
  return values;
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
