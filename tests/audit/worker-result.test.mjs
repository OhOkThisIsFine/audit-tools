import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const {
  buildWorkerResult,
  isWorkerResult,
  buildWorkerFailureBlocker,
  formatAuditResultValidationError,
  persistWorkerRunArtifacts,
  WORKER_RESULT_CONTRACT_VERSION,
} = await import("../../src/audit/cli/workerResult.ts");

const { readJsonFile } = await import("audit-tools/shared");

// ── buildWorkerResult ─────────────────────────────────────────────────────────

await test("buildWorkerResult maps all params to WorkerResult contract fields", () => {
  const params = {
    runId: "run-abc",
    obligationId: "audit_tasks_completed",
    status: "completed",
    progressMade: true,
    selectedExecutor: "claude-code",
    artifactsWritten: ["a.json", "b.json"],
    summary: "All good",
    nextLikelyStep: "synthesis_current",
    errors: [],
  };
  const result = buildWorkerResult(params);

  assert.equal(result.contract_version, WORKER_RESULT_CONTRACT_VERSION);
  assert.equal(result.run_id, params.runId);
  assert.equal(result.obligation_id, params.obligationId);
  assert.equal(result.status, params.status);
  assert.equal(result.progress_made, params.progressMade);
  assert.equal(result.selected_executor, params.selectedExecutor);
  assert.deepEqual(result.artifacts_written, params.artifactsWritten);
  assert.equal(result.summary, params.summary);
  assert.equal(result.next_likely_step, params.nextLikelyStep);
  assert.deepEqual(result.errors, params.errors);
});

await test("buildWorkerResult accepts null obligation_id and null selected_executor", () => {
  const result = buildWorkerResult({
    runId: "run-null",
    obligationId: null,
    status: "failed",
    progressMade: false,
    selectedExecutor: null,
    artifactsWritten: [],
    summary: "nothing",
    nextLikelyStep: null,
    errors: [],
  });

  assert.equal(result.obligation_id, null);
  assert.equal(result.selected_executor, null);
});

// ── isWorkerResult ────────────────────────────────────────────────────────────

await test("isWorkerResult returns true for a valid WorkerResult object", () => {
  const result = buildWorkerResult({
    runId: "run-1",
    obligationId: null,
    status: "completed",
    progressMade: true,
    selectedExecutor: null,
    artifactsWritten: [],
    summary: "ok",
    nextLikelyStep: null,
    errors: [],
  });
  assert.equal(isWorkerResult(result), true);
});

await test("isWorkerResult returns false for wrong contract_version", () => {
  assert.equal(isWorkerResult({ contract_version: "wrong" }), false);
});

await test("isWorkerResult returns false for null, primitives, and objects missing contract_version", () => {
  assert.equal(isWorkerResult(null), false);
  assert.equal(isWorkerResult(42), false);
  assert.equal(isWorkerResult({}), false);
  assert.equal(isWorkerResult(undefined), false);
});

// ── buildWorkerFailureBlocker ─────────────────────────────────────────────────

await test("buildWorkerFailureBlocker concatenates summary and non-empty errors", () => {
  const workerResult = buildWorkerResult({
    runId: "run-2",
    obligationId: null,
    status: "failed",
    progressMade: false,
    selectedExecutor: null,
    artifactsWritten: [],
    summary: "Something went wrong",
    nextLikelyStep: null,
    errors: ["error detail 1", "error detail 2"],
  });
  const result = buildWorkerFailureBlocker(workerResult);

  assert.ok(result.includes(workerResult.summary), "should include summary");
  assert.ok(result.includes("error detail 1"), "should include first error");
  assert.ok(result.includes("error detail 2"), "should include second error");
});

await test("buildWorkerFailureBlocker returns only summary when errors are empty", () => {
  const workerResult = buildWorkerResult({
    runId: "run-3",
    obligationId: null,
    status: "completed",
    progressMade: true,
    selectedExecutor: null,
    artifactsWritten: [],
    summary: "done",
    nextLikelyStep: null,
    errors: [],
  });
  assert.equal(buildWorkerFailureBlocker(workerResult), "done");
});

await test("buildWorkerFailureBlocker returns only summary when errors are whitespace-only", () => {
  const workerResult = buildWorkerResult({
    runId: "run-4",
    obligationId: null,
    status: "completed",
    progressMade: true,
    selectedExecutor: null,
    artifactsWritten: [],
    summary: "done",
    nextLikelyStep: null,
    errors: ["   "],
  });
  assert.equal(buildWorkerFailureBlocker(workerResult), "done");
});

// ── formatAuditResultValidationError ─────────────────────────────────────────

await test("formatAuditResultValidationError includes error count and formatted issues", () => {
  const issues = [
    {
      result_index: 0,
      task_id: "T-1",
      field: "task_id",
      path: "task_id",
      message: "task_id must be a string",
      severity: "error",
    },
    {
      result_index: 0,
      task_id: "T-1",
      field: "lens",
      path: "lens",
      message: "Invalid lens 'bad'",
      severity: "error",
    },
  ];
  const result = formatAuditResultValidationError(issues);

  assert.ok(result.includes("2 error(s)"), `expected '2 error(s)' in: ${result}`);
  assert.ok(
    result.includes("task_id must be a string"),
    `expected first issue message in: ${result}`,
  );
});

// ── persistWorkerRunArtifacts ─────────────────────────────────────────────────

await test("persistWorkerRunArtifacts writes result JSON and status JSON to the given paths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "worker-result-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const workerResult = buildWorkerResult({
    runId: "run-persist",
    obligationId: "synthesis_current",
    status: "completed",
    progressMade: true,
    selectedExecutor: "claude-code",
    artifactsWritten: ["audit-findings.json"],
    summary: "Synthesis complete",
    nextLikelyStep: null,
    errors: [],
  });

  const paths = {
    runDir: dir,
    taskPath: join(dir, "task.json"),
    promptPath: join(dir, "prompt.md"),
    resultPath: join(dir, "result.json"),
    stdoutPath: join(dir, "stdout.txt"),
    stderrPath: join(dir, "stderr.txt"),
    statusPath: join(dir, "status.json"),
  };

  await persistWorkerRunArtifacts(paths, workerResult, "worker");

  const writtenResult = await readJsonFile(paths.resultPath);
  assert.deepEqual(writtenResult, workerResult, "result file should deep-equal the workerResult");

  const writtenStatus = await readJsonFile(paths.statusPath);
  assert.equal(writtenStatus.run_id, workerResult.run_id);
  assert.equal(writtenStatus.status, workerResult.status);
  assert.equal(writtenStatus.execution_mode, "worker");
  assert.equal(writtenStatus.result_path, paths.resultPath);
});
