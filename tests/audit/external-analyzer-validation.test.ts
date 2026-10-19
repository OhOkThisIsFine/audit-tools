import { expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../../src/audit/cli.js";
import { writeCoreArtifacts } from "../../src/audit/io/artifacts.js";
import { runSyntaxResolutionExecutor } from "../../src/audit/orchestrator/syntaxResolutionExecutor.js";
import { captureConsole } from "./helpers/captureConsole.mjs";
import { withTempDir } from "./helpers/withTempDir.mjs";

function validate(root: string) {
  return captureConsole(() => runCli(["node", "audit-code", "validate", "--root", root]));
}

test("validate accepts the persisted syntax-resolution analyzer array", async () => {
  await withTempDir("audit-analyzer-validation-", async (root) => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "arithmetic.mjs"), "export const add = (a, b) => a + b;\n");
    const artifactsDir = join(root, ".audit-tools", "audit");
    const produced = await runSyntaxResolutionExecutor({
      file_disposition: { files: [{ path: "src/arithmetic.mjs", status: "included" }] },
    }, root);
    await writeCoreArtifacts(artifactsDir, produced.updated);

    // This is the producer's on-disk shape from the completed real audit.
    expect(JSON.parse(await readFile(join(artifactsDir, "external_analyzer_results.json"), "utf8")))
      .toEqual([{ tool: "syntax_resolution_executor", results: [], tool_statuses: [] }]);
    const result = await validate(root);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ issue_count: 0, issues: [] });
  });
});

test.each([
  ["single object", { tool: "eslint", results: [] }],
  ["null", null],
  ["false", false],
  ["non-object element", [null]],
  ["non-string tool", [{ tool: 1, results: [] }]],
  ["missing results", [{ tool: "eslint" }]],
  ["non-array results", [{ tool: "eslint", results: {} }]],
  ["malformed result", [{ tool: "eslint", results: [null] }]],
  ["invalid status", [{ tool: "eslint", results: [], tool_statuses: [{ tool: "eslint", status: "invented" }] }]],
])("validate reports malformed analyzer %s without crashing", async (_name, value) => {
  await withTempDir("audit-analyzer-malformed-", async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "external_analyzer_results.json"), JSON.stringify(value));
    const result = await validate(root);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.issue_count).toBeGreaterThan(0);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/^external_analyzer_results(?:\.|$)/), severity: "error" }),
    ]));
    expect(result.stderr).not.toMatch(/flatMap|Cannot read properties/);
  });
});

test("accepting analyzer arrays does not accept an array-shaped repo manifest", async () => {
  await withTempDir("audit-analyzer-shape-control-", async (root) => {
    const artifactsDir = join(root, ".audit-tools", "audit");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "external_analyzer_results.json"), "[]");
    await writeFile(join(artifactsDir, "repo_manifest.json"), "[]");
    const result = await validate(root);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).issues).toEqual([
      { path: "repo_manifest", message: "Expected an object, got array.", severity: "error" },
    ]);
  });
});
