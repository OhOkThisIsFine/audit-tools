import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const validateScript = join(here, "..", "..", "dispatch", "validate-result.mjs");
const mergeScript = join(here, "..", "..", "dispatch", "merge-results.mjs");

/** Spawn a script with CLAUDECODE removed from the environment. */
function run(scriptPath, args = [], cwd = process.cwd()) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd,
    env,
    timeout: 10_000,
  });
}

/** Create a temporary directory that is cleaned up in the finally block. */
function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A minimal valid AuditResult object (no pending task in context, so line-count check is skipped). */
function minimalValidResult(taskId) {
  return {
    task_id: taskId,
    unit_id: "src/utils/helper.ts",
    pass_id: "pass-1",
    lens: "correctness",
    file_coverage: [{ path: "src/utils/helper.ts", total_lines: 10 }],
    findings: [],
  };
}

// ── validate-result.mjs ──────────────────────────────────────────────────────

test("validate-result.mjs: exits 1 with usage when both --run-id and --task-id are missing", () => {
  const result = run(validateScript, []);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Usage:/i);
});

test("validate-result.mjs: exits 1 with usage when --task-id is missing", () => {
  const result = run(validateScript, ["--run-id", "run-123"]);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Usage:/i);
});

test("validate-result.mjs: sanitizes task-id special characters in the resolved file path", () => {
  withTempDir("dispatch-scripts-sanitize-", (artifactsDir) => {
    const result = run(validateScript, [
      "--run-id", "run-sanitize",
      "--task-id", "foo/bar baz",
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);
    // The sanitized filename appears in the file-not-found error on stderr
    expect(result.stderr).toMatch(/foo_bar_baz\.json/);
  });
});

test("validate-result.mjs: exits 0 for a valid result file", () => {
  withTempDir("dispatch-scripts-valid-", (artifactsDir) => {
    const runId = "run-valid";
    const taskId = "task-abc";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      JSON.stringify(minimalValidResult(taskId), null, 2),
      "utf8",
    );

    const result = run(validateScript, [
      "--run-id", runId,
      "--task-id", taskId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(new RegExp(taskId));
  });
});

test("validate-result.mjs: exits 1 for a result file with invalid JSON", () => {
  withTempDir("dispatch-scripts-badjson-", (artifactsDir) => {
    const runId = "run-badjson";
    const taskId = "task-bad";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      "{ this is not valid JSON }",
      "utf8",
    );

    const result = run(validateScript, [
      "--run-id", runId,
      "--task-id", taskId,
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Invalid JSON/i);
  });
});

test("validate-result.mjs: default --artifacts-dir resolves under .audit-tools/audit, not .audit-artifacts (COR-bf5c7331)", () => {
  withTempDir("dispatch-scripts-default-dir-", (cwd) => {
    // No --artifacts-dir: the script must default to <cwd>/.audit-tools/audit,
    // matching where the orchestrator/wrapper actually writes runs. The
    // file-not-found error names the resolved path.
    const result = run(validateScript, ["--run-id", "run-x", "--task-id", "task-x"], cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/[/\\]\.audit-tools[/\\]audit[/\\]runs[/\\]run-x[/\\]/);
    expect(result.stderr).not.toMatch(/\.audit-artifacts/);
  });
});

test("merge-results.mjs: default --artifacts-dir resolves under .audit-tools/audit, not .audit-artifacts (COR-bf5c7331)", () => {
  withTempDir("dispatch-scripts-default-dir-merge-", (cwd) => {
    const result = run(mergeScript, ["--run-id", "run-y"], cwd);
    expect(result.status).toBe(1);
    // task-results-not-found error names the resolved default path.
    expect(result.stderr).toMatch(/[/\\]\.audit-tools[/\\]audit[/\\]runs[/\\]run-y[/\\]/);
    expect(result.stderr).not.toMatch(/\.audit-artifacts/);
  });
});

// ── merge-results.mjs ────────────────────────────────────────────────────────

test("merge-results.mjs: exits 1 with usage when --run-id is missing", () => {
  const result = run(mergeScript, []);
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Usage:/i);
});

test("merge-results.mjs: exits 1 when task-results directory does not exist", () => {
  withTempDir("dispatch-scripts-nodir-", (artifactsDir) => {
    const result = run(mergeScript, [
      "--run-id", "run-nodir",
      "--artifacts-dir", artifactsDir,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/task-results directory not found/i);
  });
});

test("merge-results.mjs: separates valid and invalid results, writes both output files", () => {
  withTempDir("dispatch-scripts-merge-", (artifactsDir) => {
    const runId = "run-merge";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    const goodTaskId = "task-good";
    writeFileSync(
      join(taskResultsDir, `${goodTaskId}.json`),
      JSON.stringify(minimalValidResult(goodTaskId), null, 2),
      "utf8",
    );
    writeFileSync(
      join(taskResultsDir, "task-bad.json"),
      "{ not valid json",
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);

    // INV-03: exits non-zero (1) when any result failed validation.
    expect(result.status, `expected non-zero exit on partial failure; stderr: ${result.stderr}`).toBe(1);

    const runResultsPath = join(artifactsDir, "runs", runId, "run-results.json");
    const failedTasksPath = join(artifactsDir, "runs", runId, "failed-tasks.json");

    const runResults = JSON.parse(readFileSync(runResultsPath, "utf8"));
    expect(runResults.length).toBe(1);
    expect(runResults[0].task_id).toBe(goodTaskId);

    const failedTasks = JSON.parse(readFileSync(failedTasksPath, "utf8"));
    expect(failedTasks.length).toBe(1);

    // stderr reports failure count
    expect(result.stderr).toMatch(/1 task\(s\) failed/i);

    // stdout reports passing count in "N/M tasks valid" format
    expect(result.stdout).toMatch(/1\/2 tasks valid/i);
  });
});

test("merge-results.mjs: emits a stderr warning when pending-audit-tasks.json contains invalid JSON", () => {
  withTempDir("dispatch-scripts-badtasks-merge-", (artifactsDir) => {
    const runId = "run-badtasks-merge";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    // Write a valid result file so the script has something to merge
    const taskId = "task-merge-badtasks";
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      JSON.stringify(minimalValidResult(taskId), null, 2),
      "utf8",
    );

    // Write invalid JSON to pending-audit-tasks.json so the read will fail
    const runDir = join(artifactsDir, "runs", runId);
    writeFileSync(join(runDir, "pending-audit-tasks.json"), "{ bad json }", "utf8");

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);

    // Script must NOT exit non-zero due to the bad tasks file
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);

    // A warning about the unreadable tasks file must appear on stderr
    expect(result.stderr).toMatch(/\[warn\] Could not read pending-audit-tasks\.json/);

    // Merge must still produce a run-results.json
    const runResultsPath = join(runDir, "run-results.json");
    const runResults = JSON.parse(readFileSync(runResultsPath, "utf8"));
    expect(runResults.length).toBe(1);
  });
});

