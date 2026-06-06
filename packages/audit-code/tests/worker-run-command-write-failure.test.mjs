/**
 * Tests for the REL-fcdad8d2 write-failure path in cmdWorkerRun.
 *
 * cmdWorkerRun accepts an injectable WorkerRunDeps seam ({ readJsonFile,
 * writeJsonFile, runAuditStep }) so this failure path can be exercised under
 * the project's `node --import tsx/esm --test` runner, which cannot use
 * `t.mock.module` (module mocking requires --experimental-test-module-mocks
 * and conflicts with the tsx/esm loader). We inject the dependencies directly
 * instead of mocking the module graph.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";

const { cmdWorkerRun } = await import("../src/cli/workerRunCommand.ts");

// ---------------------------------------------------------------------------
// REL-fcdad8d2: cmdWorkerRun writes a failed WorkerResult when the result
// write throws a non-transient error (first call fails, second call succeeds)
// ---------------------------------------------------------------------------

test("cmdWorkerRun writes a failed WorkerResult when the result write throws a non-transient error", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "audit-worker-write-fail-"));
  try {
    const resultPath = join(dir, "result.json");

    const taskBase = {
      contract_version: "audit-code-worker/v1alpha1",
      run_id: "run-write-fail-001",
      repo_root: dir,
      artifacts_dir: join(dir, ".audit-tools/audit"),
      obligation_id: "audit_tasks_completed",
      preferred_executor: "local-subprocess",
      result_path: resultPath,
      worker_command: ["node", "-e", "process.exit(0)"],
      audit_results_path: undefined,
      pending_audit_tasks_path: undefined,
    };

    // Write task file so the (default) readJsonFile path would also resolve it,
    // though we inject a stub readJsonFile below for determinism.
    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, JSON.stringify(taskBase), "utf8");

    // Track writeJsonFile call arguments.
    const writeJsonFileCalls = [];
    let writeJsonFileCallCount = 0;

    // Inject deps so:
    //   • readJsonFile resolves with the task object
    //   • writeJsonFile rejects on call #1, resolves on call #2
    //   • runAuditStep returns a successful step result
    const deps = {
      readJsonFile: async (_path) => taskBase,
      writeJsonFile: async (path, data) => {
        writeJsonFileCallCount += 1;
        writeJsonFileCalls.push({ path, data: JSON.parse(JSON.stringify(data)) });
        if (writeJsonFileCallCount === 1) {
          throw new Error("EPERM: operation not permitted, open '" + path + "'");
        }
        // Second call succeeds (no-op; we don't need a real write for the assertion).
      },
      runAuditStep: async () => ({
        progress_made: true,
        progress_summary: "mock step completed",
        selected_executor: "local-subprocess",
        artifacts_written: [],
        next_likely_step: null,
      }),
    };

    // Capture stderr and exitCode.
    const stderrChunks = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };

    const prevExitCode = process.exitCode;
    process.exitCode = 0;

    try {
      // Should NOT throw — on first write failure the catch block runs the
      // best-effort second write, logs to stderr, sets exitCode=1, and returns.
      await cmdWorkerRun(["--task", taskPath], deps);
    } finally {
      process.stderr.write = originalStderrWrite;
    }

    // ── Assertions ─────────────────────────────────────────────────────────

    // 1. writeJsonFile was called exactly twice.
    assert.strictEqual(
      writeJsonFileCallCount,
      2,
      `expected writeJsonFile to be called twice, got ${writeJsonFileCallCount}`,
    );

    // 2. First call targeted the result_path with the original workerResult.
    assert.strictEqual(
      writeJsonFileCalls[0].path,
      resultPath,
      "first writeJsonFile call should target result_path",
    );

    // 3. Second call was the fallback: status must be "failed".
    assert.strictEqual(
      writeJsonFileCalls[1].data.status,
      "failed",
      `second writeJsonFile call should carry status 'failed', got: ${writeJsonFileCalls[1].data.status}`,
    );

    // 4. Fallback result contains an error message mentioning the original write failure.
    const fallbackErrors = writeJsonFileCalls[1].data.errors ?? [];
    assert.ok(
      fallbackErrors.some((e) => /EPERM|operation not permitted/i.test(e)),
      `fallback result errors should mention write failure, got: ${JSON.stringify(fallbackErrors)}`,
    );

    // 5. process.exitCode was set to 1.
    assert.strictEqual(
      process.exitCode,
      1,
      "process.exitCode should be 1 after write failure",
    );

    // 6. process.stderr received a diagnostic message referencing result_path.
    const combinedStderr = stderrChunks.join("");
    assert.ok(
      combinedStderr.includes(resultPath),
      `stderr should include result_path, got: ${combinedStderr}`,
    );

    process.exitCode = prevExitCode;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
