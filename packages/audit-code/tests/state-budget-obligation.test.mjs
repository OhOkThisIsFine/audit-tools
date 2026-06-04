import test from "node:test";
import assert from "node:assert/strict";

const { deriveAuditState } = await import("../src/orchestrator/state.ts");

function task(id) {
  return {
    task_id: id,
    unit_id: `unit-${id}`,
    pass_id: "pass:correctness",
    lens: "correctness",
    file_paths: [`src/${id}.ts`],
    rationale: `review ${id}`,
  };
}

function result(taskId) {
  return {
    task_id: taskId,
    unit_id: `unit-${taskId}`,
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: `src/${taskId}.ts`, total_lines: 10 }],
    findings: [],
  };
}

function obligationState(bundle, id) {
  const state = deriveAuditState(bundle);
  return state.obligations.find((o) => o.id === id)?.state;
}

// ── FINDING-013: audit_tasks_completed satisfiable under budget ─────────────

await test("FINDING-013: deferred tasks are excluded so audit_tasks_completed is satisfied", () => {
  // 5 tasks; 2 are budget-deferred; the other 3 have results.
  const bundle = {
    audit_tasks: ["a", "b", "c", "d", "e"].map(task),
    audit_results: ["a", "b", "c"].map(result),
    active_dispatch: {
      run_id: "r",
      created_at: "now",
      packet_count: 3,
      task_count: 5,
      status: "active",
      phase: "fan_out",
      canary_packet_id: null,
      deferred_task_ids: ["d", "e"],
    },
  };
  assert.equal(obligationState(bundle, "audit_tasks_completed"), "satisfied");
});

await test("FINDING-013: without the deferred exemption the same state is missing", () => {
  // Same 5 tasks, 3 results, but NO active_dispatch → all tasks must complete.
  const bundle = {
    audit_tasks: ["a", "b", "c", "d", "e"].map(task),
    audit_results: ["a", "b", "c"].map(result),
  };
  assert.equal(obligationState(bundle, "audit_tasks_completed"), "missing");
});

await test("FINDING-013: with active_dispatch but no deferred ids, logic is unchanged (all must complete)", () => {
  const bundle = {
    audit_tasks: ["a", "b", "c", "d", "e"].map(task),
    audit_results: ["a", "b", "c"].map(result),
    active_dispatch: {
      run_id: "r",
      created_at: "now",
      packet_count: 5,
      task_count: 5,
      status: "active",
      phase: "fan_out",
      canary_packet_id: null,
      // no deferred_task_ids
    },
  };
  assert.equal(obligationState(bundle, "audit_tasks_completed"), "missing");
});

await test("FINDING-013: all non-deferred tasks complete → satisfied even with deferred set", () => {
  const bundle = {
    audit_tasks: ["a", "b", "c"].map(task),
    audit_results: ["a", "b", "c"].map(result),
    active_dispatch: {
      run_id: "r",
      created_at: "now",
      packet_count: 3,
      task_count: 3,
      status: "active",
      phase: "fan_out",
      canary_packet_id: null,
      deferred_task_ids: [],
    },
  };
  assert.equal(obligationState(bundle, "audit_tasks_completed"), "satisfied");
});
