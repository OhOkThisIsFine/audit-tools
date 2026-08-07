/**
 * Tests for the REL-fcdad8d2 write-failure path in cmdWorkerRun.
 *
 * cmdWorkerRun accepts an injectable WorkerRunDeps seam ({ readJsonFile,
 * writeJsonFile, runAuditStep }) so this failure path can be exercised under
 * the project's vitest runner without touching the real filesystem.
 */
import { test, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import type { WorkerRunDeps } from "../../src/audit/cli/workerRunCommand.js";
import type { WorkerTask } from "../../src/audit/types/workerSession.js";
import type { WorkerResult } from "../../src/audit/types/workerResult.js";

const { cmdWorkerRun } = await import("../../src/audit/cli/workerRunCommand.js");
const { readJsonFile } = await import("audit-tools/shared");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");

// ---------------------------------------------------------------------------
// REL-fcdad8d2: cmdWorkerRun writes a failed WorkerResult when the result
// write throws a non-transient error (first call fails, second call succeeds)
// ---------------------------------------------------------------------------

test("cmdWorkerRun writes a failed WorkerResult when the result write throws a non-transient error", async () => {
  const dir = await mkdtemp(join(os.tmpdir(), "audit-worker-write-fail-"));
  try {
    const resultPath = join(dir, "result.json");

    const taskBase: WorkerTask = {
      contract_version: "audit-code-worker/v1alpha1",
      run_id: "run-write-fail-001",
      repo_root: dir,
      artifacts_dir: join(dir, ".audit-tools/audit"),
      obligation_id: "audit_tasks_completed",
      preferred_executor: "worker-command",
      result_path: resultPath,
      worker_command: ["node", "-e", "process.exit(0)"],
      audit_results_path: undefined,
      pending_audit_tasks_path: undefined,
    };

    // Write task file so the (default) readJsonFile path can resolve it — the
    // deps below inject the REAL readJsonFile (reading this file from disk) so
    // the stub only needs to cover the write-failure seam under test.
    const taskPath = join(dir, "task.json");
    await writeFile(taskPath, JSON.stringify(taskBase), "utf8");

    // Track writeJsonFile call arguments.
    const writeJsonFileCalls: Array<{ path: string; data: WorkerResult }> = [];
    let writeJsonFileCallCount = 0;

    // Inject deps so:
    //   • readJsonFile resolves with the task object (real fs read)
    //   • writeJsonFile rejects on call #1, resolves on call #2
    //   • runAuditStep returns a successful step result
    const deps: WorkerRunDeps = {
      readJsonFile,
      writeJsonFile: async (path: string, data: unknown): Promise<void> => {
        writeJsonFileCallCount += 1;
        writeJsonFileCalls.push({ path, data: JSON.parse(JSON.stringify(data)) });
        if (writeJsonFileCallCount === 1) {
          throw new Error("EPERM: operation not permitted, open '" + path + "'");
        }
        // Second call succeeds (no-op; we don't need a real write for the assertion).
      },
      runAuditStep: async () => ({
        audit_state: deriveAuditState({}),
        selected_obligation: null,
        progress_made: true,
        progress_summary: "mock step completed",
        selected_executor: "worker-command",
        artifacts_written: [],
        next_likely_step: null,
        updated_bundle: {},
      }),
    };

    // Capture stderr and exitCode.
    const stderrChunks: string[] = [];
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ..._rest) => {
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
    expect(writeJsonFileCallCount, `expected writeJsonFile to be called twice, got ${writeJsonFileCallCount}`).toBe(2);

    // 2. First call targeted the result_path with the original workerResult.
    expect(writeJsonFileCalls[0].path, "first writeJsonFile call should target result_path").toBe(resultPath);

    // 3. Second call was the fallback: status must be "failed".
    expect(writeJsonFileCalls[1].data.status, `second writeJsonFile call should carry status 'failed', got: ${writeJsonFileCalls[1].data.status}`).toBe("failed");

    // 4. Fallback result contains an error message mentioning the original write failure.
    const fallbackErrors = writeJsonFileCalls[1].data.errors ?? [];
    expect(fallbackErrors.some((e) => /EPERM|operation not permitted/i.test(e)), `fallback result errors should mention write failure, got: ${JSON.stringify(fallbackErrors)}`).toBeTruthy();

    // 5. process.exitCode was set to 1.
    expect(process.exitCode, "process.exitCode should be 1 after write failure").toBe(1);

    // 6. process.stderr received a diagnostic message referencing result_path.
    const combinedStderr = stderrChunks.join("");
    expect(combinedStderr.includes(resultPath), `stderr should include result_path, got: ${combinedStderr}`).toBeTruthy();

    process.exitCode = prevExitCode;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
