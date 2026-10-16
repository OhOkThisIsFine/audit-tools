import { test, expect } from "vitest";
import { extractPackageEntrypointEdges, extractPackageScriptEdges, resolvePackageEntrypoint } from "../../src/audit/extractors/graphManifestEdges/packageJson.js";
import { extractTypescriptProjectReferenceEdges } from "../../src/audit/extractors/graphManifestEdges/typescript.js";

const { stripJsonComments, removeTrailingJsonCommas, parseJsoncObject } =
  await import("../../src/audit/extractors/graphManifestEdges/jsonc.js");
const { parseYamlSafe: parseYamlSafeRaw, collectYamlStringScalars } =
  await import("../../src/audit/extractors/graphManifestEdges/yaml.js");
const { parseTomlSafe } =
  await import("../../src/audit/extractors/graphManifestEdges/toml.js");
const { manifestStringArray } =
  await import("../../src/audit/extractors/graphManifestEdges/workspace.js");
const { stripGoLineComment, splitGoWorkspaceSpecifiers } =
  await import("../../src/audit/extractors/graphManifestEdges/go.js");
const {
  extractCargoWorkspaceMemberEdges,
  extractGoWorkspaceModuleEdges,
  extractMavenModuleEdges,
  extractPyprojectTestpathLinks,
  extractYamlPathReferenceEdges,
} = await import("../../src/audit/extractors/graphManifestEdges/index.js");

function parseYamlSafe(content: "packages:\n  - packages/a\n"): Record<string, unknown>;
function parseYamlSafe(content: string): unknown;
function parseYamlSafe(content: string): unknown {
  return parseYamlSafeRaw(content);
}

test.each([
  ["package.json", "", "."],
  ["package.json", ".", "."],
  ["Nested/package.json", "", "Nested"],
  ["Nested/package.json", "..", "."],
  ["Nested/package.json", "../../Outside", "../Outside"],
  ["Nested/package.json", "Child/", "Nested/Child/"],
  ["Nested/package.json", " Child ", "Nested/ Child "],
  ["Nested\\package.json", ".\\Child", "Nested/Child"],
  ["package.json", "./Child", "Child"],
])("manifest target spelling remains unchanged: %s + %s", (from, specifier, target) => {
  const lookup = new Map([[target.toLowerCase(), "OriginalCase/Result.ts"]]);
  expect(resolvePackageEntrypoint(from, specifier, lookup)).toBe("OriginalCase/Result.ts");
});

test("manifest-relative adapters preserve complete edges, spelling, order and duplicate references", () => {
  const cases = [
    { file: "package.json", extract: extractPackageEntrypointEdges, kind: "package-entrypoint-link", confidence: 0.9,
      content: (s: string[]) => JSON.stringify({ exports: s }),
      reason: (s: string, _t: string, i: number) => `Package manifest field 'exports.${i}' points to '${s}'.` },
    { file: "tsconfig.json", extract: extractTypescriptProjectReferenceEdges, kind: "typescript-project-reference-link", confidence: 0.87,
      content: (s: string[]) => JSON.stringify({ references: s.map(path => ({ path })) }),
      reason: (s: string, t: string) => `TypeScript project reference '${s}' resolves to '${t}'.` },
    { file: "go.mod", extract: extractGoWorkspaceModuleEdges, kind: "go-workspace-module-link", confidence: 0.87,
      content: (s: string[]) => `use (\n${s.map(value => JSON.stringify(value)).join("\n")}\n)`,
      reason: (s: string, t: string) => `Go workspace use directive '${s}' resolves to module '${t}'.` },
    { file: "pom.xml", extract: extractMavenModuleEdges, kind: "maven-module-link", confidence: 0.87,
      content: (s: string[]) => `<modules>${s.map(value => `<module>${value}</module>`).join("")}</modules>`,
      reason: (s: string, t: string) => `Maven module '${s}' resolves to module manifest '${t}'.` },
  ];
  for (const adapter of cases) {
    for (const base of ["", "Nested/"]) {
      const from = `${base}${adapter.file === "go.mod" ? "go.work" : adapter.file}`;
      const paths = [`${base}Child/${adapter.file}`, `Sibling/${adapter.file}`];
      const specifiers = [`Child/${adapter.file}`, `./Child/${adapter.file}`, `Child\\${adapter.file}`, `${base ? "../" : ""}Sibling/${adapter.file}`, `Child/${adapter.file}`];
      const targets = [paths[0]!, paths[0]!, paths[0]!, paths[1]!, paths[0]!];
      const lookup = new Map(paths.map(path => [path.toLowerCase(), path]));
      expect(adapter.extract(from, adapter.content(specifiers), lookup)).toEqual(specifiers.map((specifier, i) => ({
        from, to: targets[i], kind: adapter.kind, confidence: adapter.confidence,
        direction: "directed", reason: adapter.reason(specifier, targets[i]!, i),
      })));
      // These lookup entries make an accidentally removed admission guard observable.
      for (const invalid of ["/absolute", "C:/drive", "C:drive", "https://host/x", "ScHeMe+v.1:x", "\\\\server\\share"]) {
        const normalized = invalid.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
        const target = `${base}${normalized}/${adapter.file}`;
        const guardLookup = new Map([[`${base}${normalized}`.toLowerCase(), target], [target.toLowerCase(), target]]);
        expect(adapter.extract(from, adapter.content([invalid]), guardLookup)).toEqual([]);
      }
      expect(adapter.extract(from, adapter.content(["missing"]), lookup)).toEqual([]);
    }
  }
});