test("validate-result.mjs: emits a stderr warning when pending-audit-tasks.json contains invalid JSON", () => {
  withTempDir("dispatch-scripts-badtasks-validate-", (artifactsDir) => {
    const runId = "run-badtasks-validate";
    const taskId = "task-validate-badtasks";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    // Write a valid result file
    writeFileSync(
      join(taskResultsDir, `${taskId}.json`),
      JSON.stringify(minimalValidResult(taskId), null, 2),
      "utf8",
    );

    // Write invalid JSON to pending-audit-tasks.json so the read will fail
    const runDir = join(artifactsDir, "runs", runId);
    writeFileSync(join(runDir, "pending-audit-tasks.json"), "{ bad json }", "utf8");

    const result = run(validateScript, [
      "--run-id", runId,
      "--task-id", taskId,
      "--artifacts-dir", artifactsDir,
    ]);

    // A warning about the unreadable tasks file must appear on stderr
    expect(result.stderr).toMatch(/\[warn\] Could not read pending-audit-tasks\.json/);

    // Validation must still run and pass for the valid result
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
  });
});

// ── INV-01: merge-results.mjs expands AuditResult[] arrays ──────────────────

test("INV-01: merge-results.mjs expands a top-level AuditResult[] array from a single file", () => {
  withTempDir("dispatch-scripts-array-", (artifactsDir) => {
    const runId = "run-array";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    // A single file containing an AuditResult[] array with two results.
    const t1 = minimalValidResult("task-array-1");
    const t2 = minimalValidResult("task-array-2");
    writeFileSync(
      join(taskResultsDir, "packet-abc-inline-result.json"),
      JSON.stringify([t1, t2], null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);

    // Both elements are valid → clean exit.
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);

    const runResultsPath = join(artifactsDir, "runs", runId, "run-results.json");
    const runResults = JSON.parse(readFileSync(runResultsPath, "utf8"));
    expect(runResults.length, "both array elements should be merged").toBe(2);
    const ids = runResults.map((r) => r.task_id).sort();
    expect(ids).toEqual(["task-array-1", "task-array-2"]);

    // stdout should reflect 2/2 tasks valid.
    expect(result.stdout).toMatch(/2\/2 tasks valid/i);
  });
});

// ── INV-03: merge-results.mjs exits 0 on clean merge ────────────────────────

test("INV-03: merge-results.mjs exits 0 when all results are valid", () => {
  withTempDir("dispatch-scripts-cleanexit-", (artifactsDir) => {
    const runId = "run-cleanexit";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    writeFileSync(
      join(taskResultsDir, "task-ok.json"),
      JSON.stringify(minimalValidResult("task-ok"), null, 2),
      "utf8",
    );

    const result = run(mergeScript, [
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);

    expect(result.status, `expected clean exit; stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/1\/1 tasks valid/i);
  });
});
