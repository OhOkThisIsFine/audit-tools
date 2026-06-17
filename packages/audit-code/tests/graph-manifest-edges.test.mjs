import test from "node:test";
import assert from "node:assert/strict";

const { stripJsonComments, removeTrailingJsonCommas, parseJsoncObject } =
  await import("../src/extractors/graphManifestEdges/jsonc.ts");
const { parseYamlSafe, yamlStringArray, collectYamlStringScalars } =
  await import("../src/extractors/graphManifestEdges/yaml.ts");
const { parseTomlSafe, tomlStringArray } =
  await import("../src/extractors/graphManifestEdges/toml.ts");
const { stripGoLineComment, splitGoWorkspaceSpecifiers } =
  await import("../src/extractors/graphManifestEdges/go.ts");
const {
  extractCargoWorkspaceMemberEdges,
  extractGoWorkspaceModuleEdges,
  extractMavenModuleEdges,
  extractPyprojectTestpathLinks,
  extractYamlPathReferenceEdges,
} = await import("../src/extractors/graphManifestEdges/index.ts");

// ── JSONC parser ─────────────────────────────────────────────────────────────

test("stripJsonComments strips // line comments", () => {
  const result = stripJsonComments('{ "a": 1 // comment\n}');
  assert.ok(!result.includes("// comment"));
  assert.ok(result.includes('"a": 1'));
});

test("stripJsonComments strips /* block comments */", () => {
  const result = stripJsonComments('{ /* block */ "b": 2 }');
  assert.ok(!result.includes("block"));
  assert.ok(result.includes('"b": 2'));
});

test("stripJsonComments leaves string content with embedded slashes intact", () => {
  const result = stripJsonComments('{ "url": "http://x" }');
  assert.ok(result.includes('"http://x"'));
});

test("parseJsoncObject returns undefined for unparseable input", () => {
  assert.equal(parseJsoncObject("not json at all :::"), undefined);
});

test("parseJsoncObject parses JSONC with trailing commas and comments", () => {
  const input = '{ "a": 1, // comment\n"b": 2, }';
  const result = parseJsoncObject(input);
  assert.deepEqual(result, { a: 1, b: 2 });
});

// ── TOML parser (vetted: smol-toml) ──────────────────────────────────────────

test("parseTomlSafe parses a table and degrades to {} on malformed input", () => {
  assert.deepEqual(parseTomlSafe('[workspace]\nmembers = ["a", "b"]\n').workspace, {
    members: ["a", "b"],
  });
  // Malformed TOML must never throw — the graph builder treats it as no edges.
  assert.deepEqual(parseTomlSafe("this is = = not toml ["), {});
});

test("tomlStringArray coerces a scalar, an array, and rejects non-strings", () => {
  assert.deepEqual(tomlStringArray("tests"), ["tests"]); // bare scalar → [s]
  assert.deepEqual(tomlStringArray([" a ", "b", 3, null]), ["a", "b"]); // trims, drops non-strings
  assert.deepEqual(tomlStringArray(undefined), []);
});

// ── YAML utilities (vetted: yaml) ────────────────────────────────────────────

test("parseYamlSafe parses a document and degrades to undefined on malformed input", () => {
  assert.deepEqual(parseYamlSafe("packages:\n  - packages/a\n").packages, ["packages/a"]);
  // A tab-indented block is invalid YAML; must degrade, never throw.
  assert.equal(parseYamlSafe("packages:\n\t- bad-tab-indent"), undefined);
});

test("yamlStringArray coerces a scalar, a sequence, and rejects non-strings", () => {
  assert.deepEqual(yamlStringArray("packages/*"), ["packages/*"]);
  assert.deepEqual(yamlStringArray([" a ", "b", 3]), ["a", "b"]);
  assert.deepEqual(yamlStringArray(undefined), []);
});

test("collectYamlStringScalars walks maps and sequences depth-first (values only)", () => {
  const root = parseYamlSafe("a: top\nb:\n  - one\n  - nested: deep\nc: { d: flow }\n");
  assert.deepEqual(collectYamlStringScalars(root).sort(), ["deep", "flow", "one", "top"]);
});

// ── Format modules: each extract function returns [] for non-matching fromPath ─