test("manifest adapters retain distinct direct, extension and fallback probing", () => {
  const lookup = new Map([
    ["pkg/tsconfig.build.json", "Pkg/tsconfig.build.json"],
    ["pkg/tsconfig.build.json/tsconfig.json", "Pkg/fallback/tsconfig.json"],
    ["pkg/wrong", "Pkg/wrong.ts"], ["pkg/wrong/tsconfig.json", "Pkg/wrong/tsconfig.json"],
    ["pkg/go.mod", "Pkg/go.mod"], ["pkg/go.mod/go.mod", "Pkg/fallback/go.mod"],
    ["pkg/wrong/go.mod", "Pkg/wrong/go.mod"],
    ["pkg/pom.xml", "Pkg/pom.xml"], ["pkg/pom.xml/pom.xml", "Pkg/fallback/pom.xml"],
    ["pkg/wrong/pom.xml", "Pkg/wrong/pom.xml"],
    ["pkg/extension.ts", "Pkg/extension.ts"], ["pkg/index/index.ts", "Pkg/index/index.ts"],
    ["../outside/pom.xml", "../outside/pom.xml"],
  ]);
  const ts = extractTypescriptProjectReferenceEdges("Pkg/tsconfig.json", JSON.stringify({ references: [{ path: "tsconfig.build" }, { path: "wrong" }] }), lookup);
  expect(ts.map(edge => edge.to)).toEqual(["Pkg/tsconfig.build.json", "Pkg/wrong/tsconfig.json"]);
  expect(extractGoWorkspaceModuleEdges("Pkg/go.work", "use (\ngo.mod\nwrong\nextension\nindex\n)", lookup).map(edge => edge.to)).toEqual(["Pkg/go.mod", "Pkg/wrong/go.mod"]);
  expect(extractMavenModuleEdges("Pkg/parent/pom.xml", "<modules><module>../pom.xml</module><module>../wrong</module><module>../extension</module><module>../index</module><module>../../../outside</module></modules>", lookup).map(edge => edge.to)).toEqual(["Pkg/pom.xml", "Pkg/wrong/pom.xml"]);
  expect(extractMavenModuleEdges("Pkg/pom.xml", "<modules><module>.</module><module>pom.xml</module></modules>", lookup)).toEqual([]);
  expect(extractPackageEntrypointEdges("Pkg/package.json", JSON.stringify({ exports: ["extension", "index"] }), lookup).map(edge => edge.to)).toEqual(["Pkg/extension.ts", "Pkg/index/index.ts"]);
  expect(extractPackageScriptEdges("Pkg/package.json", JSON.stringify({ scripts: { check: "node ./extension.js && node ./extension.js" } }), lookup)).toEqual([0, 1].map(() => ({
    from: "Pkg/package.json", to: "Pkg/extension.ts", kind: "package-script-link", confidence: 0.88, direction: "directed",
    reason: "Package script 'check' references './extension.js'.",
  })));
});

// ── JSONC parser ─────────────────────────────────────────────────────────────

test("stripJsonComments strips // line comments", () => {
  const result = stripJsonComments('{ "a": 1 // comment\n}');
  expect(!result.includes("// comment")).toBeTruthy();
  expect(result.includes('"a": 1')).toBeTruthy();
});

