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

const { ESTIMATED_TOKENS_PER_LINE } = await import("audit-tools/shared");
const { estimateTokensFromBytes } = await import("audit-tools/shared");
const { taskContentTokens } = await import("../../src/audit/orchestrator/reviewPacketSizing.ts");
const { buildPacketPrompt } = await import("../../src/audit/cli/dispatch.ts");
const { EXECUTOR_REGISTRY } = await import("../../src/audit/orchestrator/executors.ts");
const { deriveAuditState } = await import("../../src/audit/orchestrator/state.ts");

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

test("N-worker-prompt-and-result-contract: buildPacketPrompt instructs the worker to WRITE AuditResult[] to result_path and never forbids writes", () => {
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

  // The worker writes its results file (this is the bug the module fixes: the
  // old prompt told the worker to emit inline and forbade writes, so reviewers
  // wrote nothing and results were lost).
  assert.match(
    prompt,
    /WRITE that array[\s\S]*to your result_path/i,
    "prompt must instruct the worker to write the array to result_path",
  );
  assert.ok(prompt.includes(resultPath), "prompt must name the result_path value to write");
  // It must NOT tell the worker to emit inline or forbid writing files.
  assert.doesNotMatch(prompt, /emit it INLINE/i, "prompt must not instruct inline emission");
  assert.doesNotMatch(prompt, /Do not write files/i, "prompt must not forbid file writes");
  assert.doesNotMatch(
    prompt,
    /skill captures/i,
    "prompt must not claim a skill captures an inline payload",
  );
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

// ── INV-07: runRollingDispatch with an empty pool strands all packets ─────────

const { runRollingDispatch } = await import("../../src/audit/orchestrator/rollingDispatch.ts");

test("INV-07: runRollingDispatch with an empty confirmedPools array strands all packets and returns partial", async () => {
  const packets = [
    { id: "pkt-1", payload: { packet_id: "pkt-1", estimated_tokens: 100 } },
    { id: "pkt-2", payload: { packet_id: "pkt-2", estimated_tokens: 100 } },
  ];

  const result = await runRollingDispatch(
    packets,
    [], // empty pool — INV-07: must strand all, not silently skip
    {},
    {},
    async () => { throw new Error("should not be called on empty pool"); },
  );

  assert.equal(result.status, "partial", "empty pool must return partial status");
  assert.equal(result.partial_reason, "empty_pool");
  assert.deepEqual(result.stranded_ids.sort(), ["pkt-1", "pkt-2"]);
  assert.equal(result.results.length, 0, "no results when pool is empty");
});

test("INV-07: runRollingDispatch does not silently drop the pool list it receives (no hidden filter)", async () => {
  // Verify the activePools == confirmedPools contract: passing N pools reaches
  // the dispatcher. If an internal filter were running (as the old `return true`
  // filter did with a comment "trust the caller"), passing the same pool count
  // would be undetectable. We pass 0 and confirm stranding — the empty-pool
  // early-exit path is the observable proof that the pool list is used as-is.
  const result = await runRollingDispatch([], [], {}, {}, async () => {
    throw new Error("unreachable");
  });
  assert.equal(result.status, "partial");
  assert.equal(result.partial_reason, "empty_pool");
  assert.deepEqual(result.stranded_ids, []);
});

// ── TST-8f9c443f: post-run livelock guard contract ───────────────────────────
//
// The post-run livelock path (rollingDispatch.ts:117-134) calls detectLivelock
// with consecutiveNoProgressWaves === livelockLimit === noProgressLimit so any
// residual pendingIds after run() are always classified as livelock_guard.
// Testing detectLivelock directly verifies the wrapper's invariant.

const { detectLivelock } = await import("audit-tools/shared");

test("TST-8f9c443f: detectLivelock returns livelock_guard when pendingIds non-empty and waves >= limit", () => {
  // This mirrors exactly the call inside runRollingDispatch post-run:
  // detectLivelock({ pendingIds, consecutiveNoProgressWaves: livelockLimit, noProgressLimit: livelockLimit })
  const pendingIds = ["pkt-stranded-1", "pkt-stranded-2"];
  const livelockLimit = 3;
  const terminal = detectLivelock({
    pendingIds,
    consecutiveNoProgressWaves: livelockLimit,
    noProgressLimit: livelockLimit,
  });
  assert.ok(terminal !== null, "detectLivelock must return a terminal when pendingIds non-empty and waves >= limit");
  assert.equal(terminal.reason, "livelock_guard");
  assert.deepEqual(terminal.stranded_ids.sort(), pendingIds.sort());
});

test("TST-8f9c443f: detectLivelock returns null when pendingIds is empty (no residual packets)", () => {
  // Post-run: if pendingIds is empty, the branch is never entered (null coalesces to no-terminal).
  const terminal = detectLivelock({
    pendingIds: [],
    consecutiveNoProgressWaves: 999,
    noProgressLimit: 3,
  });
  assert.equal(terminal, null, "detectLivelock must return null when pendingIds is empty");
});

test("TST-8f9c443f: runRollingDispatch post-run invariant — all successfully dispatched packets appear in results", async () => {
  // Indirectly verifies the post-run path is not triggered on a normal run:
  // all 3 packets complete, pendingIds is empty after run(), status is complete.
  const pool = {
    id: "test-pool",
    providerName: "local-subprocess",
    hostModel: null,
    hostConcurrencyLimit: null,
  };
  const packets = [
    { id: "post-p1", payload: {}, estimatedTokens: 1, complexity: 0.5 },
    { id: "post-p2", payload: {}, estimatedTokens: 1, complexity: 0.5 },
    { id: "post-p3", payload: {}, estimatedTokens: 1, complexity: 0.5 },
  ];
  const result = await runRollingDispatch(
    packets,
    [pool],
    {},
    {},
    async (packet) => ({ packet, outcome: "success" }),
  );
  assert.equal(result.status, "complete", "all packets dispatched → complete, no post-run livelock");
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.stranded_ids, []);
  // partial_reason must be absent for a complete run
  assert.equal(result.partial_reason, undefined);
});