const emptyLookup = new Map();
const dummyContent = "";

test("extractCargoWorkspaceMemberEdges returns [] for package.json fromPath", () => {
  assert.deepEqual(
    extractCargoWorkspaceMemberEdges("package.json", dummyContent, emptyLookup),
    [],
  );
});

test("extractGoWorkspaceModuleEdges returns [] for Cargo.toml fromPath", () => {
  assert.deepEqual(
    extractGoWorkspaceModuleEdges("Cargo.toml", dummyContent, emptyLookup),
    [],
  );
});

test("extractMavenModuleEdges returns [] for go.work fromPath", () => {
  assert.deepEqual(
    extractMavenModuleEdges("go.work", dummyContent, emptyLookup),
    [],
  );
});

test("extractPyprojectTestpathLinks returns [] for pom.xml fromPath", () => {
  assert.deepEqual(
    extractPyprojectTestpathLinks("pom.xml", dummyContent, emptyLookup),
    [],
  );
});

test("extractYamlPathReferenceEdges returns [] for Cargo.toml fromPath", () => {
  assert.deepEqual(
    extractYamlPathReferenceEdges("Cargo.toml", dummyContent, emptyLookup),
    [],
  );
});

// ── MNT-0fde1a49: regression tests for scanStringAware-refactored functions ──

// stripJsonComments regressions
test("stripJsonComments (via scanStringAware) — // comment after a JSON value is removed", () => {
  const result = stripJsonComments('{ "a": 1 // line comment\n}');
  assert.ok(!result.includes("// line comment"), "comment should be removed");
  assert.ok(result.includes('"a": 1'), "value should be preserved");
});

test("stripJsonComments (via scanStringAware) — /* block comment */ is removed, preserving newlines", () => {
  const result = stripJsonComments('{ /* line1\nline2 */ "b": 2 }');
  assert.ok(!result.includes("line1"), "block comment content should be removed");
  assert.ok(result.includes('"b": 2'), "value after comment should be preserved");
  assert.ok(result.includes("\n"), "newline inside block comment should be preserved");
});

test("stripJsonComments (via scanStringAware) — // sequence inside a string literal is preserved", () => {
  const result = stripJsonComments('{ "url": "http://example.com" }');
  assert.ok(result.includes('"http://example.com"'), "URL inside string should be preserved verbatim");
});

// removeTrailingJsonCommas regressions
test("removeTrailingJsonCommas (via scanStringAware) — trailing comma before } is removed", () => {
  const result = removeTrailingJsonCommas('{ "a": 1, }');
  assert.ok(!result.includes(","), "trailing comma before } should be removed");
});

test("removeTrailingJsonCommas (via scanStringAware) — trailing comma before ] is removed", () => {
  const result = removeTrailingJsonCommas('["a", "b", ]');
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed, ["a", "b"]);
});

test("removeTrailingJsonCommas (via scanStringAware) — comma inside a string literal is preserved", () => {
  const result = removeTrailingJsonCommas('{ "key": "a,b" }');
  assert.ok(result.includes('"a,b"'), "comma inside string should not be removed");
});

// TST-b29c9d4f: jsonc edge cases — adjacent comments, deeply nested trailing comma, string with /*
test("stripJsonComments (TST-b29c9d4f) — adjacent block and line comments both stripped", () => {
  // A block comment immediately followed by a line comment — both must be removed.
  const input = '{ /* block comment */ // line comment\n"a": 1 }';
  const result = stripJsonComments(input);
  assert.ok(!result.includes("block comment"), "block comment content must be removed");
  assert.ok(!result.includes("line comment"), "line comment content must be removed");
  assert.ok(result.includes('"a": 1'), "value after both comments must be preserved");
});

test("stripJsonComments (TST-b29c9d4f) — string containing /* is not treated as a block comment", () => {
  // A string value that contains the literal characters /* and */ must be left unchanged.
  const input = '{ "pattern": "/* not a comment */" }';
  const result = stripJsonComments(input);
  assert.equal(result, input, "string containing /* must be preserved verbatim");
});

