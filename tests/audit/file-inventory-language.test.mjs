import test from "node:test";
import assert from "node:assert/strict";

const { buildRepoManifest } = await import("../../src/audit/extractors/fileInventory.ts");

test("inferLanguage classifies common docs/config without linguist false positives", () => {
  const manifest = buildRepoManifest("demo", [
    { path: "README.md", size_bytes: 1 },
    { path: "docs/GUIDE.MD", size_bytes: 1 },
    { path: "config.yml", size_bytes: 1 },
    { path: "ci.yaml", size_bytes: 1 },
  ]);
  const lang = Object.fromEntries(
    manifest.files.map((f) => [f.path, f.language]),
  );

  assert.equal(lang["README.md"], "markdown");
  assert.equal(lang["docs/GUIDE.MD"], "markdown"); // extension match is case-insensitive
  assert.equal(lang["config.yml"], "yaml");
  assert.equal(lang["ci.yaml"], "yaml");

  // Regression guard for the observed misclassifications.
  assert.notEqual(lang["README.md"], "gcc machine description");
  assert.notEqual(lang["config.yml"], "miniyaml");
});

test("inferLanguage classifies common source languages without misclassification", () => {
  const manifest = buildRepoManifest("demo", [
    { path: "src/index.ts", size_bytes: 1 },
    { path: "src/util.js", size_bytes: 1 },
    { path: "scripts/run.py", size_bytes: 1 },
    { path: "cmd/main.go", size_bytes: 1 },
    { path: "package.json", size_bytes: 1 },
  ]);
  const lang = Object.fromEntries(
    manifest.files.map((f) => [f.path, f.language]),
  );

  assert.equal(lang["src/index.ts"], "typescript");
  assert.equal(lang["src/util.js"], "javascript");
  assert.equal(lang["scripts/run.py"], "python");
  assert.equal(lang["cmd/main.go"], "go");
  assert.equal(lang["package.json"], "json");
});
