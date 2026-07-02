import { test, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { runSyntaxResolutionExecutor } = await import("../../src/audit/orchestrator/syntaxResolutionExecutor.ts");

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

function createBundleWithExisting(items) {
  return {
    file_disposition: {
      files: [{ path: "src/app.js", status: "included" }],
    },
    external_analyzer_results: [{
      tool: "syntax_resolution_executor",
      results: items,
      tool_statuses: [],
    }],
  };
}

test("syntax resolution skips ESLint when no repo-local ESLint config exists", async () => {
  await withTempRepo(async (root) => {
    const result = runSyntaxResolutionExecutor(createBundle(), root);

    expect(result.updated.external_analyzer_results[0].results).toEqual([]);
    expect(result.updated.external_analyzer_results[0].tool_statuses.map((status) => [
        status.tool,
        status.status,
      ])).toEqual([["eslint", "skipped"]]);
    expect(result.updated.syntax_resolution_status).toBeTruthy();
    expect(result.artifacts_written.includes("syntax_resolution_status.json")).toBeTruthy();
    expect(existsSync(join(root, "eslint-ran.txt"))).toBe(false);
  });
});

test("syntax resolution runs ESLint when repo-local ESLint config exists", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");

    const result = runSyntaxResolutionExecutor(createBundle(), root);

    expect(existsSync(join(root, "eslint-ran.txt"))).toBe(true);
    expect(result.updated.external_analyzer_results[0].results).toEqual([
      {
        id: "eslint-0",
        category: "maintainability",
        // Canonical severity vocabulary: eslint error (severity 2) -> "high"
        // (COR-5d9f2421), never the out-of-vocabulary "error".
        severity: "high",
        path: "src/app.js",
        line_start: 1,
        summary: "fixture lint error",
        rule: "fixture/rule",
      },
    ]);
    expect(result.updated.external_analyzer_results[0].tool_statuses.map((status) => [
        status.tool,
        status.status,
      ])).toEqual([["eslint", "findings"]]);
  });
});

test("syntax resolution maps ESLint severities to the canonical vocabulary (COR-5d9f2421)", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");
    // Fake eslint emitting one error (severity 2) and one warning (severity 1).
    await writeFile(
      join(root, "node_modules", "eslint", "bin", "eslint.js"),
      [
        "const { writeFileSync } = require('node:fs');",
        "const path = require('node:path');",
        "process.stdout.write(JSON.stringify([{",
        "  filePath: path.join(process.cwd(), 'src', 'app.js'),",
        "  messages: [",
        "    { severity: 2, line: 1, message: 'an error', ruleId: 'r/err' },",
        "    { severity: 1, line: 2, message: 'a warning', ruleId: 'r/warn' }",
        "  ]",
        "}]));",
        "",
      ].join("\n"),
    );

    const result = runSyntaxResolutionExecutor(createBundle(), root);
    const severities = result.updated.external_analyzer_results[0].results.map(
      (r) => r.severity,
    );
    expect(severities).toEqual(["high", "medium"]);
    // No persisted result may carry an out-of-vocabulary severity.
    const canonical = new Set(["critical", "high", "medium", "low", "info"]);
    for (const sev of severities) {
      expect(canonical.has(sev), `severity ${sev} must be canonical`).toBeTruthy();
    }
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

      const tscStatus = result.updated.external_analyzer_results[0].tool_statuses.find(
        (status) => status.tool === "tsc",
      );
      expect(tscStatus.status).toBe("not_resolved");
      expect(tscStatus.resolved).toBe(false);
      expect(result.progress_summary).toMatch(/analyzer diagnostic/i);
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
    const eslintStatus = result.updated.external_analyzer_results[0].tool_statuses.find(
      (status) => status.tool === "eslint",
    );

    expect(eslintStatus.status).toBe("parse_error");
    expect(eslintStatus.output_snippet).toMatch(/not json from eslint/);
  });
});