test("removeTrailingJsonCommas (TST-b29c9d4f) — trailing comma in deeply nested object is removed", () => {
  // A trailing comma inside a multiply-nested structure must still be stripped.
  const input = '{"a":{"b":{"c":1,}}}';
  const result = removeTrailingJsonCommas(input);
  const parsed = JSON.parse(result);
  assert.deepEqual(parsed, { a: { b: { c: 1 } } });
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
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, "crates/a/Cargo.toml");
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
  assert.ok(targets.includes("crates/x/Cargo.toml"), "included member resolves");
  assert.ok(!targets.includes("crates/y/Cargo.toml"), "excluded member is dropped");
});

test("pyproject: scalar `testpaths = \"tests\"` and dotted header both resolve", () => {
  const lookup = new Map([["tests/conftest.py", "tests/conftest.py"]]);
  const scalar = extractPyprojectTestpathLinks("pyproject.toml", '[tool.pytest.ini_options]\ntestpaths = "tests"\n', lookup);
  assert.equal(scalar.length, 1);
  assert.equal(scalar[0].to, "tests/conftest.py");
  // Dotted-key form (no explicit section header) resolves to the same path.
  const dotted = extractPyprojectTestpathLinks("pyproject.toml", 'tool.pytest.ini_options.testpaths = ["tests"]\n', lookup);
  assert.equal(dotted.length, 1);
  assert.equal(dotted[0].to, "tests/conftest.py");
});

test("toml extractors degrade to [] on malformed TOML (never throw)", () => {
  assert.deepEqual(extractCargoWorkspaceMemberEdges("Cargo.toml", "not [valid toml = =", new Map()), []);
  assert.deepEqual(extractPyprojectTestpathLinks("pyproject.toml", "not [valid toml = =", new Map()), []);
});

// stripGoLineComment regressions
test("stripGoLineComment (via scanStringAware) — // outside a string truncates the line", () => {
  const result = stripGoLineComment('x := 1 // comment');
  assert.ok(!result.includes("comment"), "comment should be stripped");
  assert.ok(result.includes("x := 1"), "code before comment should be preserved");
});

test("stripGoLineComment (via scanStringAware) — // inside a double-quoted Go string is preserved", () => {
  const result = stripGoLineComment('"http://example.com"');
  assert.equal(result, '"http://example.com"');
});

test("stripGoLineComment (via scanStringAware) — // inside a backtick Go string is preserved", () => {
  const result = stripGoLineComment("`http://example.com`");
  assert.equal(result, "`http://example.com`");
});

// splitGoWorkspaceSpecifiers regressions
test("splitGoWorkspaceSpecifiers (via scanStringAware) — splits whitespace-separated bare tokens correctly", () => {
  assert.deepEqual(splitGoWorkspaceSpecifiers("./a ./b ./c"), ["./a", "./b", "./c"]);
});

test("splitGoWorkspaceSpecifiers (via scanStringAware) — splits double-quoted tokens and unquotes them", () => {
  assert.deepEqual(splitGoWorkspaceSpecifiers('"./module a" "./module b"'), ["./module a", "./module b"]);
});

test("splitGoWorkspaceSpecifiers (via scanStringAware) — splits backtick-quoted tokens and unquotes them", () => {
  assert.deepEqual(splitGoWorkspaceSpecifiers("`./mod a` `./mod b`"), ["./mod a", "./mod b"]);
});

// ── MNT-8a93521a: per-submodule export and public API surface tests ────────

// packageJson submodule exports all package edge extractors
const {
  extractPackageEntrypointEdges: pkgEntrypoint,
  extractPackageScriptEdges: pkgScript,
  extractWorkspacePackageEdges: pkgWorkspace,
} = await import("../src/extractors/graphManifestEdges/packageJson.ts");

test("packageJson submodule: extractPackageEntrypointEdges is exported", () => {
  assert.equal(typeof pkgEntrypoint, "function");
});

test("packageJson submodule: extractPackageScriptEdges is exported", () => {
  assert.equal(typeof pkgScript, "function");
});

test("packageJson submodule: extractWorkspacePackageEdges is exported", () => {
  assert.equal(typeof pkgWorkspace, "function");
});

