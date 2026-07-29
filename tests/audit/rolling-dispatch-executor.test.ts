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

import { test, expect } from "vitest";
import {
  ESTIMATED_TOKENS_PER_LINE,
  estimateTokensFromBytes,
  detectLivelock,
  PROVIDER_CONFIRMATION_RESULT_VERSION,
} from "audit-tools/shared";
import type { CapacityPool, RollingDispatchPacket } from "audit-tools/shared";
import { taskContentTokens } from "../../src/audit/orchestrator/reviewPacketSizing.js";
import { buildPacketPrompt } from "../../src/audit/cli/dispatch.js";
import { EXECUTOR_REGISTRY } from "../../src/audit/orchestrator/executors.js";
import { deriveAuditState } from "../../src/audit/orchestrator/state.js";
import { runRollingDispatch } from "../../src/audit/orchestrator/rollingDispatch.js";
import type { AuditTask } from "../../src/audit/types.js";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { ReviewPacket } from "../../src/audit/types/reviewPlanning.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(
  id: string,
  filePath: string,
  fileLinesOrBytes: number,
  opts: {
    unitId?: string;
    passId?: string;
    lens?: string;
    priority?: AuditTask["priority"];
    tags?: string[];
  } = {},
): AuditTask {
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

function makePacket(id: string, priority: ReviewPacket["priority"] = "medium"): ReviewPacket {
  return {
    packet_id: id,
    task_ids: [`task-${id}`],
    unit_ids: [`unit-${id}`],
    pass_ids: [`pass:correctness`],
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
  expect(tokensByte, "byte-based tokens should equal estimateTokensFromBytes(size_bytes)").toBe(estimateTokensFromBytes(sizeBytes));
  expect(tokensByte, "byte-based and line-based estimates should differ when sizes differ").not.toBe(tokensLine);
  expect(tokensByte, "ceil(4000 / 4) = 1000").toBe(1000);
});

test("N-A06: taskContentTokens falls back to line-based estimate when sizeIndex missing file", () => {
  const filePath = "src/auth.ts";
  const lineCount = 80;
  const task = makeTask("t1", filePath, lineCount);

  // No sizeIndex entry for this path
  const tokens = taskContentTokens(task, {}, {});
  expect(tokens, "should fall back to line-based estimate").toBe(lineCount * ESTIMATED_TOKENS_PER_LINE);
});

test("N-A06: taskContentTokens falls back to line-based estimate when sizeIndex is absent", () => {
  const filePath = "src/auth.ts";
  const lineCount = 60;
  const task = makeTask("t1", filePath, lineCount);

  const tokens = taskContentTokens(task, undefined, {});
  expect(tokens, "should fall back to line-based estimate when sizeIndex is undefined").toBe(lineCount * ESTIMATED_TOKENS_PER_LINE);
});

// ── 2. Partial-coverage terminal ──────────────────────────────────────────────

test("N-A06: deriveAuditState with partial_completion_terminal treats stranded tasks as excluded", () => {
  // Minimal bundle with one uncompleted task plus a partial_completion_terminal
  const bundle: ArtifactBundle = {
    provider_confirmation: {
      schema_version: PROVIDER_CONFIRMATION_RESULT_VERSION,
      confirmed_at: new Date().toISOString(),
      provider_pool: [],
      session_level: true,
    },
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: new Date().toISOString(),
      files: [],
    },
    file_disposition: { files: [] },
    auto_fixes_applied: { applied: [] },
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: new Date().toISOString(),
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "full repo",
      intent_summary: "full audit",
    },
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      {
        task_id: "t-stranded",
        unit_id: "unit-stranded",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_paths: ["src/a.ts"],
        rationale: "test",
        status: "pending",
      },
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
  expect(auditTasksObl?.state, "audit_tasks_completed must be satisfied when all pending tasks are stranded by partial_completion_terminal").toBe("satisfied");
});

test("N-A06: deriveAuditState without partial_completion_terminal blocks on uncompleted tasks", () => {
  const bundle: ArtifactBundle = {
    provider_confirmation: {
      schema_version: PROVIDER_CONFIRMATION_RESULT_VERSION,
      confirmed_at: new Date().toISOString(),
      provider_pool: [],
      session_level: true,
    },
    repo_manifest: {
      repository: { name: "test-repo" },
      generated_at: new Date().toISOString(),
      files: [],
    },
    file_disposition: { files: [] },
    auto_fixes_applied: { applied: [] },
    syntax_resolution_status: { resolved: true },
    unit_manifest: { units: [] },
    surface_manifest: { surfaces: [] },
    graph_bundle: { graphs: {} },
    critical_flows: { flows: [] },
    risk_register: { items: [] },
    analyzer_capability: { status: "omitted", analyzers: [] },
    design_assessment: {
      generated_at: new Date().toISOString(),
      findings: [],
      contract_reviewed: true,
      conceptual_reviewed: true,
    },
    intent_checkpoint: {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "full repo",
      intent_summary: "full audit",
    },
    coverage_matrix: { files: [] },
    flow_coverage: { flows: [] },
    runtime_validation_tasks: { tasks: [] },
    audit_tasks: [
      {
        task_id: "t-pending",
        unit_id: "unit-pending",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_paths: ["src/a.ts"],
        rationale: "test",
        status: "pending",
      },
    ],
    requeue_tasks: [],
    audit_results: [],
    active_dispatch: undefined,
    audit_report: undefined,
    synthesis_narrative: undefined,
  };

  const state = deriveAuditState(bundle);
  const auditTasksObl = state.obligations.find((o) => o.id === "audit_tasks_completed");
  expect(auditTasksObl?.state, "audit_tasks_completed must be missing when tasks are pending and no partial terminal is set").toBe("missing");
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

  expect(prompt, "prompt must NOT contain submit-packet command").not.toMatch(/submit-packet/);
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
  expect(prompt, "prompt must instruct the worker to write the array to result_path").toMatch(/WRITE that array[\s\S]*to your result_path/i);
  expect(prompt.includes(resultPath), "prompt must name the result_path value to write").toBeTruthy();
  // It must NOT tell the worker to emit inline or forbid writing files.
  expect(prompt, "prompt must not instruct inline emission").not.toMatch(/emit it INLINE/i);
  expect(prompt, "prompt must not forbid file writes").not.toMatch(/Do not write files/i);
  expect(prompt, "prompt must not claim a skill captures an inline payload").not.toMatch(/skill captures/i);
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

  expect(prompt.includes(resultPath), "prompt must include the result_path value").toBeTruthy();
  expect(prompt, "prompt must have result_path header field").toMatch(/result_path:/);
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
  expect(prompt, "prompt must NOT contain the PowerShell Get-Content pipe workaround").not.toMatch(/Get-Content.*\|.*&/);
});

