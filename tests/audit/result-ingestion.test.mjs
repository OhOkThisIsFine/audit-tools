import { test, describe, it, expect } from "vitest";

const { updateAuditTaskStatuses, partitionOrphanedAuditResults } = await import("../../src/audit/orchestrator/resultIngestion.ts");

test("updateAuditTaskStatuses — undefined tasks returns undefined", () => {
  const result = updateAuditTaskStatuses(undefined, []);
  expect(result).toBe(undefined);
});

test("updateAuditTaskStatuses — matching tasks are marked complete", () => {
  const tasks = [
    { task_id: "t1", status: "pending" },
    { task_id: "t2", status: "pending" },
  ];
  const results = [{ task_id: "t1" }];

  const updated = updateAuditTaskStatuses(tasks, results);

  const t1 = updated.find((t) => t.task_id === "t1");
  const t2 = updated.find((t) => t.task_id === "t2");

  expect(t1.status).toBe("complete");
  // t2 is not in results — keeps existing status
  expect(t2.status).toBe("pending");
});

describe("updateAuditTaskStatuses — completed_at is preserved when already set", () => {
  const existingTimestamp = "2025-01-01T00:00:00.000Z";

  it("existing completed_at is NOT overwritten", () => {
    const tasks = [{ task_id: "t1", completed_at: existingTimestamp }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    expect(updated[0].completed_at).toBe(existingTimestamp);
  });

  it("absent completed_at receives a new ISO timestamp string", () => {
    const tasks = [{ task_id: "t1" }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    expect(typeof updated[0].completed_at === "string").toBeTruthy();
    // Must be a valid ISO date
    expect(!isNaN(Date.parse(updated[0].completed_at))).toBeTruthy();
  });
});

describe("updateAuditTaskStatuses — completion_reason defaults to result_ingested", () => {
  it("task without completion_reason gets completion_reason === 'result_ingested'", () => {
    const tasks = [{ task_id: "t1" }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    expect(updated[0].completion_reason).toBe("result_ingested");
  });

  it("task with existing completion_reason keeps its original value", () => {
    const tasks = [{ task_id: "t1", completion_reason: "manual" }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    expect(updated[0].completion_reason).toBe("manual");
  });
});

describe("updateAuditTaskStatuses — non-matching tasks default status to pending", () => {
  it("task with no existing status gets status === 'pending'", () => {
    const tasks = [{ task_id: "t1" }];
    const results = [];

    const updated = updateAuditTaskStatuses(tasks, results);

    expect(updated[0].status).toBe("pending");
  });

  it("task with an existing non-complete status keeps that status", () => {
    const tasks = [{ task_id: "t1", status: "in_progress" }];
    const results = [];

    const updated = updateAuditTaskStatuses(tasks, results);

    expect(updated[0].status).toBe("in_progress");
  });
});

test("partitionOrphanedAuditResults — drops results whose task_id is not in the active manifest", () => {
  const active = new Set(["t1", "t2"]);
  const results = [
    { task_id: "t1", findings: [] },
    { task_id: "deepening:steward:abc", findings: [] },
    { task_id: "t2", findings: [] },
  ];

  const partition = partitionOrphanedAuditResults(results, active);

  expect(partition).toBeTruthy();
  expect(partition.orphanedTaskIds).toEqual(["deepening:steward:abc"]);
  expect(partition.retained.map((r) => r.task_id)).toEqual(["t1", "t2"]);
});

test("partitionOrphanedAuditResults — returns null when there is nothing to filter", () => {
  // No active manifest yet → pass results through unchanged.
  expect(partitionOrphanedAuditResults([{ task_id: "t1" }], new Set())).toBe(null);
  // Not an array.
  expect(partitionOrphanedAuditResults(undefined, new Set(["t1"]))).toBe(null);
});

test("partitionOrphanedAuditResults — keeps every result when all task_ids are active", () => {
  const active = new Set(["t1", "t2"]);
  const results = [{ task_id: "t1" }, { task_id: "t2" }];

  const partition = partitionOrphanedAuditResults(results, active);

  expect(partition).toBeTruthy();
  expect(partition.orphanedTaskIds.length).toBe(0);
  expect(partition.retained.length).toBe(2);
});
