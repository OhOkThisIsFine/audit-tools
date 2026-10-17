import { expect, test } from "vitest";
import { extractPythonImportEdges } from "../../src/audit/extractors/graphPythonImports.js";

test("one Python extraction scans the fallback path snapshot once", () => {
  let scans = 0;
  let visits = 0;
  class CountingMap extends Map<string, string> {
    override *values(): MapIterator<string> {
      scans += 1;
      for (const value of super.values()) {
        visits += 1;
        yield value;
      }
      return undefined;
    }
  }
  const paths = Array.from({ length: 20 }, (_, index) => `project/pkg/m${index}.py`);
  const lookup = new CountingMap(paths.map((path) => [path, path]));
  const content = paths.map((_, index) => `import pkg.m${index}`).join("\n");
  const edges = extractPythonImportEdges("project/main.py", content, lookup);
  expect(edges).toHaveLength(paths.length);
  expect(edges.map((edge) => edge.to)).toEqual(paths);
  expect(scans).toBe(1);
  expect(visits).toBe(paths.length);
});