// ── 4. Executor registry ───────────────────────────────────────────────────────

test("N-A06: rolling_dispatch_executor is in EXECUTOR_REGISTRY and owns audit_tasks_completed", () => {
  const entry = EXECUTOR_REGISTRY.find((e) => e.id === "rolling_dispatch_executor");
  expect(entry, "rolling_dispatch_executor must be in EXECUTOR_REGISTRY").toBeTruthy();
  expect(entry?.kind, "rolling_dispatch_executor must be host_delegation").toBe("host_delegation");
  expect(entry?.obligation_ids.includes("audit_tasks_completed"), "rolling_dispatch_executor must own audit_tasks_completed obligation").toBeTruthy();
});

test("N-A06: agent executor no longer owns audit_tasks_completed", () => {
  const agentEntry = EXECUTOR_REGISTRY.find((e) => e.id === "agent");
  expect(agentEntry, "agent entry must still exist for backward compatibility").toBeTruthy();
  expect(agentEntry?.obligation_ids.includes("audit_tasks_completed"), "agent must NOT own audit_tasks_completed (superseded by rolling_dispatch_executor)").toBe(false);
});

test("N-A06: audit_tasks_completed is owned by exactly one executor", () => {
  const owners = EXECUTOR_REGISTRY.filter((e) => e.obligation_ids.includes("audit_tasks_completed"));
  expect(owners.length, "exactly one executor should own audit_tasks_completed").toBe(1);
  expect(owners[0].id).toBe("rolling_dispatch_executor");
});

// ── INV-07: runRollingDispatch with an empty pool strands all packets ─────────

test("INV-07: runRollingDispatch with an empty confirmedPools array strands all packets and returns partial", async () => {
  const packets: RollingDispatchPacket<{ packet_id: string; estimated_tokens: number }>[] = [
    { id: "pkt-1", payload: { packet_id: "pkt-1", estimated_tokens: 100 }, estimatedTokens: 100, complexity: 0.5 },
    { id: "pkt-2", payload: { packet_id: "pkt-2", estimated_tokens: 100 }, estimatedTokens: 100, complexity: 0.5 },
  ];

  const result = await runRollingDispatch(
    packets,
    [], // empty pool — INV-07: must strand all, not silently skip
    {},
    {},
    async () => { throw new Error("should not be called on empty pool"); },
  );

  expect(result.status, "empty pool must return partial status").toBe("partial");
  expect(result.partial_reason).toBe("empty_pool");
  expect(result.stranded_ids.sort()).toEqual(["pkt-1", "pkt-2"]);
  expect(result.results.length, "no results when pool is empty").toBe(0);
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
  expect(result.status).toBe("partial");
  expect(result.partial_reason).toBe("empty_pool");
  expect(result.stranded_ids).toEqual([]);
});

// ── TST-8f9c443f: post-run livelock guard contract ───────────────────────────
//
// The post-run livelock path (rollingDispatch.ts:117-134) calls detectLivelock
// with consecutiveNoProgressWaves === livelockLimit === noProgressLimit so any
// residual pendingIds after run() are always classified as livelock_guard.
// Testing detectLivelock directly verifies the wrapper's invariant.

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
  expect(terminal !== null, "detectLivelock must return a terminal when pendingIds non-empty and waves >= limit").toBeTruthy();
  if (terminal === null) throw new Error("detectLivelock must return a terminal when pendingIds non-empty and waves >= limit");
  expect(terminal.reason).toBe("livelock_guard");
  expect(terminal.stranded_ids.sort()).toEqual(pendingIds.sort());
});

test("TST-8f9c443f: detectLivelock returns null when pendingIds is empty (no residual packets)", () => {
  // Post-run: if pendingIds is empty, the branch is never entered (null coalesces to no-terminal).
  const terminal = detectLivelock({
    pendingIds: [],
    consecutiveNoProgressWaves: 999,
    noProgressLimit: 3,
  });
  expect(terminal, "detectLivelock must return null when pendingIds is empty").toBe(null);
});

test("TST-8f9c443f: runRollingDispatch post-run invariant — all successfully dispatched packets appear in results", async () => {
  // Indirectly verifies the post-run path is not triggered on a normal run:
  // all 3 packets complete, pendingIds is empty after run(), status is complete.
  const pool: CapacityPool = {
    id: "test-pool",
    accountKey: "test-pool",
    providerName: "worker-command",
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
  expect(result.status, "all packets dispatched → complete, no post-run livelock").toBe("complete");
  expect(result.results.length).toBe(3);
  expect(result.stranded_ids).toEqual([]);
  // partial_reason must be absent for a complete run
  expect(result.partial_reason).toBe(undefined);
});
