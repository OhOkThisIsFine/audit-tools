/**
 * N-A06: Rolling dispatch executor tests.
 *
 * Coverage:
 * 1. Byte-based token estimation used when sizeIndex present.
 * 2. Partial-coverage terminal sets flag and synthesis can proceed.
 * 3. Inline structured-output prompt format (no submit-packet, has result_path).
 * 4. executor registry: rolling_dispatch_executor owns audit_tasks_completed,
 *    agent no longer owns it.
 */

import test from "node:test";
import assert from "node:assert/strict";

const { ESTIMATED_TOKENS_PER_LINE } = await import("@audit-tools/shared");
const { estimateTokensFromBytes } = await import("@audit-tools/shared");
const { taskContentTokens } = await import("../src/orchestrator/reviewPacketSizing.ts");
const { buildPacketPrompt } = await import("../src/cli/dispatch.ts");
const { EXECUTOR_REGISTRY } = await import("../src/orchestrator/executors.ts");
const { deriveAuditState } = await import("../src/orchestrator/state.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(id, filePath, fileLinesOrBytes, opts = {}) {
  return {
    task_id: id,
    unit_id: opts.unitId ?? `unit-${id}`,
    pass_id: opts.passId ?? `pass:correctness`,
    lens: opts.lens ?? "correctness",
    file_paths: [filePath],
    file_line_counts: { [filePath]: fileLinesOrBytes },
    rationale: "test",
    priority: opts.priority ?? "medium",
    tags: opts.tags ?? [],
  };
}

function makePacket(id, priority = "medium") {
  return {
    packet_id: id,
    task_ids: [`task-${id}`],
    file_paths: [`src/${id}.ts`],
    file_line_counts: { [`src/${id}.ts`]: 100 },
    total_lines: 100,
    estimated_tokens: 500,
    lenses: ["correctness"],
    priority,
    entrypoints: [],
    key_edges: [],
    boundary_files: [],
    quality: { cohesion_score: 1, internal_edge_count: 0, boundary_edge_count: 0, unexplained_file_count: 0 },
    rationale: "test",
    tags: [],
  };
}

// ── 1. Byte-based token estimation ────────────────────────────────────────────

test("N-A06: taskContentTokens uses byte-based estimate when sizeIndex present", () => {
  const filePath = "src/auth.ts";
  const sizeBytes = 4000;
  const lineCount = 100;
  const task = makeTask("t1", filePath, lineCount);
  const sizeIndex = { [filePath]: sizeBytes };

  const tokensByte = taskContentTokens(task, sizeIndex, {});
  const tokensLine = lineCount * ESTIMATED_TOKENS_PER_LINE;

  // Byte-based: ceil(4000 / 4) = 1000; line-based: 100 * 4 = 400
  assert.equal(tokensByte, estimateTokensFromBytes(sizeBytes), "byte-based tokens should equal estimateTokensFromBytes(size_bytes)");
  assert.notEqual(tokensByte, tokensLine, "byte-based and line-based estimates should differ when sizes differ");
  assert.equal(tokensByte, 1000, "ceil(4000 / 4) = 1000");
});

test("N-A06: taskContentTokens falls back to line-based estimate when sizeIndex missing file", () => {
  const filePath = "src/auth.ts";
  const lineCount = 80;
  const task = makeTask("t1", filePath, lineCount);

  // No sizeIndex entry for this path
  const tokens = taskContentTokens(task, {}, {});
  assert.equal(tokens, lineCount * ESTIMATED_TOKENS_PER_LINE, "should fall back to line-based estimate");
});

test("N-A06: taskContentTokens falls back to line-based estimate when sizeIndex is absent", () => {
  const filePath = "src/auth.ts";
  const lineCount = 60;
  const task = makeTask("t1", filePath, lineCount);

  const tokens = taskContentTokens(task, undefined, {});
  assert.equal(tokens, lineCount * ESTIMATED_TOKENS_PER_LINE, "should fall back to line-based estimate when sizeIndex is undefined");
});

// ── 2. Partial-coverage terminal ──────────────────────────────────────────────

test("N-A06: deriveAuditState with partial_completion_terminal treats stranded tasks as excluded", () => {
  // Minimal bundle with one uncompleted task plus a partial_completion_terminal
  const bundle = {
    provider_confirmation: { confirmed: true },
    repo_manifest: { files: [] },
    file_disposition: { version: 1, items: [] },
    auto_fixes_applied: { applied: [] },
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { edges: [], metadata: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { analyzers: {} },
    design_assessment: { contract_reviewed: true, conceptual_reviewed: true },
    intent_checkpoint: { confirmed: true },
    coverage_matrix: { covered: [], uncovered: [] },
    flow_coverage: { covered: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "t-stranded", status: "pending", file_paths: ["src/a.ts"] },
    ],
    requeue_tasks: [],
    audit_results: [],
    // Partial completion terminal marking t-stranded as stranded
    active_dispatch: {
      run_id: "run-1",
      created_at: new Date().toISOString(),
      packet_count: 0,
      task_count: 1,
      status: "active",
      phase: "fan_out",
      canary_packet_id: null,
      partial_completion_terminal: {
        reason: "empty_pool",
        stranded_ids: ["t-stranded"],
      },
    },
    audit_report: undefined,
    synthesis_narrative: undefined,
  };

  const state = deriveAuditState(bundle);
  const auditTasksObl = state.obligations.find((o) => o.id === "audit_tasks_completed");
  // With partial_completion_terminal, t-stranded is excluded → obligation satisfied
  assert.equal(
    auditTasksObl?.state,
    "satisfied",
    "audit_tasks_completed must be satisfied when all pending tasks are stranded by partial_completion_terminal",
  );
});

