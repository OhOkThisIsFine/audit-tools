import { test, expect } from "vitest";

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

  expect(lang["README.md"]).toBe("markdown");
  expect(lang["docs/GUIDE.MD"]).toBe("markdown"); // extension match is case-insensitive
  expect(lang["config.yml"]).toBe("yaml");
  expect(lang["ci.yaml"]).toBe("yaml");

  // Regression guard for the observed misclassifications.
  expect(lang["README.md"]).not.toBe("gcc machine description");
  expect(lang["config.yml"]).not.toBe("miniyaml");
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

  expect(lang["src/index.ts"]).toBe("typescript");
  expect(lang["src/util.js"]).toBe("javascript");
  expect(lang["scripts/run.py"]).toBe("python");
  expect(lang["cmd/main.go"]).toBe("go");
  expect(lang["package.json"]).toBe("json");
});
