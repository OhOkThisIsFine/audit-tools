import { test, expect } from "vitest";

import { mergeRuntimeValidationReport } from "../../src/audit/orchestrator/runtimeValidation.js";
import type {
  RuntimeValidationReport,
  RuntimeValidationTask,
} from "../../src/audit/types/runtimeValidation.js";

// Minimal valid RuntimeValidationTask shape.
function makeTask(id: string): RuntimeValidationTask {
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
  // "confirmed" (a real RuntimeValidationStatus member): the original fixture's
  // "passed" was never in the enum — the property under test is that the prior
  // entry survives BY REFERENCE, which any non-pending member demonstrates.
  const existing: RuntimeValidationReport = {
    results: [
      {
        task_id: "runtime:unit:foo",
        status: "confirmed",
        summary: "Prior result",
        evidence: [],
        notes: [],
      },
    ],
  };

  const report = mergeRuntimeValidationReport(tasks, existing);

  expect(report.results.length, "should return exactly one result").toBe(1);
  expect(report.results[0].status, "prior result status must be preserved").toBe("confirmed");
  expect(report.results[0].summary, "prior result summary must be preserved").toBe("Prior result");
  // The returned entry must be the same object reference as the prior result
  // (not a freshly-synthesised stub whose status would default to 'pending').
  expect(report.results[0], "returned entry must be the prior result object").toBe(existing.results[0]);
});

// ---------------------------------------------------------------------------
// Pending stub: task with no matching prior entry gets a default pending result
// ---------------------------------------------------------------------------

test("mergeRuntimeValidationReport emits a pending stub for a task with no prior result", () => {
  const tasks = { tasks: [makeTask("runtime:unit:bar")] };
  const existing: RuntimeValidationReport = {
    results: [
      {
        task_id: "runtime:unit:OTHER",
        status: "confirmed",
        summary: "Unrelated prior",
        evidence: [],
        notes: [],
      },
    ],
  };

  const report = mergeRuntimeValidationReport(tasks, existing);

  expect(report.results.length, "should return exactly one result").toBe(1);
  expect(report.results[0].status, "result must be pending when no prior entry matches").toBe("pending");
  expect(report.results[0].task_id, "result task_id must match the task").toBe("runtime:unit:bar");
});

// ---------------------------------------------------------------------------
// No existing report: all tasks get pending stubs
// ---------------------------------------------------------------------------

test("mergeRuntimeValidationReport with no existing report produces all pending stubs", () => {
  const tasks = {
    tasks: [
      {
        ...makeTask("runtime:unit:baz"),
        priority: "high" as const,
      },
    ],
  };

  // Call with no second argument (existing is undefined).
  const report = mergeRuntimeValidationReport(tasks);

  expect(report.results.length, "should return exactly one result").toBe(1);
  expect(report.results[0].status, "result must be pending when no existing report is supplied").toBe("pending");
  expect(report.results[0].task_id, "result task_id must match the task").toBe("runtime:unit:baz");
});
