import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeGraphPath,
  graphLookupKey,
  resolveCandidate,
  resolveSpecifier,
  resolveReferenceLiteral,
  isPackageManifestPath,
  isTypescriptProjectConfigPath,
  isCargoManifestPath,
  isMavenPomPath,
  isPyprojectPath,
  isGoModuleManifestPath,
  isGoWorkspaceManifestPath,
  isPnpmWorkspaceManifestPath,
  isPytestConftestPath,
  isJsonSchemaPath,
} = await import("../src/extractors/graphPathUtils.ts");

test("normalizeGraphPath preserves case so distinct-case files never collapse", () => {
  // Real on-disk casing must survive normalization (the packetizer keys on it).
  assert.equal(
    normalizeGraphPath("src/data/SessionRepo.ts"),
    "src/data/SessionRepo.ts",
  );
  assert.equal(normalizeGraphPath(".\\src\\Foo.ts"), "src/Foo.ts");
  // Two files differing only by case are distinct paths on a case-sensitive
  // filesystem; they must produce distinct keys, not merge into one identity.
  assert.notEqual(
    normalizeGraphPath("src/Foo.ts"),
    normalizeGraphPath("src/foo.ts"),
  );
});

test("manifest predicates match the filename case-insensitively", () => {
  assert.equal(isPackageManifestPath("pkg/Package.JSON"), true);
  assert.equal(isPackageManifestPath("pkg/package.json"), true);
  assert.equal(isPackageManifestPath("pkg/not-package.json"), false);

  assert.equal(isTypescriptProjectConfigPath("a/tsconfig.json"), true);
  assert.equal(isTypescriptProjectConfigPath("a/tsconfig.build.json"), true);
  assert.equal(isTypescriptProjectConfigPath("a/other.json"), false);

  assert.equal(isCargoManifestPath("rust/Cargo.toml"), true);
  assert.equal(isMavenPomPath("java/POM.XML"), true);
  assert.equal(isPyprojectPath("py/PyProject.toml"), true);
  assert.equal(isGoModuleManifestPath("go/go.mod"), true);
  assert.equal(isGoWorkspaceManifestPath("go/go.work"), true);

  assert.equal(isPnpmWorkspaceManifestPath("workspace/pnpm-workspace.yaml"), true);
  assert.equal(isPnpmWorkspaceManifestPath("workspace/PNPM-WORKSPACE.YAML"), true);
  assert.equal(isPnpmWorkspaceManifestPath("workspace/pnpm-workspace.yml"), false);
  assert.equal(isPnpmWorkspaceManifestPath("workspace/package.json"), false);
});

// ── resolveCandidate ─────────────────────────────────────────────────────────

test("resolveCandidate returns the canonical path on a direct exact-match hit", () => {
  const pathLookup = new Map([["src/utils/foo.ts", "src/utils/foo.ts"]]);
  assert.equal(resolveCandidate("src/utils/foo.ts", pathLookup), "src/utils/foo.ts");
  // lookup key is lowercased, so case-variant specifiers hit the same entry
  assert.equal(resolveCandidate("src/utils/FOO.TS", pathLookup), "src/utils/foo.ts");
});

test("resolveCandidate resolves .js runtime extension to .ts source via alias table", () => {
  const pathLookupTs = new Map([["src/utils/bar.ts", "src/utils/bar.ts"]]);
  assert.equal(resolveCandidate("src/utils/bar.js", pathLookupTs), "src/utils/bar.ts");

  // When only .tsx is in the map, .js → .ts misses but .js → .tsx hits
  const pathLookupTsx = new Map([["src/utils/bar.tsx", "src/utils/bar.tsx"]]);
  assert.equal(resolveCandidate("src/utils/bar.js", pathLookupTsx), "src/utils/bar.tsx");

  // When nothing matching is in the map, returns undefined
  assert.equal(resolveCandidate("src/utils/bar.js", new Map()), undefined);
});

test("resolveCandidate resolves .mjs runtime extension to .mts source via alias table", () => {
  const pathLookup = new Map([["src/mod.mts", "src/mod.mts"]]);
  assert.equal(resolveCandidate("src/mod.mjs", pathLookup), "src/mod.mts");
});

test("resolveCandidate resolves .cjs runtime extension to .cts source via alias table", () => {
  const pathLookup = new Map([["src/mod.cts", "src/mod.cts"]]);
  assert.equal(resolveCandidate("src/mod.cjs", pathLookup), "src/mod.cts");
});

