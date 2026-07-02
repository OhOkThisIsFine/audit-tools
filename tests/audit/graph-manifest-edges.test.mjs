import { test, expect } from "vitest";

const { stripJsonComments, removeTrailingJsonCommas, parseJsoncObject } =
  await import("../../src/audit/extractors/graphManifestEdges/jsonc.ts");
const { parseYamlSafe, yamlStringArray, collectYamlStringScalars } =
  await import("../../src/audit/extractors/graphManifestEdges/yaml.ts");
const { parseTomlSafe, tomlStringArray } =
  await import("../../src/audit/extractors/graphManifestEdges/toml.ts");
const { stripGoLineComment, splitGoWorkspaceSpecifiers } =
  await import("../../src/audit/extractors/graphManifestEdges/go.ts");
const {
  extractCargoWorkspaceMemberEdges,
  extractGoWorkspaceModuleEdges,
  extractMavenModuleEdges,
  extractPyprojectTestpathLinks,
  extractYamlPathReferenceEdges,
} = await import("../../src/audit/extractors/graphManifestEdges/index.ts");

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

test("tomlStringArray coerces a scalar, an array, and rejects non-strings", () => {
  expect(tomlStringArray("tests")).toEqual(["tests"]); // bare scalar → [s]
  expect(tomlStringArray([" a ", "b", 3, null])).toEqual(["a", "b"]); // trims, drops non-strings
  expect(tomlStringArray(undefined)).toEqual([]);
});

// ── YAML utilities (vetted: yaml) ────────────────────────────────────────────

test("parseYamlSafe parses a document and degrades to undefined on malformed input", () => {
  expect(parseYamlSafe("packages:\n  - packages/a\n").packages).toEqual(["packages/a"]);
  // A tab-indented block is invalid YAML; must degrade, never throw.
  expect(parseYamlSafe("packages:\n\t- bad-tab-indent")).toBe(undefined);
});

test("yamlStringArray coerces a scalar, a sequence, and rejects non-strings", () => {
  expect(yamlStringArray("packages/*")).toEqual(["packages/*"]);
  expect(yamlStringArray([" a ", "b", 3])).toEqual(["a", "b"]);
  expect(yamlStringArray(undefined)).toEqual([]);
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
} = await import("../../src/audit/extractors/graphManifestEdges/packageJson.ts");

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
  const { extractPackageEntrypointEdges: indexFn } = await import("../../src/audit/extractors/graphManifestEdges/index.ts");
  const content = JSON.stringify({ main: "./src/index.ts" });
  const lookup = new Map([["src/index.ts", "src/index.ts"]]);
  const directResult = pkgEntrypoint("package.json", content, lookup);
  const indexResult = indexFn("package.json", content, lookup);
  expect(directResult).toEqual(indexResult);
});

// jsonc submodule exports TypeScript project reference extractor
const { extractTypescriptProjectReferenceEdges: tsRefEdges } =
  await import("../../src/audit/extractors/graphManifestEdges/typescript.ts");
const { parseJsoncObject: parseJsonc } =
  await import("../../src/audit/extractors/graphManifestEdges/jsonc.ts");

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
  await import("../../src/audit/extractors/graphManifestEdges/pnpm.ts");

test("pnpm submodule: pnpmWorkspacePatterns is exported", () => {
  expect(typeof pnpmPatterns).toBe("function");
});

// yamlPaths submodule exports extractYamlPathReferenceEdges
const { extractYamlPathReferenceEdges: yamlPathEdges } =
  await import("../../src/audit/extractors/graphManifestEdges/yamlPaths.ts");

test("yamlPaths submodule: extractYamlPathReferenceEdges is exported", () => {
  expect(typeof yamlPathEdges).toBe("function");
});

// graphManifestEdges/index.ts aggregates every submodule extractor. Import it
// here — ahead of the first test that uses it — so node:test's concurrent
// scheduling can never run a consuming test before this top-level await
// resolves (which would hit the const's temporal dead zone).
const allFromIndex = await import("../../src/audit/extractors/graphManifestEdges/index.ts");

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
  await import("../../src/audit/extractors/graphManifestEdges/cargo.ts");
const { cargoWorkspacePatterns: cargoPatterns } =
  await import("../../src/audit/extractors/graphManifestEdges/cargo.ts");
const { extractPyprojectTestpathLinks: pyprojectLinks } =
  await import("../../src/audit/extractors/graphManifestEdges/pyproject.ts");

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
  await import("../../src/audit/extractors/graphManifestEdges/go.ts");

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
  await import("../../src/audit/extractors/graphManifestEdges/maven.ts");

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
