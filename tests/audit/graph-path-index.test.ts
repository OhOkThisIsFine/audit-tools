import { expect, test } from "vitest";
import { buildGraphPathIndex } from "../../src/audit/extractors/graphPathIndex.js";
import { resolvePythonModuleSpecifier, extractPythonImportEdges } from "../../src/audit/extractors/graphPythonImports.js";
import { extractSchemaContractTestEdges } from "../../src/audit/extractors/graphSuites.js";
import { pythonRouterIdentities } from "../../src/audit/extractors/graphRouteSources.js";
import { buildGraphBundle, type GraphEdgeCache } from "../../src/audit/extractors/graph.js";
import type { RepoManifest } from "../../src/audit/types.js";

class CountingMap extends Map<string, string> {
  scans = 0;
  visits = 0;
  override values(): MapIterator<string> {
    this.scans++;
    const iterator = super.values();
    const owner = this;
    return (function* () { for (const value of iterator) { owner.visits++; yield value; } return undefined; })();
  }
}
const lookup = (paths: string[]) => new CountingMap(paths.map((path, i) => [String(i), path]));

test("one path snapshot serves many Python, schema and router queries", () => {
  const map = lookup(["project/pkg/model.py", "project/pkg/__init__.pyi", "schemas/A.schema.json", "schemas/a.schema.json", "project/pkg/model.py"]);
  const index = buildGraphPathIndex(map);
  expect([map.scans, map.visits]).toEqual([1, 5]);
  expect(index.paths).toHaveLength(4);
  expect(Object.isFrozen(index.paths)).toBe(true);
  expect(Object.isFrozen(index.pythonModuleMatches("pkg/model"))).toBe(true);
  expect(index.pythonModuleMatches("pkg/__init__")).toEqual(["project/pkg/__init__.pyi"]);
  expect(index.pythonModuleMatches("pkg")).toEqual(["project/pkg/__init__.pyi"]);
  for (let q = 0; q < 40; q++) {
    expect(resolvePythonModuleSpecifier("project/main.py", "pkg.model", map, index)).toBe("project/pkg/model.py");
    expect(extractSchemaContractTestEdges("tests/schema.test.ts", '"a.schema.json"', map, index).map(e => e.to)).toEqual(["schemas/A.schema.json", "schemas/a.schema.json"]);
    extractPythonImportEdges("project/main.py", "from pkg import model", map, index);
    pythonRouterIdentities({}, map, index);
  }
  expect([map.scans, map.visits]).toEqual([1, 5]);
});

test.each([
  [["one/pkg/model.py"], "other/main.py", "pkg.model", "one/pkg/model.py"],
  [["one/pkg/model.py", "two/pkg/model.pyi"], "other/main.py", "pkg.model", undefined],
  [["one/pkg/model.py", "two/pkg/model.pyi"], "one/app/main.py", "pkg.model", "one/pkg/model.py"],
  [["src/pkg/model.py", "two/pkg/model.py"], "other/main.py", "pkg.model", "src/pkg/model.py"],
  [["one/pkg/MODEL.PY", "one/pkg/model.py"], "one/main.py", "pkg.model", undefined],
  [["one/pkg/__init__.py"], "other/main.py", "pkg", "one/pkg/__init__.py"],
  [["one/pkg/__init__.pyi"], "other/main.py", "pkg.__init__", "one/pkg/__init__.pyi"],
] as const)("preserves resolution for %j", (paths, from, specifier, expected) => {
  const map = lookup([...paths]);
  expect(resolvePythonModuleSpecifier(from, specifier, map, buildGraphPathIndex(map))).toBe(expected);
  expect(resolvePythonModuleSpecifier(from, specifier, map)).toBe(expected);
});

test("direct extension precedence and relative imports remain ahead of fallback", () => {
  const map = new Map(["pkg/model.ts", "pkg/model.py", "one/pkg/model.py"].map(p => [p, p]));
  const index = buildGraphPathIndex(map);
  expect(resolvePythonModuleSpecifier("x.py", "pkg.model", map, index)).toBe("pkg/model.ts");
  expect(resolvePythonModuleSpecifier("pkg/main.py", ".model", map, index)).toBe("pkg/model.ts");
});

test("same-size caller mutation is fresh on the next invocation; snapshots stay unchanged", () => {
  const map = lookup(["old/pkg/model.py", "old/a.schema.json"]);
  const prior = buildGraphPathIndex(map);
  map.set("0", "new/pkg/model.py"); map.set("1", "new/a.schema.json");
  expect(prior.pythonModuleMatches("pkg/model")).toEqual(["old/pkg/model.py"]);
  expect(prior.schemaBasenameMatches("a.schema.json")).toEqual(["old/a.schema.json"]);
  expect(resolvePythonModuleSpecifier("main.py", "pkg.model", map)).toBe("new/pkg/model.py");
  expect(extractSchemaContractTestEdges("tests/schema.test.ts", '"a.schema.json"', map)[0]?.to).toBe("new/a.schema.json");
});

test("schema buckets retain all matches before the 12-target guard", () => {
  for (const count of [12, 13]) {
    const map = lookup(Array.from({length:count}, (_, i) => `${i}/a.schema.json`));
    const edges = extractSchemaContractTestEdges("tests/schema.test.ts", '"a.schema.json"', map, buildGraphPathIndex(map));
    expect(edges).toHaveLength(count === 12 ? 12 : 0);
  }
});

test("cold and warm graph builds agree after same-size path replacement and exclusion", () => {
  const contents = {"main.py":"import pkg.model", "tests/schema.test.ts":'"a.schema.json"'};
  const make = (root: string, excluded = false): RepoManifest => ({files: ["main.py", "tests/schema.test.ts", `${root}/pkg/model.py`, `${root}/a.schema.json`].map((path, i) => ({path, size_bytes:20, language:"python", hash:String(i), excluded:i > 1 && excluded}))} as RepoManifest);
  const sink: {cache?: GraphEdgeCache} = {};
  const initial = make("old");
  const cold = buildGraphBundle(initial, undefined, {fileContents:contents, edgeCacheSink:sink});
  expect(buildGraphBundle(initial, undefined, {fileContents:contents, priorEdgeCache:sink.cache})).toEqual(cold);
  for (const manifest of [make("new"), make("old", true)]) {
    expect(buildGraphBundle(manifest, undefined, {fileContents:contents, priorEdgeCache:sink.cache})).toEqual(buildGraphBundle(manifest, undefined, {fileContents:contents}));
  }
});
