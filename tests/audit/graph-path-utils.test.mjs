import { test, expect } from "vitest";

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
} = await import("../../src/audit/extractors/graphPathUtils.ts");

test("normalizeGraphPath preserves case so distinct-case files never collapse", () => {
  // Real on-disk casing must survive normalization (the packetizer keys on it).
  expect(normalizeGraphPath("src/data/SessionRepo.ts")).toBe("src/data/SessionRepo.ts");
  expect(normalizeGraphPath(".\\src\\Foo.ts")).toBe("src/Foo.ts");
  // Two files differing only by case are distinct paths on a case-sensitive
  // filesystem; they must produce distinct keys, not merge into one identity.
  expect(normalizeGraphPath("src/Foo.ts")).not.toBe(normalizeGraphPath("src/foo.ts"));
});

test("manifest predicates match the filename case-insensitively", () => {
  expect(isPackageManifestPath("pkg/Package.JSON")).toBe(true);
  expect(isPackageManifestPath("pkg/package.json")).toBe(true);
  expect(isPackageManifestPath("pkg/not-package.json")).toBe(false);

  expect(isTypescriptProjectConfigPath("a/tsconfig.json")).toBe(true);
  expect(isTypescriptProjectConfigPath("a/tsconfig.build.json")).toBe(true);
  expect(isTypescriptProjectConfigPath("a/other.json")).toBe(false);

  expect(isCargoManifestPath("rust/Cargo.toml")).toBe(true);
  expect(isMavenPomPath("java/POM.XML")).toBe(true);
  expect(isPyprojectPath("py/PyProject.toml")).toBe(true);
  expect(isGoModuleManifestPath("go/go.mod")).toBe(true);
  expect(isGoWorkspaceManifestPath("go/go.work")).toBe(true);

  expect(isPnpmWorkspaceManifestPath("workspace/pnpm-workspace.yaml")).toBe(true);
  expect(isPnpmWorkspaceManifestPath("workspace/PNPM-WORKSPACE.YAML")).toBe(true);
  expect(isPnpmWorkspaceManifestPath("workspace/pnpm-workspace.yml")).toBe(false);
  expect(isPnpmWorkspaceManifestPath("workspace/package.json")).toBe(false);
});

// ── resolveCandidate ─────────────────────────────────────────────────────────

test("resolveCandidate returns the canonical path on a direct exact-match hit", () => {
  const pathLookup = new Map([["src/utils/foo.ts", "src/utils/foo.ts"]]);
  expect(resolveCandidate("src/utils/foo.ts", pathLookup)).toBe("src/utils/foo.ts");
  // lookup key is lowercased, so case-variant specifiers hit the same entry
  expect(resolveCandidate("src/utils/FOO.TS", pathLookup)).toBe("src/utils/foo.ts");
});

test("resolveCandidate resolves .js runtime extension to .ts source via alias table", () => {
  const pathLookupTs = new Map([["src/utils/bar.ts", "src/utils/bar.ts"]]);
  expect(resolveCandidate("src/utils/bar.js", pathLookupTs)).toBe("src/utils/bar.ts");

  // When only .tsx is in the map, .js → .ts misses but .js → .tsx hits
  const pathLookupTsx = new Map([["src/utils/bar.tsx", "src/utils/bar.tsx"]]);
  expect(resolveCandidate("src/utils/bar.js", pathLookupTsx)).toBe("src/utils/bar.tsx");

  // When nothing matching is in the map, returns undefined
  expect(resolveCandidate("src/utils/bar.js", new Map())).toBe(undefined);
});

test("resolveCandidate resolves .mjs runtime extension to .mts source via alias table", () => {
  const pathLookup = new Map([["src/mod.mts", "src/mod.mts"]]);
  expect(resolveCandidate("src/mod.mjs", pathLookup)).toBe("src/mod.mts");
});

test("resolveCandidate resolves .cjs runtime extension to .cts source via alias table", () => {
  const pathLookup = new Map([["src/mod.cts", "src/mod.cts"]]);
  expect(resolveCandidate("src/mod.cjs", pathLookup)).toBe("src/mod.cts");
});

test("resolveCandidate probes RESOLVABLE_EXTENSIONS when candidate has no direct hit and no runtime alias", () => {
  const pathLookupTs = new Map([["src/utils/helper.ts", "src/utils/helper.ts"]]);
  expect(resolveCandidate("src/utils/helper", pathLookupTs)).toBe("src/utils/helper.ts");

  const pathLookupJson = new Map([["src/utils/data.json", "src/utils/data.json"]]);
  expect(resolveCandidate("src/utils/data", pathLookupJson)).toBe("src/utils/data.json");
});