test("stripJsonComments strips /* block comments */", () => {
  const result = stripJsonComments('{ /* block */ "b": 2 }');
  expect(!result.includes("block")).toBeTruthy();
  expect(result.includes('"b": 2')).toBeTruthy();
});

test("stripJsonComments leaves string content with embedded slashes intact", () => {
  const result = stripJsonComments('{ "url": "http://x" }');
  expect(result.includes('"http://x"')).toBeTruthy();
});

test("parseJsoncObject returns undefined for unparseable input", () => {
  expect(parseJsoncObject("not json at all :::")).toBe(undefined);
});

test("parseJsoncObject parses JSONC with trailing commas and comments", () => {
  const input = '{ "a": 1, // comment\n"b": 2, }';
  const result = parseJsoncObject(input);
  expect(result).toEqual({ a: 1, b: 2 });
});

// ── TOML parser (vetted: smol-toml) ──────────────────────────────────────────

test("parseTomlSafe parses a table and degrades to {} on malformed input", () => {
  expect(parseTomlSafe('[workspace]\nmembers = ["a", "b"]\n').workspace).toEqual({
    members: ["a", "b"],
  });
  // Malformed TOML must never throw — the graph builder treats it as no edges.
  expect(parseTomlSafe("this is = = not toml [")).toEqual({});
});

test("manifestStringArray coerces a scalar, an array, and rejects non-strings (TOML cases)", () => {
  expect(manifestStringArray("tests")).toEqual(["tests"]); // bare scalar → [s]
  expect(manifestStringArray([" a ", "b", 3, null])).toEqual(["a", "b"]); // trims, drops non-strings
  expect(manifestStringArray(undefined)).toEqual([]);
});

// ── YAML utilities (vetted: yaml) ────────────────────────────────────────────

test("parseYamlSafe parses a document and degrades to undefined on malformed input", () => {
  expect(parseYamlSafe("packages:\n  - packages/a\n").packages).toEqual(["packages/a"]);
  // A tab-indented block is invalid YAML; must degrade, never throw.
  expect(parseYamlSafe("packages:\n\t- bad-tab-indent")).toBe(undefined);
});

test("manifestStringArray coerces a scalar, a sequence, and rejects non-strings (YAML cases)", () => {
  expect(manifestStringArray("packages/*")).toEqual(["packages/*"]);
  expect(manifestStringArray([" a ", "b", 3])).toEqual(["a", "b"]);
  expect(manifestStringArray(undefined)).toEqual([]);
});

test("manifestStringArray parity battery pins the unified coercion semantics", () => {
  const cases: Array<[unknown, string[]]> = [
    ["tests", ["tests"]],
    [" a ", ["a"]],
    ["   ", []],
    [[" a ", "b", 3, null, undefined], ["a", "b"]],
    [undefined, []],
    [null, []],
    [42, []],
    [true, []],
    [{ members: ["a"] }, []],
  ];
  for (const [input, expected] of cases) {
    expect(manifestStringArray(input)).toEqual(expected);
  }
});

test("collectYamlStringScalars walks maps and sequences depth-first (values only)", () => {
  const root = parseYamlSafe("a: top\nb:\n  - one\n  - nested: deep\nc: { d: flow }\n");
  expect(collectYamlStringScalars(root).sort()).toEqual(["deep", "flow", "one", "top"]);
});

// ── Format modules: each extract function returns [] for non-matching fromPath ─

const emptyLookup = new Map();
const dummyContent = "";

test("extractCargoWorkspaceMemberEdges returns [] for package.json fromPath", () => {
  expect(extractCargoWorkspaceMemberEdges("package.json", dummyContent, emptyLookup)).toEqual([]);
});

test("extractGoWorkspaceModuleEdges returns [] for Cargo.toml fromPath", () => {
  expect(extractGoWorkspaceModuleEdges("Cargo.toml", dummyContent, emptyLookup)).toEqual([]);
});

test("extractMavenModuleEdges returns [] for go.work fromPath", () => {
  expect(extractMavenModuleEdges("go.work", dummyContent, emptyLookup)).toEqual([]);
});

test("extractPyprojectTestpathLinks returns [] for pom.xml fromPath", () => {
  expect(extractPyprojectTestpathLinks("pom.xml", dummyContent, emptyLookup)).toEqual([]);
});

