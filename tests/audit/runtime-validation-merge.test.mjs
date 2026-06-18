import test from "node:test";
import assert from "node:assert/strict";

const { mergeRuntimeValidationReport } = await import("../../src/audit/orchestrator/runtimeValidation.ts");

// Minimal valid RuntimeValidationTask shape.
function makeTask(id) {
  return {
    id,
    kind: "unit-risk-check",
    target_paths: ["src/foo.ts"],
    reason: "test",
    priority: "medium",
    command: ["npm", "test"],
    suggested_checks: [],
    source_artifacts: [],
  };
}

// ---------------------------------------------------------------------------
// Prior-result preservation: matching task_id returns the prior result object
// ---------------------------------------------------------------------------

test("mergeRuntimeValidationReport preserves a prior result when task_id matches", () => {
  const tasks = { tasks: [makeTask("runtime:unit:foo")] };
  const existing = {
    results: [
      {
        task_id: "runtime:unit:foo",
        status: "passed",
        summary: "Prior result",
        evidence: [],
        notes: [],
      },
    ],
  };

  const report = mergeRuntimeValidationReport(tasks, existing);

  assert.equal(report.results.length, 1, "should return exactly one result");
  assert.equal(
    report.results[0].status,
    "passed",
    "prior result status must be preserved",
  );
  assert.equal(
    report.results[0].summary,
    "Prior result",
    "prior result summary must be preserved",
  );
  // The returned entry must be the same object reference as the prior result
  // (not a freshly-synthesised stub whose status would default to 'pending').
  assert.strictEqual(
    report.results[0],
    existing.results[0],
    "returned entry must be the prior result object",
  );
});

// ---------------------------------------------------------------------------
// Pending stub: task with no matching prior entry gets a default pending result
// ---------------------------------------------------------------------------

test("mergeRuntimeValidationReport emits a pending stub for a task with no prior result", () => {
  const tasks = { tasks: [makeTask("runtime:unit:bar")] };
  const existing = {
    results: [
      {
        task_id: "runtime:unit:OTHER",
        status: "passed",
        summary: "Unrelated prior",
        evidence: [],
        notes: [],
      },
    ],
  };

  const report = mergeRuntimeValidationReport(tasks, existing);

  assert.equal(report.results.length, 1, "should return exactly one result");
  assert.equal(
    report.results[0].status,
    "pending",
    "result must be pending when no prior entry matches",
  );
  assert.equal(
    report.results[0].task_id,
    "runtime:unit:bar",
    "result task_id must match the task",
  );
});

// ---------------------------------------------------------------------------
// No existing report: all tasks get pending stubs
// ---------------------------------------------------------------------------

test("mergeRuntimeValidationReport with no existing report produces all pending stubs", () => {
  const tasks = {
    tasks: [
      {
        ...makeTask("runtime:unit:baz"),
        priority: "high",
      },
    ],
  };

  // Call with no second argument (existing is undefined).
  const report = mergeRuntimeValidationReport(tasks);

  assert.equal(report.results.length, 1, "should return exactly one result");
  assert.equal(
    report.results[0].status,
    "pending",
    "result must be pending when no existing report is supplied",
  );
  assert.equal(
    report.results[0].task_id,
    "runtime:unit:baz",
    "result task_id must match the task",
  );
});