test("resolveCandidate probes INDEX_EXTENSIONS when candidate looks like a directory", () => {
  const pathLookupTs = new Map([["src/utils/index.ts", "src/utils/index.ts"]]);
  expect(resolveCandidate("src/utils", pathLookupTs)).toBe("src/utils/index.ts");

  const pathLookupPy = new Map([["src/pymod/__init__.py", "src/pymod/__init__.py"]]);
  expect(resolveCandidate("src/pymod", pathLookupPy)).toBe("src/pymod/__init__.py");
});

test("resolveCandidate returns undefined when no stage matches", () => {
  expect(resolveCandidate("src/does/not/exist", new Map())).toBe(undefined);
  // An unrelated key in the map must not produce a false positive
  const pathLookup = new Map([["src/y.ts", "src/y.ts"]]);
  expect(resolveCandidate("src/x.unknown", pathLookup)).toBe(undefined);
});

test("resolveCandidate normalizes backslash paths before lookup", () => {
  const pathLookup = new Map([["src/utils/foo.ts", "src/utils/foo.ts"]]);
  expect(resolveCandidate("src\\utils\\foo.ts", pathLookup)).toBe("src/utils/foo.ts");
});

// ── graphLookupKey ────────────────────────────────────────────────────────────

test("graphLookupKey lowercases and normalizes", () => {
  expect(graphLookupKey("src/Foo.TS")).toBe("src/foo.ts");
  expect(graphLookupKey("./a/B.ts")).toBe("a/b.ts");
  expect(graphLookupKey("src\\Bar.ts")).toBe("src/bar.ts");
});

// ── isPytestConftestPath ──────────────────────────────────────────────────────

test("isPytestConftestPath matches conftest.py case-insensitively", () => {
  expect(isPytestConftestPath("tests/conftest.py")).toBe(true);
  expect(isPytestConftestPath("CONFTEST.PY")).toBe(true);
  expect(isPytestConftestPath("conftest.ts")).toBe(false);
  expect(isPytestConftestPath("not-conftest.py")).toBe(false);
});

// ── isJsonSchemaPath ──────────────────────────────────────────────────────────

test("isJsonSchemaPath matches *.schema.json case-insensitively", () => {
  expect(isJsonSchemaPath("schemas/foo.schema.json")).toBe(true);
  expect(isJsonSchemaPath("schemas/FOO.SCHEMA.JSON")).toBe(true);
  expect(isJsonSchemaPath("schemas/foo.json")).toBe(false);
  expect(isJsonSchemaPath("schemas/schema.json")).toBe(false);
});

// ── resolveSpecifier ──────────────────────────────────────────────────────────

test("resolveSpecifier resolves relative specifiers and ignores bare names", () => {
  const pathLookup = new Map([["src/a/bar.ts", "src/a/bar.ts"]]);
  expect(resolveSpecifier("src/a/foo.ts", "./bar.ts", pathLookup)).toBe("src/a/bar.ts");

  const upLookup = new Map([["src/utils.ts", "src/utils.ts"]]);
  expect(resolveSpecifier("src/a/foo.ts", "../utils", upLookup)).toBe("src/utils.ts");

  // bare specifier (no leading dot) → undefined
  expect(resolveSpecifier("src/a/foo.ts", "some-package", new Map())).toBe(undefined);
});

// ── resolveReferenceLiteral ───────────────────────────────────────────────────

test("resolveReferenceLiteral handles relative, repo-rooted, and bare literals", () => {
  // relative literal (starts with '.') delegates to resolveSpecifier
  const relLookup = new Map([["src/a/bar.ts", "src/a/bar.ts"]]);
  expect(resolveReferenceLiteral("src/a/foo.ts", "./bar.ts", relLookup)).toBe("src/a/bar.ts");

  // repo-rooted literal with a slash resolves via resolveCandidate
  const rootLookup = new Map([["src/utils/helper.ts", "src/utils/helper.ts"]]);
  expect(resolveReferenceLiteral("src/a/foo.ts", "src/utils/helper.ts", rootLookup)).toBe("src/utils/helper.ts");

  // bare name with no slash → undefined
  expect(resolveReferenceLiteral("src/a/foo.ts", "README", new Map())).toBe(undefined);
});
