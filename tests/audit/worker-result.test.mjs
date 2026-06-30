import test from "node:test";
import assert from "node:assert/strict";

const {
  buildWorkerResult,
  formatAuditResultValidationError,
  WORKER_RESULT_CONTRACT_VERSION,
} = await import("../../src/audit/cli/workerResult.ts");

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
