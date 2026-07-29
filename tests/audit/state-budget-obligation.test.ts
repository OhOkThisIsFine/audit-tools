import { test, expect } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditTask, AuditResult } from "../../src/audit/types.js";
import type { ObligationState } from "../../src/audit/types/auditState.js";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.js");

function task(id: string): AuditTask {
  return {
    task_id: id,
    unit_id: `unit-${id}`,
    pass_id: "pass:correctness",
    lens: "correctness",
    file_paths: [`src/${id}.ts`],
    rationale: `review ${id}`,
  };
}

function result(taskId: string): AuditResult {
  return {
    task_id: taskId,
    unit_id: `unit-${taskId}`,
    pass_id: "pass:correctness",
    lens: "correctness",
    file_coverage: [{ path: `src/${taskId}.ts`, total_lines: 10 }],
    findings: [],
    reviewed_clean: true,
  };
}

function obligationState(bundle: ArtifactBundle, id: string): ObligationState | undefined {
  const state = deriveAuditState(bundle);
  return state.obligations.find((o) => o.id === id)?.state;
}

// ── FINDING-013: audit_tasks_completed satisfiable under budget ─────────────

await test("FINDING-013: deferred tasks are excluded so audit_tasks_completed is satisfied", () => {
  // 5 tasks; 2 are budget-deferred; the other 3 have results.
  const bundle: ArtifactBundle = {
    audit_tasks: ["a", "b", "c", "d", "e"].map(task),
    audit_results: ["a", "b", "c"].map(result),
    active_dispatch: {
      run_id: "r",
      created_at: "now",
      packet_count: 3,
      task_count: 5,
      status: "active",
      deferred_task_ids: ["d", "e"],
    },
  };
  expect(obligationState(bundle, "audit_tasks_completed")).toBe("satisfied");
});

await test("FINDING-013: without the deferred exemption the same state is missing", () => {
  // Same 5 tasks, 3 results, but NO active_dispatch → all tasks must complete.
  const bundle: ArtifactBundle = {
    audit_tasks: ["a", "b", "c", "d", "e"].map(task),
    audit_results: ["a", "b", "c"].map(result),
  };
  expect(obligationState(bundle, "audit_tasks_completed")).toBe("missing");
});

await test("FINDING-013: with active_dispatch but no deferred ids, logic is unchanged (all must complete)", () => {
  const bundle: ArtifactBundle = {
    audit_tasks: ["a", "b", "c", "d", "e"].map(task),
    audit_results: ["a", "b", "c"].map(result),
    active_dispatch: {
      run_id: "r",
      created_at: "now",
      packet_count: 5,
      task_count: 5,
      status: "active",
      // no deferred_task_ids
    },
  };
  expect(obligationState(bundle, "audit_tasks_completed")).toBe("missing");
});

await test("FINDING-013: all non-deferred tasks complete → satisfied even with deferred set", () => {
  const bundle: ArtifactBundle = {
    audit_tasks: ["a", "b", "c"].map(task),
    audit_results: ["a", "b", "c"].map(result),
    active_dispatch: {
      run_id: "r",
      created_at: "now",
      packet_count: 3,
      task_count: 3,
      status: "active",
      deferred_task_ids: [],
    },
  };
  expect(obligationState(bundle, "audit_tasks_completed")).toBe("satisfied");
});

// ── COR-61819bae: runtime_validation_current obligation distinguishes stale vs missing ─

await test("runtime_validation_current: stale when report exists but tasks incomplete (pending result)", () => {
  const bundle: ArtifactBundle = {
    runtime_validation_tasks: {
      tasks: [
        {
          id: "rv-task-1",
          kind: "unit-risk-check",
          target_paths: ["src/a.ts"],
          reason: "high risk",
          priority: "high",
        },
      ],
    },
    runtime_validation_report: {
      results: [
        {
          task_id: "rv-task-1",
          status: "pending",
          summary: "pending",
        },
      ],
    },
  };
  expect(obligationState(bundle, "runtime_validation_current"), "should be stale when report exists but task result is pending").toBe("stale");
});