test("extractYamlPathReferenceEdges returns [] for Cargo.toml fromPath", () => {
  expect(extractYamlPathReferenceEdges("Cargo.toml", dummyContent, emptyLookup)).toEqual([]);
});

// ── MNT-0fde1a49: regression tests for scanStringAware-refactored functions ──

// stripJsonComments regressions
test("stripJsonComments (via scanStringAware) — // comment after a JSON value is removed", () => {
  const result = stripJsonComments('{ "a": 1 // line comment\n}');
  expect(!result.includes("// line comment"), "comment should be removed").toBeTruthy();
  expect(result.includes('"a": 1'), "value should be preserved").toBeTruthy();
});

test("stripJsonComments (via scanStringAware) — /* block comment */ is removed, preserving newlines", () => {
  const result = stripJsonComments('{ /* line1\nline2 */ "b": 2 }');
  expect(!result.includes("line1"), "block comment content should be removed").toBeTruthy();
  expect(result.includes('"b": 2'), "value after comment should be preserved").toBeTruthy();
  expect(result.includes("\n"), "newline inside block comment should be preserved").toBeTruthy();
});

test("stripJsonComments (via scanStringAware) — // sequence inside a string literal is preserved", () => {
  const result = stripJsonComments('{ "url": "http://example.com" }');
  expect(result.includes('"http://example.com"'), "URL inside string should be preserved verbatim").toBeTruthy();
});

// removeTrailingJsonCommas regressions
test("removeTrailingJsonCommas (via scanStringAware) — trailing comma before } is removed", () => {
  const result = removeTrailingJsonCommas('{ "a": 1, }');
  expect(!result.includes(","), "trailing comma before } should be removed").toBeTruthy();
});

test("removeTrailingJsonCommas (via scanStringAware) — trailing comma before ] is removed", () => {
  const result = removeTrailingJsonCommas('["a", "b", ]');
  const parsed = JSON.parse(result);
  expect(parsed).toEqual(["a", "b"]);
});

test("removeTrailingJsonCommas (via scanStringAware) — comma inside a string literal is preserved", () => {
  const result = removeTrailingJsonCommas('{ "key": "a,b" }');
  expect(result.includes('"a,b"'), "comma inside string should not be removed").toBeTruthy();
});

// TST-b29c9d4f: jsonc edge cases — adjacent comments, deeply nested trailing comma, string with /*
test("stripJsonComments (TST-b29c9d4f) — adjacent block and line comments both stripped", () => {
  // A block comment immediately followed by a line comment — both must be removed.
  const input = '{ /* block comment */ // line comment\n"a": 1 }';
  const result = stripJsonComments(input);
  expect(!result.includes("block comment"), "block comment content must be removed").toBeTruthy();
  expect(!result.includes("line comment"), "line comment content must be removed").toBeTruthy();
  expect(result.includes('"a": 1'), "value after both comments must be preserved").toBeTruthy();
});

test("stripJsonComments (TST-b29c9d4f) — string containing /* is not treated as a block comment", () => {
  // A string value that contains the literal characters /* and */ must be left unchanged.
  const input = '{ "pattern": "/* not a comment */" }';
  const result = stripJsonComments(input);
  expect(result, "string containing /* must be preserved verbatim").toBe(input);
});

test("removeTrailingJsonCommas (TST-b29c9d4f) — trailing comma in deeply nested object is removed", () => {
  // A trailing comma inside a multiply-nested structure must still be stripped.
  const input = '{"a":{"b":{"c":1,}}}';
  const result = removeTrailingJsonCommas(input);
  const parsed = JSON.parse(result);
  expect(parsed).toEqual({ a: { b: { c: 1 } } });
});

// A5+A11 dropped-edge regressions: the vetted parser recovers Cargo/pyproject
// edges the old line scanner silently dropped (dotted keys, inline tables,
// quoted segments, scalar testpaths). Each asserts the structured value the
// extractor reads, then that an edge is produced.
test("cargo: dotted-key `workspace.members` is recovered (old scanner needed a [workspace] header)", () => {
  const edges = extractCargoWorkspaceMemberEdges(
    "Cargo.toml",
    'workspace.members = ["crates/a"]\n',
    new Map([["crates/a/Cargo.toml", "crates/a/Cargo.toml"]]),
  );
  expect(edges.length).toBe(1);
  expect(edges[0].to).toBe("crates/a/Cargo.toml");
});