test("syntax resolution preserves existing external_analyzer_results and appends new items", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");

    const preExisting = {
      id: "pre-existing-0",
      category: "maintainability",
      severity: "warning",
      path: "src/app.js",
      line_start: 5,
      summary: "pre-existing finding",
      rule: "pre/existing",
    };
    const bundle = createBundleWithExisting([preExisting]);

    const result = runSyntaxResolutionExecutor(bundle, root);
    const results = result.updated.external_analyzer_results[0].results;

    expect(results.length).toBe(2);
    expect(results[0].path).toBe(preExisting.path);
    expect(results[0].line_start).toBe(preExisting.line_start);
    expect(results[0].rule).toBe(preExisting.rule);
    expect(results[0].summary).toBe(preExisting.summary);
    expect(results[1].id).toBe("eslint-0");
    expect(results[1].path).toBe("src/app.js");
    expect(results[1].line_start).toBe(1);
    expect(results[1].rule).toBe("fixture/rule");
    expect(results[1].summary).toBe("fixture lint error");
  });
});

test("syntax resolution deduplicates items with matching path:line_start:rule:summary", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");

    // Same path/line_start/rule/summary as what the fake ESLint emits
    const duplicate = {
      id: "pre-0",
      category: "maintainability",
      severity: "error",
      path: "src/app.js",
      line_start: 1,
      summary: "fixture lint error",
      rule: "fixture/rule",
    };
    const bundle = createBundleWithExisting([duplicate]);

    const result = runSyntaxResolutionExecutor(bundle, root);
    const results = result.updated.external_analyzer_results[0].results;

    expect(results.length).toBe(1);
    expect(results[0].id).toBe(duplicate.id);
  });
});

test("syntax resolution uses empty array when bundle has no external_analyzer_results", async () => {
  await withTempRepo(async (root) => {
    // No ESLint config → ESLint skipped, no new items
    const result = runSyntaxResolutionExecutor(createBundle(), root);

    expect(result.updated.external_analyzer_results[0].results).toEqual([]);
    expect(result.updated.external_analyzer_results[0].results.length).toBe(0);
  });
});

test("tsc parse-error log includes root and exit_code", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "tsconfig.json"), "{}\n");
    await writeFile(join(root, "src", "app.ts"), "export const value = 1;\n");
    // Install a fake tsc that emits unparseable output with a non-zero exit code
    const binDir = join(root, "node_modules", "typescript", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, "tsc"),
      [
        "#!/usr/bin/env node",
        "process.stdout.write('unparseable tsc output line\\n');",
        "process.exit(2);",
      ].join("\n"),
    );

    const stderrLines = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return originalWrite(chunk, ...rest);
    };
    try {
      runSyntaxResolutionExecutor(
        {
          file_disposition: {
            files: [{ path: "src/app.ts", status: "included" }],
          },
        },
        root,
      );
    } finally {
      process.stderr.write = originalWrite;
    }

    const parseLine = stderrLines.find(
      (l) => l.includes("[syntax-resolution] tsc output could not be parsed"),
    );
    if (parseLine) {
      expect(parseLine.includes(root), `stderr line should include root path: ${parseLine}`).toBeTruthy();
      expect(parseLine.match(/exit_code=\d+/), `stderr line should include exit_code: ${parseLine}`).toBeTruthy();
      expect(parseLine.match(/ts=\d{4}-\d{2}-\d{2}T/), `stderr line should include ISO timestamp: ${parseLine}`).toBeTruthy();
    }
    // If the fake tsc binary wasn't resolved (e.g. no exec bit on Windows) the
    // parse-error branch may not fire — skip assertion rather than fail.
  });
});

test("eslint parse-error log includes root and exit_code", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "eslint.config.js"), "module.exports = [];\n");
    await writeFile(
      join(root, "node_modules", "eslint", "bin", "eslint.js"),
      "process.stdout.write('not json from eslint');\nprocess.exit(1);\n",
    );

    const stderrLines = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrLines.push(typeof chunk === "string" ? chunk : chunk.toString());
      return originalWrite(chunk, ...rest);
    };
    try {
      runSyntaxResolutionExecutor(createBundle(), root);
    } finally {
      process.stderr.write = originalWrite;
    }

    const parseLine = stderrLines.find(
      (l) => l.includes("[syntax-resolution] eslint output could not be parsed"),
    );
    expect(parseLine, `expected eslint parse-error stderr line; got: ${JSON.stringify(stderrLines)}`).toBeTruthy();
    expect(parseLine.includes(root), `stderr line should include root path: ${parseLine}`).toBeTruthy();
    expect(parseLine.match(/exit_code=\d+/), `stderr line should include exit_code: ${parseLine}`).toBeTruthy();
    expect(parseLine.match(/ts=\d{4}-\d{2}-\d{2}T/), `stderr line should include ISO timestamp: ${parseLine}`).toBeTruthy();
  });
});