await test("runtime_validation_current: missing when no report at all", () => {
  const bundle: ArtifactBundle = {
    runtime_validation_tasks: {
      tasks: [
        {
          id: "rv-task-1",
          kind: "unit-risk-check",
          target_paths: ["src/a.ts"],
          reason: "high risk",
          priority: "high",
        },
      ],
    },
    // no runtime_validation_report
  };
  expect(obligationState(bundle, "runtime_validation_current"), "should be missing when no runtime_validation_report exists").toBe("missing");
});

// ── Additional obligation coverage ────────────────────────────────────────────

await test("repo_manifest: satisfied when bundle contains repo_manifest", () => {
  expect(obligationState({ repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01T00:00:00Z", files: [] } }, "repo_manifest")).toBe("satisfied");
});

await test("repo_manifest: missing when bundle lacks repo_manifest", () => {
  expect(obligationState({}, "repo_manifest")).toBe("missing");
});

await test("file_disposition: satisfied when bundle contains file_disposition", () => {
  expect(obligationState({ repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01T00:00:00Z", files: [] }, file_disposition: { files: [] } }, "file_disposition")).toBe("satisfied");
});

await test("file_disposition: missing when bundle lacks file_disposition but has repo_manifest", () => {
  expect(obligationState({ repo_manifest: { repository: { name: "fixture" }, generated_at: "2026-01-01T00:00:00Z", files: [] } }, "file_disposition")).toBe("missing");
});

await test("planning_artifacts: satisfied when the full planning artifact set is present and fresh", () => {
  // planning_artifacts requires the whole planning bundle (coverage_matrix,
  // flow_coverage, runtime_validation_tasks, audit_tasks, requeue_tasks), not
  // audit_tasks alone — the planning_executor emits all of them together. The
  // obligation is also staleness-gated: a planning artifact whose upstream is
  // absent is reported "stale", so the upstream chain must be present too.
  const bundle: ArtifactBundle = {
    tooling_manifest: {
      generated_at: "2026-01-01T00:00:00Z",
      package_root: "/repo",
      package_version: null,
      implementation_hash: "hash",
      inputs: [],
    },
    repo_manifest: {
      repository: { name: "fixture" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [],
    },
    file_disposition: { files: [] },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    external_analyzer_results: [],
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-06-08T04:34:00Z",
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      confirmed_by: "host",
    },
    scope: {
      mode: "full",
      since: null,
      seed_files: [],
      expanded_files: [],
      budget: { max_files: 1000 },
    },
    audit_results: [],
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [task("x")],
    requeue_tasks: [],
  };
  expect(obligationState(bundle, "planning_artifacts")).toBe("satisfied");
});

await test("planning_artifacts: missing when only audit_tasks is present", () => {
  // audit_tasks alone is insufficient — the rest of the planning set is absent.
  expect(obligationState({ audit_tasks: [task("x")] }, "planning_artifacts")).toBe("missing");
});

await test("planning_artifacts: missing when bundle lacks audit_tasks", () => {
  expect(obligationState({}, "planning_artifacts")).toBe("missing");
});

await test("audit_results_ingested: satisfied when all tasks have results and no active dispatch", () => {
  expect(obligationState(
      { audit_tasks: ["a", "b"].map(task), audit_results: ["a", "b"].map(result) },
      "audit_results_ingested",
    )).toBe("satisfied");
});

await test("audit_results_ingested: missing when audit_tasks are present but audit_results is absent", () => {
  expect(obligationState({ audit_tasks: ["a", "b"].map(task) }, "audit_results_ingested")).toBe("missing");
});

await test("runtime_validation_current: satisfied when task has non-pending result", () => {
  const bundle: ArtifactBundle = {
    runtime_validation_tasks: {
      tasks: [
        {
          id: "rv-task-1",
          kind: "unit-risk-check",
          target_paths: ["src/a.ts"],
          reason: "high risk",
          priority: "high",
        },
      ],
    },
    runtime_validation_report: {
      results: [
        {
          task_id: "rv-task-1",
          status: "confirmed",
          summary: "confirmed",
        },
      ],
    },
  };
  expect(obligationState(bundle, "runtime_validation_current"), "should be satisfied when task has a non-pending result").toBe("satisfied");
});