test("packageJson submodule: extractPackageEntrypointEdges returns consistent results with graphManifestEdges index", async () => {
  const { extractPackageEntrypointEdges: indexFn } = await import("../src/extractors/graphManifestEdges/index.ts");
  const content = JSON.stringify({ main: "./src/index.ts" });
  const lookup = new Map([["src/index.ts", "src/index.ts"]]);
  const directResult = pkgEntrypoint("package.json", content, lookup);
  const indexResult = indexFn("package.json", content, lookup);
  assert.deepEqual(directResult, indexResult);
});

// jsonc submodule exports TypeScript project reference extractor
const { extractTypescriptProjectReferenceEdges: tsRefEdges } =
  await import("../src/extractors/graphManifestEdges/typescript.ts");
const { parseJsoncObject: parseJsonc } =
  await import("../src/extractors/graphManifestEdges/jsonc.ts");

test("typescript submodule: extractTypescriptProjectReferenceEdges is exported", () => {
  assert.equal(typeof tsRefEdges, "function");
});

test("jsonc submodule: parseJsoncObject strips // comments and trailing commas", () => {
  const result = parseJsonc('{ "a": 1, // comment\n"b": 2, }');
  assert.deepEqual(result, { a: 1, b: 2 });
});

test("jsonc submodule: parseJsoncObject strips /* */ block comments", () => {
  const result = parseJsonc('{ /* block comment */ "x": 3 }');
  assert.deepEqual(result, { x: 3 });
});

// pnpm submodule exports pnpmWorkspacePatterns
const { pnpmWorkspacePatterns: pnpmPatterns } =
  await import("../src/extractors/graphManifestEdges/pnpm.ts");

test("pnpm submodule: pnpmWorkspacePatterns is exported", () => {
  assert.equal(typeof pnpmPatterns, "function");
});

// yamlPaths submodule exports extractYamlPathReferenceEdges
const { extractYamlPathReferenceEdges: yamlPathEdges } =
  await import("../src/extractors/graphManifestEdges/yamlPaths.ts");

test("yamlPaths submodule: extractYamlPathReferenceEdges is exported", () => {
  assert.equal(typeof yamlPathEdges, "function");
});

// graphManifestEdges/index.ts aggregates every submodule extractor. Import it
// here — ahead of the first test that uses it — so node:test's concurrent
// scheduling can never run a consuming test before this top-level await
// resolves (which would hit the const's temporal dead zone).
const allFromIndex = await import("../src/extractors/graphManifestEdges/index.ts");

test("graphManifestEdges/index.ts: extractWorkspacePackageEdges returns correct edges for pnpm-workspace.yaml", () => {
  const content = "packages:\n  - packages/*\n";
  const lookup = new Map([
    ["packages/a/package.json", "packages/a/package.json"],
    ["packages/b/package.json", "packages/b/package.json"],
  ]);
  const edges = allFromIndex.extractWorkspacePackageEdges("pnpm-workspace.yaml", content, lookup);
  assert.ok(edges.length >= 1, "expected at least one workspace-package edge");
  assert.ok(edges.every((e) => e.kind === "workspace-package-link"));
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
  assert.ok(edges.length >= 1, "inline-flow packages list must yield workspace edges");
  assert.ok(edges.every((e) => e.kind === "workspace-package-link"));
});

test("yamlPaths: a path reference nested under a map is recovered (not just top-level lines)", () => {
  const lookup = new Map([["ci/shared.yml", "ci/shared.yml"]]);
  const edges = allFromIndex.extractYamlPathReferenceEdges(
    "config.yaml",
    "jobs:\n  build:\n    uses: ci/shared.yml\n",
    lookup,
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, "ci/shared.yml");
});

test("yaml extractors degrade to [] on malformed YAML (never throw)", () => {
  const bad = "packages:\n\t- tab-indented-is-invalid";
  assert.deepEqual(allFromIndex.extractWorkspacePackageEdges("pnpm-workspace.yaml", bad, new Map()), []);
  assert.deepEqual(allFromIndex.extractYamlPathReferenceEdges("config.yaml", bad, new Map()), []);
});

// toml submodule exports Cargo and pyproject extractors
const { extractCargoWorkspaceMemberEdges: cargoEdges } =
  await import("../src/extractors/graphManifestEdges/cargo.ts");
const { cargoWorkspacePatterns: cargoPatterns } =
  await import("../src/extractors/graphManifestEdges/cargo.ts");
