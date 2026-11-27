import { test, expect } from "vitest";
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
} from "../../src/audit/extractors/graphManifestEdges/index.js";
import { resolvePackageEntrypoint } from "../../src/audit/extractors/graphManifestEdges/packageJson.js";
import { cargoWorkspacePatterns } from "../../src/audit/extractors/graphManifestEdges/cargo.js";
import { stripGoLineComment, splitGoWorkspaceSpecifiers } from "../../src/audit/extractors/graphManifestEdges/go.js";
import { stripJsonComments, removeTrailingJsonCommas, parseJsoncObject } from "../../src/audit/extractors/graphManifestEdges/jsonc.js";
import { manifestStringArray, workspaceMemberEdges } from "../../src/audit/extractors/graphManifestEdges/workspace.js";
import { parseYamlSafe, collectYamlStringScalars } from "../../src/audit/extractors/graphManifestEdges/yaml.js";
import { parseTomlSafe } from "../../src/shared/parsing/toml.js";

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

// ── YAML utilities (vetted: yaml) ────────────────────────────────────────────

test("parseYamlSafe parses a document and degrades to undefined on malformed input", () => {
  expect(parseYamlSafe("packages:\n  - packages/a\n")).toEqual({ packages: ["packages/a"] });
  // A tab-indented block is invalid YAML; must degrade, never throw.
  expect(parseYamlSafe("packages:\n\t- bad-tab-indent")).toBe(undefined);
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
test("toml extractors degrade to [] on malformed TOML (never throw)", () => {
  expect(extractCargoWorkspaceMemberEdges("Cargo.toml", "not [valid toml = =", new Map())).toEqual([]);
  expect(extractPyprojectTestpathLinks("pyproject.toml", "not [valid toml = =", new Map())).toEqual([]);
});

test("workspace selection enumerates manifests once and preserves each matching positive in input order", () => {
  const source = "project/Cargo.toml";
  const paths = [source, "project/crates/B/Cargo.toml", "project/crates/A/Cargo.toml", "project/crates/skip/Cargo.toml", "project/crates/A/notes.md"];
  const examined: string[] = [];
  const edges = workspaceMemberEdges({
    fromPath: source,
    rawPatterns: [
      { pattern: "crates/*", negated: false }, { pattern: "crates/a/Cargo.toml", negated: false },
      { pattern: "crates/skip/Cargo.toml", negated: true },
    ],
    pathLookup: new Map(paths.map(path => [path.toLowerCase(), path])),
    manifestName: "Cargo.toml",
    isMemberManifest: path => { examined.push(path); return path.endsWith("/Cargo.toml"); },
    kind: "member",
    confidence: 0.87,
    reason: (pattern, target) => `${pattern} selects ${target}`,
  });

  expect(edges).toEqual([
    ["project/crates/*", paths[1]!], ["project/crates/*", paths[2]!], ["project/crates/a/Cargo.toml", paths[2]!],
  ].map(([pattern, to]) => ({ from: source, to, kind: "member", direction: "directed", confidence: 0.87, reason: `${pattern} selects ${to}` })));
  expect(examined).toEqual(paths.slice(1));
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

test("graphManifestEdges/index.ts: extractWorkspacePackageEdges returns correct edges for pnpm-workspace.yaml", () => {
  const content = "packages:\n  - packages/*\n";
  const lookup = new Map([
    ["packages/a/package.json", "packages/a/package.json"],
    ["packages/b/package.json", "packages/b/package.json"],
  ]);
  const edges = extractWorkspacePackageEdges("pnpm-workspace.yaml", content, lookup);
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
  const edges = extractWorkspacePackageEdges(
    "pnpm-workspace.yaml",
    "packages: [packages/a, packages/b]\n",
    lookup,
  );
  expect(edges.length >= 1, "inline-flow packages list must yield workspace edges").toBeTruthy();
  expect(edges.every((e) => e.kind === "workspace-package-link")).toBeTruthy();
});

test("yamlPaths: a path reference nested under a map is recovered (not just top-level lines)", () => {
  const lookup = new Map([["ci/shared.yml", "ci/shared.yml"]]);
  const edges = extractYamlPathReferenceEdges(
    "config.yaml",
    "jobs:\n  build:\n    uses: ci/shared.yml\n",
    lookup,
  );
  expect(edges.length).toBe(1);
  expect(edges[0].to).toBe("ci/shared.yml");
});

test("yaml extractors degrade to [] on malformed YAML (never throw)", () => {
  const bad = "packages:\n\t- tab-indented-is-invalid";
  expect(extractWorkspacePackageEdges("pnpm-workspace.yaml", bad, new Map())).toEqual([]);
  expect(extractYamlPathReferenceEdges("config.yaml", bad, new Map())).toEqual([]);
});

test("cargo submodule: cargoWorkspacePatterns correctly parses multi-line TOML arrays", () => {
  const content = [
    "[workspace]",
    "members = [",
    '  "crates/a",',
    '  "crates/b",',
    "]",
  ].join("\n");
  const patterns = cargoWorkspacePatterns(content);
  expect(patterns.length).toBe(2);
  expect(patterns.some((p) => p.pattern === "crates/a")).toBeTruthy();
  expect(patterns.some((p) => p.pattern === "crates/b")).toBeTruthy();
});

test.each([
  { form: "single-line", content: "use ./module-a\nuse ./module-b\n", modules: ["module-a", "module-b"] },
  { form: "block", content: "use (\n  ./mod-c\n  ./mod-d\n)\n", modules: ["mod-c", "mod-d"] },
])("go submodule: resolves $form use directives", ({ content, modules }) => {
  const paths = modules.map((name) => name + "/go.mod");
  const lookup = new Map(paths.map((path) => [path, path]));
  expect(extractGoWorkspaceModuleEdges("go.work", content, lookup).map((edge) => edge.to)).toEqual(paths);
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
  const edges = extractMavenModuleEdges("pom.xml", content, lookup);
  expect(edges.length).toBe(1);
  expect(edges[0].to).toBe("child-a/pom.xml");
});
