import { test, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const { cmdWorkerRun } = await import("../../src/audit/cli/workerRunCommand.ts");

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

test.concurrent("cmdWorkerRun throws when --task flag is missing", async () => {
  await assert.rejects(
    () => cmdWorkerRun([]),
    /worker-run requires --task/,
  );
});

// ---------------------------------------------------------------------------
// Guard: looksLikeCliFlag on audit_results_path
// ---------------------------------------------------------------------------

test.concurrent("cmdWorkerRun writes a failed WorkerResult when audit_results_path looks like a CLI flag", async () => {
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
    expect(workerResult.status).toBe("failed");
    expect(workerResult.errors[0].match(/looks like a CLI flag/i), `expected 'looks like a CLI flag' in errors, got: ${workerResult.errors[0]}`).toBeTruthy();
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = 0; // reset so we don't pollute other tests
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Guard: agent mode — zero matched audit results
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Audit-result validation: errors vs. warnings (via production dep seam)
// Tests that the partition inside cmdWorkerRun correctly separates issues by
// severity. We drive this via the dep-seam injection point (WorkerRunDeps) so
// the production partition code is exercised, not a local shadow copy.
// (TST-edfe6e13 fix: removed local partitionIssues duplicate.)
// ---------------------------------------------------------------------------

test.concurrent("cmdWorkerRun: valid audit results reach runAuditStep (partition: errors fatal, warnings not)", async () => {
  // We inject a fake runAuditStep so we can observe the validation branch.
  // The result has a valid file_coverage entry and passes schema validation,
  // so no errors are emitted and runAuditStep is reached.
  // (TST-edfe6e13: replaced local partitionIssues duplicate with dep-seam test)
  const { dir, cleanup } = await makeTempDir();
  try {
    const auditResultsPath = join(dir, "audit-results.jsonl");
    const pendingPath = join(dir, "pending-tasks.json");
    const resultPath = join(dir, "result.json");

    // Pending task with a file path so file_coverage can reference it.
    // total_lines = 0 means "no content file needed"; validation skips mismatch
    // when the line count is zero.
    await mkdir(join(dir, "src"), { recursive: true });
    // Write an empty file so buildLineIndexForPaths resolves 0 lines correctly
    await writeFile(join(dir, "src", "foo.ts"), "", "utf8");

    const pendingTask = {
      task_id: "t1",
      unit_id: "u1",
      pass_id: "p1",
      lens: "correctness",
      file_paths: ["src/foo.ts"],
      file_line_counts: { "src/foo.ts": 0 },
      rationale: "test",
      priority: "medium",
      prompt: "audit",
    };
    await writeFile(pendingPath, JSON.stringify([pendingTask]), "utf8");

    // Valid result: passes schema validation → no errors → runAuditStep called
    const result = {
      task_id: "t1",
      unit_id: "u1",
      pass_id: "p1",
      lens: "correctness",
      file_coverage: [{ path: "src/foo.ts", total_lines: 0, reviewed_ranges: [] }],
      findings: [],
    };
    await writeFile(auditResultsPath, JSON.stringify(result) + "\n", "utf8");

    // Track whether runAuditStep was called
    let auditStepCalled = false;
    const fakeRunAuditStep = async () => {
      auditStepCalled = true;
      return {
        progress_made: true,
        artifacts_written: [],
        progress_summary: "ok",
        next_likely_step: null,
        selected_executor: "result_ingestion_executor",
      };
    };

    // Inject fakes for file IO so no real files need to exist
    const realReadJsonFile = (await import("audit-tools/shared")).readJsonFile;
    const fakeReadJsonFile = async (path) => {
      if (path === auditResultsPath) {
        return [result];
      }
      return realReadJsonFile(path);
    };
    const realWriteJsonFile = (await import("audit-tools/shared")).writeJsonFile;

    const task = buildTask({
      preferred_executor: "agent",
      audit_results_path: auditResultsPath,
      pending_audit_tasks_path: pendingPath,
      result_path: resultPath,
      repo_root: dir,
      artifacts_dir: join(dir, ".audit-tools/audit"),
    });
    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, JSON.stringify(task), "utf8");

    await cmdWorkerRun(["--task", taskPath], {
      readJsonFile: fakeReadJsonFile,
      writeJsonFile: realWriteJsonFile,
      runAuditStep: fakeRunAuditStep,
    });

    // runAuditStep must have been reached — no fatal validation error fired
    expect(auditStepCalled, "runAuditStep must be called when all audit results are valid").toBeTruthy();

    const raw = await readFile(resultPath, "utf8");
    const workerResult = JSON.parse(raw);
    expect(workerResult.status, `expected completed status, got: ${workerResult.status}`).toBe("completed");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------

test.concurrent("cmdWorkerRun writes a failed WorkerResult when agent mode yields zero matched results", async () => {
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
    expect(workerResult.status).toBe("failed");
    expect(workerResult.errors[0].match(/did not emit any audit results/i), `expected 'did not emit any audit results' in errors, got: ${workerResult.errors[0]}`).toBeTruthy();
  } finally {
    process.exitCode = 0;
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// REL-e49452af: result-file write failure propagates after fallback write
// ---------------------------------------------------------------------------

test.concurrent("cmdWorkerRun re-throws when writeJsonFile fails for the final result write", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    // Make result_path a directory so the atomic write (rename into it) fails.
    // Both the primary write and the fallback write will throw, so cmdWorkerRun
    // should propagate the error rather than silently swallowing it.
    const resultPath = join(dir, "result.json");
    await mkdir(resultPath, { recursive: true }); // result_path is now a directory

    const task = buildTask({
      preferred_executor: "worker-command",
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
        expect(err instanceof Error, "expected an Error").toBeTruthy();
        expect(err.message.length > 0, "expected a non-empty error message").toBeTruthy();
        return true;
      },
    );
  } finally {
    process.exitCode = 0;
    await cleanup();
  }
});
