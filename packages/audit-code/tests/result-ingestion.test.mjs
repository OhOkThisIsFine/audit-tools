import test from "node:test";
import assert from "node:assert/strict";

const { updateAuditTaskStatuses, partitionOrphanedAuditResults } = await import(
  "../src/orchestrator/resultIngestion.ts"
);

test("updateAuditTaskStatuses — undefined tasks returns undefined", () => {
  const result = updateAuditTaskStatuses(undefined, []);
  assert.equal(result, undefined);
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

  assert.equal(t1.status, "complete");
  // t2 is not in results — keeps existing status
  assert.equal(t2.status, "pending");
});

test("updateAuditTaskStatuses — completed_at is preserved when already set", async (t) => {
  const existingTimestamp = "2025-01-01T00:00:00.000Z";

  await t.test("existing completed_at is NOT overwritten", () => {
    const tasks = [{ task_id: "t1", completed_at: existingTimestamp }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    assert.equal(updated[0].completed_at, existingTimestamp);
  });

  await t.test("absent completed_at receives a new ISO timestamp string", () => {
    const tasks = [{ task_id: "t1" }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    assert.ok(typeof updated[0].completed_at === "string");
    // Must be a valid ISO date
    assert.ok(!isNaN(Date.parse(updated[0].completed_at)));
  });
});

test("updateAuditTaskStatuses — completion_reason defaults to result_ingested", async (t) => {
  await t.test("task without completion_reason gets completion_reason === 'result_ingested'", () => {
    const tasks = [{ task_id: "t1" }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    assert.equal(updated[0].completion_reason, "result_ingested");
  });

  await t.test("task with existing completion_reason keeps its original value", () => {
    const tasks = [{ task_id: "t1", completion_reason: "manual" }];
    const results = [{ task_id: "t1" }];

    const updated = updateAuditTaskStatuses(tasks, results);

    assert.equal(updated[0].completion_reason, "manual");
  });
});

test("updateAuditTaskStatuses — non-matching tasks default status to pending", async (t) => {
  await t.test("task with no existing status gets status === 'pending'", () => {
    const tasks = [{ task_id: "t1" }];
    const results = [];

    const updated = updateAuditTaskStatuses(tasks, results);

    assert.equal(updated[0].status, "pending");
  });

  await t.test("task with an existing non-complete status keeps that status", () => {
    const tasks = [{ task_id: "t1", status: "in_progress" }];
    const results = [];

    const updated = updateAuditTaskStatuses(tasks, results);

    assert.equal(updated[0].status, "in_progress");
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

  assert.ok(partition);
  assert.deepEqual(partition.orphanedTaskIds, ["deepening:steward:abc"]);
  assert.deepEqual(
    partition.retained.map((r) => r.task_id),
    ["t1", "t2"],
  );
});

test("partitionOrphanedAuditResults — returns null when there is nothing to filter", () => {
  // No active manifest yet → pass results through unchanged.
  assert.equal(partitionOrphanedAuditResults([{ task_id: "t1" }], new Set()), null);
  // Not an array.
  assert.equal(partitionOrphanedAuditResults(undefined, new Set(["t1"])), null);
});

test("partitionOrphanedAuditResults — keeps every result when all task_ids are active", () => {
  const active = new Set(["t1", "t2"]);
  const results = [{ task_id: "t1" }, { task_id: "t2" }];

  const partition = partitionOrphanedAuditResults(results, active);

  assert.ok(partition);
  assert.equal(partition.orphanedTaskIds.length, 0);
  assert.equal(partition.retained.length, 2);
});
