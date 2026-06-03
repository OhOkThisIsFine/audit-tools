import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runSyntaxResolutionExecutor } = await import(
  "../src/orchestrator/syntaxResolutionExecutor.ts"
);

async function withTempRepo(fn) {
  const root = await mkdtemp(join(tmpdir(), "audit-code-syntax-resolution-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.js"), "console.log('fixture');\n");
    await writeFakeEslint(root);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFakeEslint(root) {
  const binDir = join(root, "node_modules", "eslint", "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(
    join(binDir, "eslint.js"),
    [
      "const { writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      "writeFileSync(path.join(process.cwd(), 'eslint-ran.txt'), 'ran');",
      "process.stdout.write(JSON.stringify([{",
      "  filePath: path.join(process.cwd(), 'src', 'app.js'),",
      "  messages: [{ severity: 2, line: 1, message: 'fixture lint error', ruleId: 'fixture/rule' }]",
      "}]));",
      "",
    ].join("\n"),
  );
}

function createBundle() {
  return {
    file_disposition: {
      files: [{ path: "src/app.js", status: "included" }],
    },
  };
}

test("syntax resolution skips ESLint when no repo-local ESLint config exists", async () => {
  await withTempRepo(async (root) => {
    const result = runSyntaxResolutionExecutor(createBundle(), root);

    assert.deepEqual(result.updated.external_analyzer_results.results, []);
    assert.deepEqual(
      result.updated.external_analyzer_results.tool_statuses.map((status) => [
        status.tool,
        status.status,
      ]),
      [["eslint", "skipped"]],
    );
    assert.ok(result.updated.syntax_resolution_status);
    assert.ok(result.artifacts_written.includes("syntax_resolution_status.json"));
    assert.equal(existsSync(join(root, "eslint-ran.txt")), false);
  });
});

test("syntax resolution runs ESLint when repo-local ESLint config exists", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");

    const result = runSyntaxResolutionExecutor(createBundle(), root);

    assert.equal(existsSync(join(root, "eslint-ran.txt")), true);
    assert.deepEqual(result.updated.external_analyzer_results.results, [
      {
        id: "eslint-0",
        category: "maintainability",
        severity: "error",
        path: "src/app.js",
        line_start: 1,
        summary: "fixture lint error",
        rule: "fixture/rule",
      },
    ]);
    assert.deepEqual(
      result.updated.external_analyzer_results.tool_statuses.map((status) => [
        status.tool,
        status.status,
      ]),
      [["eslint", "findings"]],
    );
  });
});

test("syntax resolution records unresolved tsc as analyzer diagnostics", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");

    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const result = runSyntaxResolutionExecutor(
        {
          file_disposition: {
            files: [{ path: "src/app.ts", status: "included" }],
          },
        },
        root,
      );

      const tscStatus = result.updated.external_analyzer_results.tool_statuses.find(
        (status) => status.tool === "tsc",
      );
      assert.equal(tscStatus.status, "not_resolved");
      assert.equal(tscStatus.resolved, false);
      assert.match(result.progress_summary, /analyzer diagnostic/i);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

test("syntax resolution stores parse failure snippets for malformed ESLint output", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");
    await writeFile(
      join(root, "node_modules", "eslint", "bin", "eslint.js"),
      "process.stdout.write('not json from eslint');\n",
    );

    const result = runSyntaxResolutionExecutor(createBundle(), root);
    const eslintStatus = result.updated.external_analyzer_results.tool_statuses.find(
      (status) => status.tool === "eslint",
    );

    assert.equal(eslintStatus.status, "parse_error");
    assert.match(eslintStatus.output_snippet, /not json from eslint/);
  });
});
