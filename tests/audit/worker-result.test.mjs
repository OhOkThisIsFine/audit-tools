import { test, expect } from "vitest";

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

  expect(result.contract_version).toBe(WORKER_RESULT_CONTRACT_VERSION);
  expect(result.run_id).toBe(params.runId);
  expect(result.obligation_id).toBe(params.obligationId);
  expect(result.status).toBe(params.status);
  expect(result.progress_made).toBe(params.progressMade);
  expect(result.selected_executor).toBe(params.selectedExecutor);
  expect(result.artifacts_written).toEqual(params.artifactsWritten);
  expect(result.summary).toBe(params.summary);
  expect(result.next_likely_step).toBe(params.nextLikelyStep);
  expect(result.errors).toEqual(params.errors);
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

  expect(result.obligation_id).toBe(null);
  expect(result.selected_executor).toBe(null);
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

  expect(result.includes("2 error(s)"), `expected '2 error(s)' in: ${result}`).toBeTruthy();
  expect(result.includes("task_id must be a string"), `expected first issue message in: ${result}`).toBeTruthy();
});
