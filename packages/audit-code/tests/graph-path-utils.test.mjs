import test from "node:test";
import assert from "node:assert/strict";

const {
  normalizeGraphPath,
  isPackageManifestPath,
  isTypescriptProjectConfigPath,
  isCargoManifestPath,
  isMavenPomPath,
  isPyprojectPath,
  isGoModuleManifestPath,
  isGoWorkspaceManifestPath,
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
});