test("cargo: inline-table `workspace = { members, exclude }` is parsed and exclude is honored", () => {
  const edges = extractCargoWorkspaceMemberEdges(
    "Cargo.toml",
    'workspace = { members = ["crates/*"], exclude = ["crates/y"] }\n',
    new Map([
      ["crates/x/Cargo.toml", "crates/x/Cargo.toml"],
      ["crates/y/Cargo.toml", "crates/y/Cargo.toml"],
    ]),
  );
  const targets = edges.map((e) => e.to);
  expect(targets.includes("crates/x/Cargo.toml"), "included member resolves").toBeTruthy();
  expect(!targets.includes("crates/y/Cargo.toml"), "excluded member is dropped").toBeTruthy();
});

test("pyproject: scalar `testpaths = \"tests\"` and dotted header both resolve", () => {
  const lookup = new Map([["tests/conftest.py", "tests/conftest.py"]]);
  const scalar = extractPyprojectTestpathLinks("pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = "tests"\n', lookup);
  expect(scalar.length).toBe(1);
  expect(scalar[0].to).toBe("tests/conftest.py");
  // Dotted-key form (no explicit section header) resolves to the same path.
  const dotted = extractPyprojectTestpathLinks("pyproject.toml", 'tool.pytest.ini_options.testpaths = ["tests"]\n', lookup);
  expect(dotted.length).toBe(1);
  expect(dotted[0].to).toBe("tests/conftest.py");
});

test("toml extractors degrade to [] on malformed TOML (never throw)", () => {
  expect(extractCargoWorkspaceMemberEdges("Cargo.toml", "not [valid toml = =", new Map())).toEqual([]);
  expect(extractPyprojectTestpathLinks("pyproject.toml", "not [valid toml = =", new Map())).toEqual([]);
});

const edgeTuples = (edges: import("audit-tools/shared").GraphEdge[]) =>
  edges.map(({ from, to, kind, direction, confidence }) => [from, to, kind, direction, confidence]).sort();

test.each([
  'workspace.members = ["crates/*"]\nworkspace.exclude = ["crates/y"]',
  'workspace = { members = ["crates/*"], exclude = ["crates/y"] }',
  '["workspace"]\n"members" = ["crates/*"]\n"exclude" = ["crates/y"]',
  '[workspace]\nmembers = [\n """crates/*""",\n]\nexclude = [\n \'\'\'crates/y\'\'\',\n]',
])("Cargo syntax parity retains exact member/exclusion tuples: %s", (content) => {
  const lookup = new Map(["crates/z/Cargo.toml", "crates/y/Cargo.toml", "crates/x/Cargo.toml", "Cargo.toml", "other/Cargo.toml"].map(path => [path.toLowerCase(), path]));
  expect(edgeTuples(extractCargoWorkspaceMemberEdges("Cargo.toml", content, lookup))).toEqual([
    ["Cargo.toml", "crates/x/Cargo.toml", "cargo-workspace-member-link", "directed", 0.87],
    ["Cargo.toml", "crates/z/Cargo.toml", "cargo-workspace-member-link", "directed", 0.87],
  ]);
});

test.each([
  '[tool.pytest.ini_options]\ntestpaths = ["tests"]',
  '[tool.pytest.ini_options]\ntestpaths = "tests"',
  'tool.pytest.ini_options.testpaths = ["tests"]',
  'tool.pytest.ini_options.testpaths = "tests"',
  'tool = { pytest = { ini_options = { testpaths = ["tests"] } } }',
  'tool = { pytest = { ini_options = { testpaths = "tests" } } }',
  '["tool"."pytest"."ini_options"]\n"testpaths" = [\n """tests""",\n]',
])("pyproject syntax parity retains exact testpath tuples: %s", (content) => {
  const lookup = new Map([["tests/conftest.py", "tests/conftest.py"], ["other/conftest.py", "other/conftest.py"]]);
  expect(edgeTuples(extractPyprojectTestpathLinks("pyproject.toml", content, lookup))).toEqual([
    ["pyproject.toml", "tests/conftest.py", "pyproject-testpaths-link", "directed", 0.85],
  ]);
});

// stripGoLineComment regressions
test("stripGoLineComment (via scanStringAware) — // outside a string truncates the line", () => {
  const result = stripGoLineComment('x := 1 // comment');
  expect(!result.includes("comment"), "comment should be stripped").toBeTruthy();
  expect(result.includes("x := 1"), "code before comment should be preserved").toBeTruthy();
});

test("stripGoLineComment (via scanStringAware) — // inside a double-quoted Go string is preserved", () => {
  const result = stripGoLineComment('"http://example.com"');
  expect(result).toBe('"http://example.com"');
});

test("stripGoLineComment (via scanStringAware) — // inside a backtick Go string is preserved", () => {
  const result = stripGoLineComment("`http://example.com`");
  expect(result).toBe("`http://example.com`");
});

// splitGoWorkspaceSpecifiers regressions
test("splitGoWorkspaceSpecifiers (via scanStringAware) — splits whitespace-separated bare tokens correctly", () => {
  expect(splitGoWorkspaceSpecifiers("./a ./b ./c")).toEqual(["./a", "./b", "./c"]);
});

test("splitGoWorkspaceSpecifiers (via scanStringAware) — splits double-quoted tokens and unquotes them", () => {
  expect(splitGoWorkspaceSpecifiers('"./module a" "./module b"')).toEqual(["./module a", "./module b"]);
});

test("splitGoWorkspaceSpecifiers (via scanStringAware) — splits backtick-quoted tokens and unquotes them", () => {
  expect(splitGoWorkspaceSpecifiers("`./mod a` `./mod b`")).toEqual(["./mod a", "./mod b"]);
});

// ── MNT-8a93521a: per-submodule export and public API surface tests ────────

// packageJson submodule exports all package edge extractors
const {
  extractPackageEntrypointEdges: pkgEntrypoint,
  extractPackageScriptEdges: pkgScript,
  extractWorkspacePackageEdges: pkgWorkspace,
} = await import("../../src/audit/extractors/graphManifestEdges/packageJson.js");

test("packageJson submodule: extractPackageEntrypointEdges is exported", () => {
  expect(typeof pkgEntrypoint).toBe("function");
});

test("packageJson submodule: extractPackageScriptEdges is exported", () => {
  expect(typeof pkgScript).toBe("function");
});

test("packageJson submodule: extractWorkspacePackageEdges is exported", () => {
  expect(typeof pkgWorkspace).toBe("function");
});

test("packageJson submodule: extractPackageEntrypointEdges returns consistent results with graphManifestEdges index", async () => {
  const { extractPackageEntrypointEdges: indexFn } = await import("../../src/audit/extractors/graphManifestEdges/index.js");
  const content = JSON.stringify({ main: "./src/index.ts" });
  const lookup = new Map([["src/index.ts", "src/index.ts"]]);
  const directResult = pkgEntrypoint("package.json", content, lookup);
  const indexResult = indexFn("package.json", content, lookup);
  expect(directResult).toEqual(indexResult);
});

// jsonc submodule exports TypeScript project reference extractor
const { extractTypescriptProjectReferenceEdges: tsRefEdges } =
  await import("../../src/audit/extractors/graphManifestEdges/typescript.js");
const { parseJsoncObject: parseJsonc } =
  await import("../../src/audit/extractors/graphManifestEdges/jsonc.js");

test("typescript submodule: extractTypescriptProjectReferenceEdges is exported", () => {
  expect(typeof tsRefEdges).toBe("function");
});

test("jsonc submodule: parseJsoncObject strips // comments and trailing commas", () => {
  const result = parseJsonc('{ "a": 1, // comment\n"b": 2, }');
  expect(result).toEqual({ a: 1, b: 2 });
});

test("jsonc submodule: parseJsoncObject strips /* */ block comments", () => {
  const result = parseJsonc('{ /* block comment */ "x": 3 }');
  expect(result).toEqual({ x: 3 });
});

// pnpm submodule exports pnpmWorkspacePatterns
const { pnpmWorkspacePatterns: pnpmPatterns } =
  await import("../../src/audit/extractors/graphManifestEdges/pnpm.js");

test("pnpm submodule: pnpmWorkspacePatterns is exported", () => {
  expect(typeof pnpmPatterns).toBe("function");
});

// yamlPaths submodule exports extractYamlPathReferenceEdges
const { extractYamlPathReferenceEdges: yamlPathEdges } =
  await import("../../src/audit/extractors/graphManifestEdges/yamlPaths.js");

test("yamlPaths submodule: extractYamlPathReferenceEdges is exported", () => {
  expect(typeof yamlPathEdges).toBe("function");
});

// graphManifestEdges/index.ts aggregates every submodule extractor. Import it
// here — ahead of the first test that uses it — so node:test's concurrent
// scheduling can never run a consuming test before this top-level await
// resolves (which would hit the const's temporal dead zone).
const allFromIndex = await import("../../src/audit/extractors/graphManifestEdges/index.js");

test("graphManifestEdges/index.ts: extractWorkspacePackageEdges returns correct edges for pnpm-workspace.yaml", () => {
  const content = "packages:\n  - packages/*\n";
  const lookup = new Map([
    ["packages/a/package.json", "packages/a/package.json"],
    ["packages/b/package.json", "packages/b/package.json"],
  ]);
  const edges = allFromIndex.extractWorkspacePackageEdges("pnpm-workspace.yaml", content, lookup);
  expect(edges.length >= 1, "expected at least one workspace-package edge").toBeTruthy();
  expect(edges.every((e) => e.kind === "workspace-package-link")).toBeTruthy();
});

// A5+A11 YAML dropped-edge regressions: the vetted parser recovers pnpm/YAML
// edges the old line scanner missed (inline-flow `packages: [...]`, and path
// references nested under maps/sequences rather than on a top-level line).
test("pnpm: inline-flow `packages: [a, b]` is recovered (old scanner only had the block form)", () => {
  const lookup = new Map([
    ["packages/a/package.json", "packages/a/package.json"],
    ["packages/b/package.json", "packages/b/package.json"],
  ]);
  const edges = allFromIndex.extractWorkspacePackageEdges(
    "pnpm-workspace.yaml",
    "packages: [packages/a, packages/b]\n",
    lookup,
  );
  expect(edges.length >= 1, "inline-flow packages list must yield workspace edges").toBeTruthy();
  expect(edges.every((e) => e.kind === "workspace-package-link")).toBeTruthy();
});

test("yamlPaths: a path reference nested under a map is recovered (not just top-level lines)", () => {
  const lookup = new Map([["ci/shared.yml", "ci/shared.yml"]]);
  const edges = allFromIndex.extractYamlPathReferenceEdges(
    "config.yaml",
    "jobs:\n  build:\n    uses: ci/shared.yml\n",
    lookup,
  );
  expect(edges.length).toBe(1);
  expect(edges[0].to).toBe("ci/shared.yml");
});

test("yaml extractors degrade to [] on malformed YAML (never throw)", () => {
  const bad = "packages:\n\t- tab-indented-is-invalid";
  expect(allFromIndex.extractWorkspacePackageEdges("pnpm-workspace.yaml", bad, new Map())).toEqual([]);
  expect(allFromIndex.extractYamlPathReferenceEdges("config.yaml", bad, new Map())).toEqual([]);
});

// toml submodule exports Cargo and pyproject extractors
const { extractCargoWorkspaceMemberEdges: cargoEdges } =
  await import("../../src/audit/extractors/graphManifestEdges/cargo.js");
const { cargoWorkspacePatterns: cargoPatterns } =
  await import("../../src/audit/extractors/graphManifestEdges/cargo.js");
const { extractPyprojectTestpathLinks: pyprojectLinks } =
  await import("../../src/audit/extractors/graphManifestEdges/pyproject.js");

test("cargo submodule: extractCargoWorkspaceMemberEdges is exported", () => {
  expect(typeof cargoEdges).toBe("function");
});

test("pyproject submodule: extractPyprojectTestpathLinks is exported", () => {
  expect(typeof pyprojectLinks).toBe("function");
});

test("cargo submodule: cargoWorkspacePatterns correctly parses multi-line TOML arrays", () => {
  const content = [
    "[workspace]",
    "members = [",
    '  "crates/a",',
    '  "crates/b",',
    "]",
  ].join("\n");
  const patterns = cargoPatterns(content);
  expect(patterns.length).toBe(2);
  expect(patterns.some((p) => p.pattern === "crates/a")).toBeTruthy();
  expect(patterns.some((p) => p.pattern === "crates/b")).toBeTruthy();
});

// go submodule exports Go workspace extractor
const { extractGoWorkspaceModuleEdges: goEdges } =
  await import("../../src/audit/extractors/graphManifestEdges/go.js");

test("go submodule: extractGoWorkspaceModuleEdges is exported", () => {
  expect(typeof goEdges).toBe("function");
});

test("go submodule: goWorkspaceUseSpecifiers parses single-line use directive (via extractGoWorkspaceModuleEdges)", () => {
  const content = "use ./module-a\nuse ./module-b\n";
  const lookup = new Map([
    ["module-a/go.mod", "module-a/go.mod"],
    ["module-b/go.mod", "module-b/go.mod"],
  ]);
  const edges = goEdges("go.work", content, lookup);
  expect(edges.length >= 1, "expected at least one go-workspace-module-link edge").toBeTruthy();
});

test("go submodule: extractGoWorkspaceModuleEdges handles block use directives", () => {
  const content = "use (\n  ./mod-c\n  ./mod-d\n)\n";
  const lookup = new Map([
    ["mod-c/go.mod", "mod-c/go.mod"],
    ["mod-d/go.mod", "mod-d/go.mod"],
  ]);
  const edges = goEdges("go.work", content, lookup);
  expect(edges.length >= 1, "expected edges from block use directive").toBeTruthy();
});

// maven submodule exports Maven module extractor
const { extractMavenModuleEdges: mavenEdges } =
  await import("../../src/audit/extractors/graphManifestEdges/maven.js");

test("maven submodule: extractMavenModuleEdges is exported", () => {
  expect(typeof mavenEdges).toBe("function");
});

test("maven submodule: extractMavenModuleEdges strips XML comments before parsing <module> elements", () => {
  const content = [
    "<project>",
    "  <modules>",
    "    <!-- ignored-module -->",
    "    <module>child-a</module>",
    "  </modules>",
    "</project>",
  ].join("\n");
  const lookup = new Map([["child-a/pom.xml", "child-a/pom.xml"]]);
  const edges = mavenEdges("pom.xml", content, lookup);
  expect(edges.length).toBe(1);
  expect(edges[0].to).toBe("child-a/pom.xml");
});

// graphManifestEdges/index.ts public API is unchanged (allFromIndex imported above)

test("graphManifestEdges index: extractPackageEntrypointEdges is re-exported", () => {
  expect(typeof allFromIndex.extractPackageEntrypointEdges).toBe("function");
});

test("graphManifestEdges index: extractPackageScriptEdges is re-exported", () => {
  expect(typeof allFromIndex.extractPackageScriptEdges).toBe("function");
});

test("graphManifestEdges index: extractWorkspacePackageEdges is re-exported", () => {
  expect(typeof allFromIndex.extractWorkspacePackageEdges).toBe("function");
});

test("graphManifestEdges index: extractCargoWorkspaceMemberEdges is re-exported", () => {
  expect(typeof allFromIndex.extractCargoWorkspaceMemberEdges).toBe("function");
});

test("graphManifestEdges index: extractTypescriptProjectReferenceEdges is re-exported", () => {
  expect(typeof allFromIndex.extractTypescriptProjectReferenceEdges).toBe("function");
});

test("graphManifestEdges index: extractGoWorkspaceModuleEdges is re-exported", () => {
  expect(typeof allFromIndex.extractGoWorkspaceModuleEdges).toBe("function");
});

test("graphManifestEdges index: extractMavenModuleEdges is re-exported", () => {
  expect(typeof allFromIndex.extractMavenModuleEdges).toBe("function");
});

test("graphManifestEdges index: extractPyprojectTestpathLinks is re-exported", () => {
  expect(typeof allFromIndex.extractPyprojectTestpathLinks).toBe("function");
});

test("graphManifestEdges index: extractYamlPathReferenceEdges is re-exported", () => {
  expect(typeof allFromIndex.extractYamlPathReferenceEdges).toBe("function");
});

test("graphManifestEdges index: isCargoManifestPath is re-exported", () => {
  expect(typeof allFromIndex.isCargoManifestPath).toBe("function");
});

test("graphManifestEdges index: isGoWorkspaceManifestPath is re-exported", () => {
  expect(typeof allFromIndex.isGoWorkspaceManifestPath).toBe("function");
});

test("graphManifestEdges index: isMavenPomPath is re-exported", () => {
  expect(typeof allFromIndex.isMavenPomPath).toBe("function");
});

test("graphManifestEdges index: isPyprojectPath is re-exported", () => {
  expect(typeof allFromIndex.isPyprojectPath).toBe("function");
});
