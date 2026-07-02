// Tests for N-CE301: partial-completion terminal — audit state + synthesis report

import { test, expect } from "vitest";

const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");
const { buildAuditReportModel, renderAuditReportMarkdown } = await import("../../src/audit/reporting/synthesis.ts");

// ── Minimal bundle helpers ───────────────────────────────────────────────────

function makeMinimalBundle(overrides = {}) {
  return {
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: "2026-01-01T00:00:00Z",
      files: [{ path: "src/a.ts", language: "ts", size_bytes: 100 }],
    },
    file_disposition: {
      files: [{ path: "src/a.ts", status: "included" }],
    },
    auto_fixes_applied: { fixes: [] },
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { edges: [], nodes: [] },
    critical_flows: { flows: [] },
    risk_register: { risks: [] },
    analyzer_capability: { analyzers: [] },
    design_assessment: { reviewed: true, summary: "" },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: "2026-01-01T00:00:00Z",
      confirmed_by: "host",
      scope_summary: "all",
      intent_summary: "full audit",
    },
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [],
    requeue_tasks: [],
    ...overrides,
  };
}

// ── audit state: partial_completion_terminal unlocks synthesis ───────────────

await test("N-CE301: pending audit tasks keep audit_tasks_completed missing (baseline)", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
    ],
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "without terminal, pending tasks → missing").toBe("missing");
});

await test("N-CE301: partial_completion_terminal present → audit_tasks_completed satisfied despite pending tasks", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
    ],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 1,
      task_count: 1,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1"],
      },
    },
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "partial_completion_terminal must unlock audit_tasks_completed").toBe("satisfied");
});

await test("N-CE301: livelock_guard terminal also satisfies audit_tasks_completed", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      { task_id: "T2", status: "pending", unit_id: "U2", lens: "correctness" },
      { task_id: "T3", status: "pending", unit_id: "U3", lens: "security" },
    ],
    active_dispatch: {
      run_id: "R2",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "livelock_guard",
        stranded_ids: ["T2", "T3"],
      },
    },
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state).toBe("satisfied");
});

await test("N-CE301: terminal only covers stranded IDs — non-stranded pending tasks still block", () => {
  const bundle = makeMinimalBundle({
    audit_tasks: [
      { task_id: "T1", status: "pending", unit_id: "U1", lens: "security" },
      { task_id: "T2", status: "pending", unit_id: "U2", lens: "correctness" },
    ],
    active_dispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      // Only T1 is stranded — T2 should still show as missing
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1"],
      },
    },
  });
  const state = deriveAuditState(bundle);
  const atc = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(atc?.state, "T2 is still pending and NOT stranded → missing").toBe("missing");
});

// ── synthesis report: stranded_unit_count from partial_completion_terminal ───

await test("N-CE301: stranded_unit_count populated from partial_completion_terminal", () => {
  const model = buildAuditReportModel({
    results: [],
    activeDispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1", "T2"],
      },
    },
  });
  expect(model.summary.stranded_unit_count).toBe(2);
});

await test("N-CE301: stranded_unit_count absent when no partial_completion_terminal", () => {
  const model = buildAuditReportModel({ results: [] });
  expect(model.summary.stranded_unit_count === undefined ||
      model.summary.stranded_unit_count === 0, "stranded_unit_count must be absent or 0 when no terminal").toBeTruthy();
});

await test("N-CE301: renderAuditReportMarkdown includes partial-coverage warning when stranded_unit_count > 0", () => {
  const model = buildAuditReportModel({
    results: [],
    activeDispatch: {
      run_id: "R1",
      created_at: "2026-01-01T00:00:00Z",
      packet_count: 2,
      task_count: 2,
      status: "active",
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["T1", "T2"],
      },
    },
  });
  const md = renderAuditReportMarkdown(model);
  expect(md).toMatch(/2 unit\(s\) were not audited because the provider pool was exhausted before dispatch could complete \(partial coverage\)/);
});

await test("N-CE301: no partial-coverage warning when no terminal set", () => {
  const model = buildAuditReportModel({ results: [] });
  const md = renderAuditReportMarkdown(model);
  expect(md).not.toMatch(/provider pool was exhausted/);
});