const { extractPyprojectTestpathLinks: pyprojectLinks } =
  await import("../src/extractors/graphManifestEdges/pyproject.ts");

test("cargo submodule: extractCargoWorkspaceMemberEdges is exported", () => {
  assert.equal(typeof cargoEdges, "function");
});

test("pyproject submodule: extractPyprojectTestpathLinks is exported", () => {
  assert.equal(typeof pyprojectLinks, "function");
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
  assert.equal(patterns.length, 2);
  assert.ok(patterns.some((p) => p.pattern === "crates/a"));
  assert.ok(patterns.some((p) => p.pattern === "crates/b"));
});

// go submodule exports Go workspace extractor
const { extractGoWorkspaceModuleEdges: goEdges } =
  await import("../src/extractors/graphManifestEdges/go.ts");

test("go submodule: extractGoWorkspaceModuleEdges is exported", () => {
  assert.equal(typeof goEdges, "function");
});

test("go submodule: goWorkspaceUseSpecifiers parses single-line use directive (via extractGoWorkspaceModuleEdges)", () => {
  const content = "use ./module-a\nuse ./module-b\n";
  const lookup = new Map([
    ["module-a/go.mod", "module-a/go.mod"],
    ["module-b/go.mod", "module-b/go.mod"],
  ]);
  const edges = goEdges("go.work", content, lookup);
  assert.ok(edges.length >= 1, "expected at least one go-workspace-module-link edge");
});

test("go submodule: extractGoWorkspaceModuleEdges handles block use directives", () => {
  const content = "use (\n  ./mod-c\n  ./mod-d\n)\n";
  const lookup = new Map([
    ["mod-c/go.mod", "mod-c/go.mod"],
    ["mod-d/go.mod", "mod-d/go.mod"],
  ]);
  const edges = goEdges("go.work", content, lookup);
  assert.ok(edges.length >= 1, "expected edges from block use directive");
});

// maven submodule exports Maven module extractor
const { extractMavenModuleEdges: mavenEdges } =
  await import("../src/extractors/graphManifestEdges/maven.ts");

test("maven submodule: extractMavenModuleEdges is exported", () => {
  assert.equal(typeof mavenEdges, "function");
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
  assert.equal(edges.length, 1);
  assert.equal(edges[0].to, "child-a/pom.xml");
});

// graphManifestEdges/index.ts public API is unchanged (allFromIndex imported above)

test("graphManifestEdges index: extractPackageEntrypointEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractPackageEntrypointEdges, "function");
});

test("graphManifestEdges index: extractPackageScriptEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractPackageScriptEdges, "function");
});

test("graphManifestEdges index: extractWorkspacePackageEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractWorkspacePackageEdges, "function");
});

test("graphManifestEdges index: extractCargoWorkspaceMemberEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractCargoWorkspaceMemberEdges, "function");
});

test("graphManifestEdges index: extractTypescriptProjectReferenceEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractTypescriptProjectReferenceEdges, "function");
});

test("graphManifestEdges index: extractGoWorkspaceModuleEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractGoWorkspaceModuleEdges, "function");
});

test("graphManifestEdges index: extractMavenModuleEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractMavenModuleEdges, "function");
});

test("graphManifestEdges index: extractPyprojectTestpathLinks is re-exported", () => {
  assert.equal(typeof allFromIndex.extractPyprojectTestpathLinks, "function");
});

test("graphManifestEdges index: extractYamlPathReferenceEdges is re-exported", () => {
  assert.equal(typeof allFromIndex.extractYamlPathReferenceEdges, "function");
});

test("graphManifestEdges index: isCargoManifestPath is re-exported", () => {
  assert.equal(typeof allFromIndex.isCargoManifestPath, "function");
});

test("graphManifestEdges index: isGoWorkspaceManifestPath is re-exported", () => {
  assert.equal(typeof allFromIndex.isGoWorkspaceManifestPath, "function");
});

test("graphManifestEdges index: isMavenPomPath is re-exported", () => {
  assert.equal(typeof allFromIndex.isMavenPomPath, "function");
});

test("graphManifestEdges index: isPyprojectPath is re-exported", () => {
  assert.equal(typeof allFromIndex.isPyprojectPath, "function");
});