test("N-A06: deriveAuditState without partial_completion_terminal blocks on uncompleted tasks", () => {
  const bundle = {
    provider_confirmation: { confirmed: true },
    repo_manifest: { files: [] },
    file_disposition: { version: 1, items: [] },
    auto_fixes_applied: { applied: [] },
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { edges: [], metadata: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { analyzers: {} },
    design_assessment: { contract_reviewed: true, conceptual_reviewed: true },
    intent_checkpoint: { confirmed: true },
    coverage_matrix: { covered: [], uncovered: [] },
    flow_coverage: { covered: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      { task_id: "t-pending", status: "pending", file_paths: ["src/a.ts"] },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: null,
    audit_report: undefined,
    synthesis_narrative: undefined,
  };

  const state = deriveAuditState(bundle);
  const auditTasksObl = state.obligations.find((o) => o.id === "audit_tasks_completed");
  assert.equal(
    auditTasksObl?.state,
    "missing",
    "audit_tasks_completed must be missing when tasks are pending and no partial terminal is set",
  );
});

// ── 3. Inline structured-output prompt format ─────────────────────────────────

test("N-A06: buildPacketPrompt has no submit-packet command text", () => {
  const packet = makePacket("pkt1");
  const prompt = buildPacketPrompt({
    packet,
    packetTasks: [],
    fileList: "- src/pkt1.ts (100 lines)",
    largeFileSection: [],
    taskSections: ["### task-pkt1"],
    resultPath: "/artifacts/runs/r1/task-results/pkt1-inline-result.json",
  });

  assert.doesNotMatch(prompt, /submit-packet/, "prompt must NOT contain submit-packet command");
});

test("N-A06: buildPacketPrompt instructs worker to emit AuditResult[] inline", () => {
  const packet = makePacket("pkt1");
  const resultPath = "/artifacts/runs/r1/task-results/pkt1-inline-result.json";
  const prompt = buildPacketPrompt({
    packet,
    packetTasks: [],
    fileList: "- src/pkt1.ts (100 lines)",
    largeFileSection: [],
    taskSections: ["### task-pkt1"],
    resultPath,
  });

  assert.match(prompt, /emit.*inline/i, "prompt must instruct worker to emit inline");
  assert.match(prompt, /skill captures/i, "prompt must state skill captures the inline payload");
});

test("N-A06: buildPacketPrompt contains result_path so host knows where to write captured output", () => {
  const packet = makePacket("pkt1");
  const resultPath = "/artifacts/runs/r1/task-results/pkt1-inline-result.json";
  const prompt = buildPacketPrompt({
    packet,
    packetTasks: [],
    fileList: "- src/pkt1.ts (100 lines)",
    largeFileSection: [],
    taskSections: ["### task-pkt1"],
    resultPath,
  });

  assert.ok(prompt.includes(resultPath), "prompt must include the result_path value");
  assert.match(prompt, /result_path:/, "prompt must have result_path header field");
});

test("N-A06: buildPacketPrompt does NOT contain the Get-Content PowerShell pipe workaround", () => {
  const packet = makePacket("pkt1");
  const prompt = buildPacketPrompt({
    packet,
    packetTasks: [],
    fileList: "- src/pkt1.ts (100 lines)",
    largeFileSection: [],
    taskSections: ["### task-pkt1"],
    resultPath: "/artifacts/runs/r1/task-results/pkt1-inline-result.json",
  });

  // The old workaround was "Get-Content <file> | & <command>"
  assert.doesNotMatch(
    prompt,
    /Get-Content.*\|.*&/,
    "prompt must NOT contain the PowerShell Get-Content pipe workaround",
  );
});

// ── 4. Executor registry ───────────────────────────────────────────────────────

test("N-A06: rolling_dispatch_executor is in EXECUTOR_REGISTRY and owns audit_tasks_completed", () => {
  const entry = EXECUTOR_REGISTRY.find((e) => e.id === "rolling_dispatch_executor");
  assert.ok(entry, "rolling_dispatch_executor must be in EXECUTOR_REGISTRY");
  assert.equal(entry.kind, "host_delegation", "rolling_dispatch_executor must be host_delegation");
  assert.ok(
    entry.obligation_ids.includes("audit_tasks_completed"),
    "rolling_dispatch_executor must own audit_tasks_completed obligation",
  );
});

test("N-A06: agent executor no longer owns audit_tasks_completed", () => {
  const agentEntry = EXECUTOR_REGISTRY.find((e) => e.id === "agent");
  assert.ok(agentEntry, "agent entry must still exist for backward compatibility");
  assert.equal(agentEntry.obligation_ids.includes("audit_tasks_completed"), false,
    "agent must NOT own audit_tasks_completed (superseded by rolling_dispatch_executor)");
});

test("N-A06: audit_tasks_completed is owned by exactly one executor", () => {
  const owners = EXECUTOR_REGISTRY.filter((e) => e.obligation_ids.includes("audit_tasks_completed"));
  assert.equal(owners.length, 1, "exactly one executor should own audit_tasks_completed");
  assert.equal(owners[0].id, "rolling_dispatch_executor");
});