test("resolveCandidate probes RESOLVABLE_EXTENSIONS when candidate has no direct hit and no runtime alias", () => {
  const pathLookupTs = new Map([["src/utils/helper.ts", "src/utils/helper.ts"]]);
  assert.equal(resolveCandidate("src/utils/helper", pathLookupTs), "src/utils/helper.ts");

  const pathLookupJson = new Map([["src/utils/data.json", "src/utils/data.json"]]);
  assert.equal(resolveCandidate("src/utils/data", pathLookupJson), "src/utils/data.json");
});

test("resolveCandidate probes INDEX_EXTENSIONS when candidate looks like a directory", () => {
  const pathLookupTs = new Map([["src/utils/index.ts", "src/utils/index.ts"]]);
  assert.equal(resolveCandidate("src/utils", pathLookupTs), "src/utils/index.ts");

  const pathLookupPy = new Map([["src/pymod/__init__.py", "src/pymod/__init__.py"]]);
  assert.equal(resolveCandidate("src/pymod", pathLookupPy), "src/pymod/__init__.py");
});

test("resolveCandidate returns undefined when no stage matches", () => {
  assert.equal(resolveCandidate("src/does/not/exist", new Map()), undefined);
  // An unrelated key in the map must not produce a false positive
  const pathLookup = new Map([["src/y.ts", "src/y.ts"]]);
  assert.equal(resolveCandidate("src/x.unknown", pathLookup), undefined);
});

test("resolveCandidate normalizes backslash paths before lookup", () => {
  const pathLookup = new Map([["src/utils/foo.ts", "src/utils/foo.ts"]]);
  assert.equal(resolveCandidate("src\\utils\\foo.ts", pathLookup), "src/utils/foo.ts");
});

// ── graphLookupKey ────────────────────────────────────────────────────────────

test("graphLookupKey lowercases and normalizes", () => {
  assert.equal(graphLookupKey("src/Foo.TS"), "src/foo.ts");
  assert.equal(graphLookupKey("./a/B.ts"), "a/b.ts");
  assert.equal(graphLookupKey("src\\Bar.ts"), "src/bar.ts");
});

// ── isPytestConftestPath ──────────────────────────────────────────────────────

test("isPytestConftestPath matches conftest.py case-insensitively", () => {
  assert.equal(isPytestConftestPath("tests/conftest.py"), true);
  assert.equal(isPytestConftestPath("CONFTEST.PY"), true);
  assert.equal(isPytestConftestPath("conftest.ts"), false);
  assert.equal(isPytestConftestPath("not-conftest.py"), false);
});

// ── isJsonSchemaPath ──────────────────────────────────────────────────────────

test("isJsonSchemaPath matches *.schema.json case-insensitively", () => {
  assert.equal(isJsonSchemaPath("schemas/foo.schema.json"), true);
  assert.equal(isJsonSchemaPath("schemas/FOO.SCHEMA.JSON"), true);
  assert.equal(isJsonSchemaPath("schemas/foo.json"), false);
  assert.equal(isJsonSchemaPath("schemas/schema.json"), false);
});

// ── resolveSpecifier ──────────────────────────────────────────────────────────

test("resolveSpecifier resolves relative specifiers and ignores bare names", () => {
  const pathLookup = new Map([["src/a/bar.ts", "src/a/bar.ts"]]);
  assert.equal(resolveSpecifier("src/a/foo.ts", "./bar.ts", pathLookup), "src/a/bar.ts");

  const upLookup = new Map([["src/utils.ts", "src/utils.ts"]]);
  assert.equal(resolveSpecifier("src/a/foo.ts", "../utils", upLookup), "src/utils.ts");

  // bare specifier (no leading dot) → undefined
  assert.equal(resolveSpecifier("src/a/foo.ts", "some-package", new Map()), undefined);
});

// ── resolveReferenceLiteral ───────────────────────────────────────────────────

test("resolveReferenceLiteral handles relative, repo-rooted, and bare literals", () => {
  // relative literal (starts with '.') delegates to resolveSpecifier
  const relLookup = new Map([["src/a/bar.ts", "src/a/bar.ts"]]);
  assert.equal(resolveReferenceLiteral("src/a/foo.ts", "./bar.ts", relLookup), "src/a/bar.ts");

  // repo-rooted literal with a slash resolves via resolveCandidate
  const rootLookup = new Map([["src/utils/helper.ts", "src/utils/helper.ts"]]);
  assert.equal(
    resolveReferenceLiteral("src/a/foo.ts", "src/utils/helper.ts", rootLookup),
    "src/utils/helper.ts",
  );

  // bare name with no slash → undefined
  assert.equal(resolveReferenceLiteral("src/a/foo.ts", "README", new Map()), undefined);
});
