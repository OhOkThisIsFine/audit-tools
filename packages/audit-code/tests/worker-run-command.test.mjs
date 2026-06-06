import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const { cmdWorkerRun } = await import("../src/cli/workerRunCommand.ts");

/**
 * Create a temporary directory for a test, return the directory path and a
 * cleanup function. The caller is responsible for calling cleanup() in a
 * finally block.
 */
async function makeTempDir() {
  const dir = await mkdtemp(join(os.tmpdir(), "audit-worker-run-test-"));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Build the minimal JSON content for a WorkerTask JSON file.
 * All paths must already exist (or be created by the caller) before
 * cmdWorkerRun reads them.
 */
function buildTask(overrides = {}) {
  return {
    contract_version: "audit-code-worker/v1alpha1",
    run_id: "run-test-001",
    repo_root: overrides.repo_root ?? "/tmp/repo",
    artifacts_dir: overrides.artifacts_dir ?? "/tmp/repo/.audit-tools/audit",
    obligation_id: "audit_tasks_completed",
    preferred_executor: overrides.preferred_executor ?? "agent",
    result_path: overrides.result_path ?? "/tmp/result.json",
    worker_command: overrides.worker_command ?? ["echo", "ok"],
    audit_results_path: overrides.audit_results_path,
    pending_audit_tasks_path: overrides.pending_audit_tasks_path,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard: missing --task flag
// ---------------------------------------------------------------------------

test("cmdWorkerRun throws when --task flag is missing", async () => {
  await assert.rejects(
    () => cmdWorkerRun([]),
    /worker-run requires --task/,
  );
});

// ---------------------------------------------------------------------------
// Guard: looksLikeCliFlag on audit_results_path
// ---------------------------------------------------------------------------

test("cmdWorkerRun writes a failed WorkerResult when audit_results_path looks like a CLI flag", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const resultPath = join(dir, "result.json");
    const task = buildTask({
      preferred_executor: "agent",
      audit_results_path: "--some-flag",
      result_path: resultPath,
      repo_root: dir,
      artifacts_dir: join(dir, ".audit-tools/audit"),
    });

    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, JSON.stringify(task), "utf8");

    // cmdWorkerRun should NOT throw — it catches the error and writes a failed result.
    await cmdWorkerRun(["--task", taskPath]);

    const raw = await readFile(resultPath, "utf8");
    const workerResult = JSON.parse(raw);
    assert.strictEqual(workerResult.status, "failed");
    assert.ok(
      workerResult.errors[0].match(/looks like a CLI flag/i),
      `expected 'looks like a CLI flag' in errors, got: ${workerResult.errors[0]}`,
    );
    assert.strictEqual(process.exitCode, 1);
  } finally {
    process.exitCode = 0; // reset so we don't pollute other tests
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Guard: agent mode — zero matched audit results
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Single-pass partition: errors vs. warnings
// Tests that the partition correctly separates issues by severity.
// ---------------------------------------------------------------------------

/**
 * Replicate the same partition logic used in workerRunCommand so we can
 * unit-test it without spinning up a full cmdWorkerRun invocation.
 */
function partitionIssues(issues) {
  const errors = [];
  const warnings = [];
  for (const issue of issues) {
    if (issue.severity === "error") {
      errors.push(issue);
    } else {
      warnings.push(issue);
    }
  }
  return { errors, warnings };
}

test("single-pass partition: one error and one warning are separated correctly", () => {
  const errorItem = { severity: "error", message: "bad" };
  const warningItem = { severity: "warning", message: "meh" };
  const { errors, warnings } = partitionIssues([errorItem, warningItem]);
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0], errorItem);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0], warningItem);
});

test("single-pass partition: only error-severity items → warnings is empty", () => {
  const items = [
    { severity: "error", message: "e1" },
    { severity: "error", message: "e2" },
  ];
  const { errors, warnings } = partitionIssues(items);
  assert.strictEqual(errors.length, 2);
  assert.strictEqual(warnings.length, 0);
});

test("single-pass partition: only warning-severity items → errors is empty", () => {
  const items = [
    { severity: "warning", message: "w1" },
    { severity: "warning", message: "w2" },
  ];
  const { errors, warnings } = partitionIssues(items);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(warnings.length, 2);
});

test("single-pass partition: empty array → both buckets are empty", () => {
  const { errors, warnings } = partitionIssues([]);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(warnings.length, 0);
});

// ---------------------------------------------------------------------------

test("cmdWorkerRun writes a failed WorkerResult when agent mode yields zero matched results", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const artifactsDir = join(dir, ".audit-tools/audit");
    await mkdir(artifactsDir, { recursive: true });
    const resultPath = join(dir, "result.json");

    // pending tasks list: one task with a specific ID
    const pendingTasksPath = join(dir, "pending-tasks.json");
    await writeFile(
      pendingTasksPath,
      JSON.stringify([
        {
          task_id: "task-expected",
          unit_id: "unit-1",
          pass_id: "pass-1",
          lens: "correctness",
          file_paths: [],
          context_paths: [],
          hint: "",
        },
      ]),
      "utf8",
    );

    // audit results: one result whose task_id does NOT match
    const auditResultsPath = join(dir, "audit-results.json");
    await writeFile(
      auditResultsPath,
      JSON.stringify([
        {
          task_id: "task-UNRELATED",
          unit_id: "unit-1",
          pass_id: "pass-1",
          lens: "correctness",
          file_coverage: [],
          findings: [],
        },
      ]),
      "utf8",
    );

    const task = buildTask({
      preferred_executor: "agent",
      audit_results_path: auditResultsPath,
      pending_audit_tasks_path: pendingTasksPath,
      result_path: resultPath,
      repo_root: dir,
      artifacts_dir: artifactsDir,
    });

    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, JSON.stringify(task), "utf8");

    await cmdWorkerRun(["--task", taskPath]);

    const raw = await readFile(resultPath, "utf8");
    const workerResult = JSON.parse(raw);
    assert.strictEqual(workerResult.status, "failed");
    assert.ok(
      workerResult.errors[0].match(/did not emit any audit results/i),
      `expected 'did not emit any audit results' in errors, got: ${workerResult.errors[0]}`,
    );
  } finally {
    process.exitCode = 0;
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// REL-e49452af: result-file write failure propagates after fallback write
// ---------------------------------------------------------------------------

test("cmdWorkerRun re-throws when writeJsonFile fails for the final result write", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    // Make result_path a directory so the atomic write (rename into it) fails.
    // Both the primary write and the fallback write will throw, so cmdWorkerRun
    // should propagate the error rather than silently swallowing it.
    const resultPath = join(dir, "result.json");
    await mkdir(resultPath, { recursive: true }); // result_path is now a directory

    const task = buildTask({
      preferred_executor: "local-subprocess",
      result_path: resultPath,
      repo_root: dir,
      artifacts_dir: join(dir, ".audit-tools/audit"),
    });

    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, JSON.stringify(task), "utf8");

    // cmdWorkerRun should throw because both the primary write and the
    // fallback write fail (result_path is a directory, not a file).
    await assert.rejects(
      () => cmdWorkerRun(["--task", taskPath]),
      (err) => {
        assert.ok(err instanceof Error, "expected an Error");
        assert.ok(err.message.length > 0, "expected a non-empty error message");
        return true;
      },
    );
  } finally {
    process.exitCode = 0;
    await cleanup();
  }
});
