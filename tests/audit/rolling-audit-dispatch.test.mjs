/**
 * A8(a): in-process, provider-backed rolling audit dispatch.
 *
 * Coverage:
 * 1. makeAuditProviderPacketDispatcher launches the provider read-only against the
 *    real repo root (NO worktree), with the packet prompt + result path; returns
 *    success when the worker wrote a result, error when rejected / no result.
 * 2. driveRollingAuditDispatch happy path: drives every packet through the injected
 *    dispatcher and folds the results in via the deterministic merge.
 * 3. driveRollingAuditDispatch strand path: a pool-exhausting dispatcher strands the
 *    packets and the partial-completion terminal lands on the active-dispatch
 *    artifact so the pipeline can proceed to synthesis on partial coverage.
 */

import { test, onTestFinished, expect } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const {
  makeAuditProviderPacketDispatcher,
  driveRollingAuditDispatch,
  resolveAuditRollingEngineEnabled,
} = await import("../../src/audit/cli/rollingAuditDispatch.ts");
const { ACTIVE_DISPATCH_FILENAME } = await import("../../src/audit/cli/dispatch.ts");
const { primaryInProcessSource } = await import("../../src/shared/quota/apiPool.ts");

// ── 0. Routing policy ─────────────────────────────────────────────────────────
// H2+H4 collapse: the old `resolvesToInProcessDispatchProvider` branch predicate is
// gone — engine-vs-host routing is POOL-SET MEMBERSHIP. Audit's draw policy (which
// primaries fold into the eligible set as source pools) is pinned here through the
// unconditional primary fold with audit's default options (no command workers).

test("A8a: audit's fold policy — only explicit programmatic backends become source pools", () => {
  const cfg = {
    codex: { command: "codex" },
    opencode: { command: "opencode" },
    openai_compatible: { base_url: "http://nim/v1", model: "m" },
    agy: { command: "agy" },
    subprocess_template: { command_template: ["run"] },
  };
  expect(primaryInProcessSource(cfg, "openai-compatible")?.provider).toBe("openai-compatible");
  expect(primaryInProcessSource(cfg, "codex")?.provider).toBe("codex");
  expect(primaryInProcessSource(cfg, "opencode")?.provider).toBe("opencode");
  expect(primaryInProcessSource(cfg, "agy")?.provider).toBe("agy");
  // The conversation host + IDE backends never fold (they are never engine pools).
  expect(primaryInProcessSource(cfg, "claude-code")).toBe(null);
  expect(primaryInProcessSource(cfg, "vscode-task")).toBe(null);
  expect(primaryInProcessSource(cfg, "antigravity")).toBe(null);
  // worker-command / subprocess-template are NOT in-process for audit: they need a
  // per-worker command a read-only review packet lacks, and worker-command is the
  // conventional host-dispatch default (routing it in-process would hijack the
  // host-subagent dispatch_review path). (Remediate's draw opts in via
  // `commandWorkers: true` — a policy argument, not an audit fork.)
  expect(primaryInProcessSource(cfg, "worker-command")).toBe(null);
  expect(primaryInProcessSource(cfg, "subprocess-template")).toBe(null);
});

test("A8a: resolveAuditRollingEngineEnabled resolution order — explicit > session > env > default true", () => {
  expect(resolveAuditRollingEngineEnabled({ rollingEngine: false, sessionConfig: { dispatch: { rolling_engine: true } } })).toBe(false);
  expect(resolveAuditRollingEngineEnabled({ sessionConfig: { dispatch: { rolling_engine: false } } })).toBe(false);
  expect(resolveAuditRollingEngineEnabled({ sessionConfig: { dispatch: { rolling_engine: true } } })).toBe(true);
  expect(resolveAuditRollingEngineEnabled({ env: { AUDIT_CODE_ROLLING_ENGINE: "false" } })).toBe(false);
  expect(resolveAuditRollingEngineEnabled({ env: { AUDIT_CODE_ROLLING_ENGINE: "true" } })).toBe(true);
  expect(resolveAuditRollingEngineEnabled({ env: {} })).toBe(true);
});

const RUN_ID = "rolling-audit-run";

function tasks() {
  const dirs = ["mod_a", "mod_b", "mod_c"];
  const lenses = ["security", "correctness", "maintainability"];
  const priorities = ["high", "medium", "low"];
  return ["a", "b", "c"].map((id, i) => ({
    task_id: `t-${id}`,
    unit_id: `unit-${id}`,
    pass_id: `pass:${lenses[i]}`,
    lens: lenses[i],
    file_paths: [`src/${dirs[i]}/${id}.ts`],
    file_line_counts: { [`src/${dirs[i]}/${id}.ts`]: 120 },
    rationale: `review ${id}`,
    priority: priorities[i],
  }));
}

async function makeRun(taskListOverride) {
  const artifactsDir = await mkdtemp(join(tmpdir(), "rolling-audit-"));
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  const taskList = taskListOverride ?? tasks();
  await writeFile(
    join(runDir, "pending-audit-tasks.json"),
    JSON.stringify(taskList),
    "utf8",
  );
  // mergeAndIngest reads runs/<id>/task.json for repo_root + obligation_id.
  await writeFile(
    join(runDir, "task.json"),
    JSON.stringify({
      contract_version: "audit-code-worker/v1alpha1",
      run_id: RUN_ID,
      repo_root: artifactsDir,
      artifacts_dir: artifactsDir,
      obligation_id: "audit_tasks_completed",
      preferred_executor: "agent",
      result_path: join(runDir, "worker-result.json"),
      worker_command: [],
      audit_results_path: join(runDir, "run-results.json"),
      pending_audit_tasks_path: join(runDir, "pending-audit-tasks.json"),
    }),
    "utf8",
  );
  return { artifactsDir, runDir, taskList };
}

function activeReviewRun(artifactsDir, runDir) {
  return {
    run_id: RUN_ID,
    task_path: join(runDir, "task.json"),
    prompt_path: join(runDir, "prompt.md"),
    pending_audit_tasks_path: join(runDir, "pending-audit-tasks.json"),
    audit_results_path: join(runDir, "run-results.json"),
    worker_command: [],
  };
}

// A worker simulator: read the dispatch-result-map to learn which task_ids belong
// to a packet, then write a valid AuditResult[] to the packet's result path.
function makeWritingDispatcher(runDir, taskList) {
  const tasksById = new Map(taskList.map((t) => [t.task_id, t]));
  return async (packet, _slot) => {
    const entry = packet.payload;
    const resultMap = JSON.parse(
      await readFile(join(runDir, "dispatch-result-map.json"), "utf8"),
    );
    const taskIds = resultMap.entries
      .filter((e) => e.packet_id === packet.id)
      .map((e) => e.task_id);
    const results = taskIds.map((tid) => {
      const t = tasksById.get(tid);
      return {
        task_id: t.task_id,
        unit_id: t.unit_id,
        pass_id: t.pass_id,
        lens: t.lens,
        file_coverage: t.file_paths.map((p) => ({
          path: p,
          total_lines: t.file_line_counts[p] ?? 1,
        })),
        findings: [],
      };
    });
    await writeFile(entry.result_path, JSON.stringify(results), "utf8");
    return { packet, outcome: "success" };
  };
}

// ── 1. makeAuditProviderPacketDispatcher ──────────────────────────────────────

test("A8a: makeAuditProviderPacketDispatcher launches read-only against the repo root and returns success when the worker wrote a result", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const resultPath = join(runDir, "task-results", "pkt-1-inline-result.json");
  await mkdir(join(runDir, "task-results"), { recursive: true });
  const captured = [];
  const fakeProvider = {
    name: "fake-provider",
    async launch(input) {
      captured.push(input);
      await writeFile(input.resultPath, JSON.stringify([]), "utf8");
      return { accepted: true };
    },
  };

  const dispatcher = makeAuditProviderPacketDispatcher({
    root: artifactsDir,
    artifactsDir,
    runId: RUN_ID,
    sessionConfig: { provider: "openai-compatible" },
    timeoutMs: 1000,
    createProvider: () => fakeProvider,
  });

  const packet = {
    id: "pkt-1",
    payload: {
      packet_id: "pkt-1",
      prompt_path: join(runDir, "task-results", "pkt-1-prompt.md"),
      result_path: resultPath,
      access: { read_paths: [], write_paths: [], forbidden_patterns: [] },
      complexity: { estimated_tokens: 100, priority: "medium" },
    },
    estimatedTokens: 100,
    complexity: 0.5,
  };

  const outcome = await dispatcher(packet, { providerName: "openai-compatible", hostModel: null, poolId: "p" });
  expect(outcome.outcome).toBe("success");
  expect(captured.length).toBe(1);
  expect(captured[0].repoRoot, "must launch read-only against the real repo root (no worktree)").toBe(artifactsDir);
  expect(captured[0].promptPath).toBe(packet.payload.prompt_path);
  expect(captured[0].resultPath).toBe(resultPath);
  expect(captured[0].uiMode).toBe("headless");
});

test("A8a: makeAuditProviderPacketDispatcher relays the provider's observedCostUsd onto the dispatch result", async (t) => {
  // Reactive cost verification seam: the provider surfaces the endpoint-reported
  // cost on LaunchFreshSessionResult; the dispatcher closure must carry it onto the
  // RollingDispatchResult so handleResult can demote a declared-free pool that
  // started charging. Guards the exact relay that was initially missing.
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await mkdir(join(runDir, "task-results"), { recursive: true });

  const dispatcher = makeAuditProviderPacketDispatcher({
    root: artifactsDir,
    artifactsDir,
    runId: RUN_ID,
    sessionConfig: { provider: "openai-compatible" },
    timeoutMs: 1000,
    createProvider: () => ({
      name: "fake",
      async launch(input) {
        await writeFile(input.resultPath, JSON.stringify([]), "utf8");
        return { accepted: true, observedCostUsd: 0.02 };
      },
    }),
  });

  const packet = {
    id: "pkt-cost",
    payload: {
      packet_id: "pkt-cost",
      prompt_path: join(runDir, "task-results", "pkt-cost-prompt.md"),
      result_path: join(runDir, "task-results", "pkt-cost-result.json"),
      access: { read_paths: [], write_paths: [], forbidden_patterns: [] },
      complexity: { estimated_tokens: 100, priority: "medium" },
    },
    estimatedTokens: 100,
    complexity: 0.5,
  };
  const outcome = await dispatcher(packet, { providerName: "openai-compatible", hostModel: null, poolId: "p" });
  expect(outcome.outcome).toBe("success");
  expect(outcome.observedCostUsd, "the endpoint-reported cost is relayed to the engine").toBe(0.02);
});

test("A8a: makeAuditProviderPacketDispatcher returns error when the provider rejects the launch", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await mkdir(join(runDir, "task-results"), { recursive: true });

  const dispatcher = makeAuditProviderPacketDispatcher({
    root: artifactsDir,
    artifactsDir,
    runId: RUN_ID,
    sessionConfig: { provider: "openai-compatible" },
    timeoutMs: 1000,
    createProvider: () => ({
      name: "fake",
      async launch() {
        return { accepted: false, error: "no api key" };
      },
    }),
  });

  const packet = {
    id: "pkt-1",
    payload: {
      packet_id: "pkt-1",
      prompt_path: join(runDir, "task-results", "pkt-1-prompt.md"),
      result_path: join(runDir, "task-results", "pkt-1-inline-result.json"),
      access: { read_paths: [], write_paths: [], forbidden_patterns: [] },
      complexity: { estimated_tokens: 100, priority: "medium" },
    },
    estimatedTokens: 100,
    complexity: 0.5,
  };
  const outcome = await dispatcher(packet, { providerName: "openai-compatible", hostModel: null, poolId: "p" });
  expect(outcome.outcome).toBe("error");
  expect(String(outcome.error)).toMatch(/no api key/);
});

test("A8a: makeAuditProviderPacketDispatcher returns error when the worker wrote no result file", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await mkdir(join(runDir, "task-results"), { recursive: true });

  const dispatcher = makeAuditProviderPacketDispatcher({
    root: artifactsDir,
    artifactsDir,
    runId: RUN_ID,
    sessionConfig: { provider: "openai-compatible" },
    timeoutMs: 1000,
    createProvider: () => ({
      name: "fake",
      async launch() {
        return { accepted: true }; // accepted but wrote nothing
      },
    }),
  });

  const packet = {
    id: "pkt-1",
    payload: {
      packet_id: "pkt-1",
      prompt_path: join(runDir, "task-results", "pkt-1-prompt.md"),
      result_path: join(runDir, "task-results", "pkt-1-missing.json"),
      access: { read_paths: [], write_paths: [], forbidden_patterns: [] },
      complexity: { estimated_tokens: 100, priority: "medium" },
    },
    estimatedTokens: 100,
    complexity: 0.5,
  };
  const outcome = await dispatcher(packet, { providerName: "openai-compatible", hostModel: null, poolId: "p" });
  expect(outcome.outcome).toBe("error");
  expect(String(outcome.error)).toMatch(/wrote no result/);
});

// ── 2. driveRollingAuditDispatch happy path ───────────────────────────────────

test("A8a: driveRollingAuditDispatch drives every packet, writes results, and folds them in via the terminal ingestor", async (t) => {
  const { artifactsDir, runDir, taskList } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // The deterministic ingestion is exercised in full by merge-and-ingest /
  // result-ingestion tests; here we inject a stub to assert the driver hands it
  // the right run and that every packet's worker actually wrote a result file.
  let ingestCalls = 0;
  const ingestStub = async ({ runId }) => {
    ingestCalls++;
    // Confirm each packet's result file landed before ingestion runs. The worker
    // writes the AuditResult[] array to the packet's plan result_path.
    const plan = JSON.parse(
      await readFile(join(runDir, "dispatch-plan.json"), "utf8"),
    );
    for (const entry of plan) {
      const arr = JSON.parse(await readFile(entry.result_path, "utf8"));
      expect(Array.isArray(arr) && arr.length > 0, `worker wrote results to ${entry.result_path}`).toBeTruthy();
    }
    return { summary: { run_id: runId, accepted_count: 3 }, has_failures: false };
  };

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(artifactsDir, runDir),
    sessionConfig: { provider: "openai-compatible" },
    timeoutMs: 1000,
    dispatchPacket: makeWritingDispatcher(runDir, taskList),
    ingest: ingestStub,
  });

  expect(result.status).toBe("complete");
  expect(result.packet_count, "three distinct units → three packets").toBe(3);
  expect(result.stranded_ids.length).toBe(0);
  expect(ingestCalls, "ingestion runs exactly once after dispatch").toBe(1);
  expect(result.ingest.summary.accepted_count).toBe(3);
});

// ── 3. driveRollingAuditDispatch strand path ──────────────────────────────────

test("A8a: driveRollingAuditDispatch pauses resumably (waiting_for_provider) when packets strand (DC-4)", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // A dispatcher that always rate-limits exhausts the single host pool, so the
  // rolling engine strands every packet (INV-QD-07). Per DC-4, a full strand now
  // PAUSES to a resumable `waiting_for_provider` state instead of immediately
  // stamping a partial-completion terminal — the terminal is reached only after the
  // livelock pause limit. (Covered in detail in dc4.test.mjs.)
  const stranding = async (packet) => ({ packet, outcome: "rate_limited" });
  const ingestStub = async () => {
    throw new Error("ingestion must be skipped on a full strand");
  };

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(artifactsDir, runDir),
    sessionConfig: { provider: "openai-compatible", quota: {} },
    timeoutMs: 1000,
    dispatchPacket: stranding,
    ingest: ingestStub,
  });

  expect(result.status, "a full strand pauses resumably, not terminal").toBe("paused");
  expect(result.stranded_ids.length > 0, "packets stranded on an exhausted pool").toBeTruthy();
  expect(result.ingest, "no ingestion on a full strand").toBe(null);
  expect(result.paused_state, "a resumable paused state is surfaced").toBeTruthy();

  const activeDispatch = JSON.parse(
    await readFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), "utf8"),
  );
  expect(activeDispatch.paused_state, "the resumable paused state must be persisted onto the active-dispatch artifact").toBeTruthy();
  expect(!activeDispatch.partial_completion_terminal, "a first strand is a resumable pause, NOT yet a partial-completion terminal").toBeTruthy();

  // Unified-routing step D: the drive result surfaces the engine's PER-POOL terminal
  // exclusion set so the hybrid caller settles exactly those pools — never "any
  // non-complete drive ⇒ settle every source pool" (the 2026-07-17 frontier collapse).
  expect(Array.isArray(result.exhausted_pool_ids), "exhausted_pool_ids must ride the drive result").toBe(true);
  expect(result.exhausted_pool_ids.length > 0, "the rate-limit-exhausted pool is named in exhausted_pool_ids").toBeTruthy();
});

// ── 4. Regressions found by the live NIM e2e ──────────────────────────────────

test("A8a: a packet id containing ':' does not crash the dispatcher (Windows-safe sidecar names)", async (t) => {
  // Real audit packet ids embed ':' (e.g. "flow:flow:surface:src-api-auth-ts:security").
  // The dispatcher used to build sidecar paths (`${packet.id}.task.json`) verbatim,
  // which is an invalid filename on Windows (NTFS reads ':' as an ADS separator) —
  // the write threw before launch, erroring EVERY packet. The sidecars must use the
  // canonical FS-safe stem instead.
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await mkdir(join(runDir, "task-results"), { recursive: true });

  const colonId = "flow:flow:surface:src-api-auth-ts:security-correctness:packet-1-58b5a59ccd";
  const captured = [];
  const dispatcher = makeAuditProviderPacketDispatcher({
    root: artifactsDir,
    artifactsDir,
    runId: RUN_ID,
    sessionConfig: { provider: "openai-compatible" },
    timeoutMs: 1000,
    createProvider: () => ({
      name: "fake",
      async launch(input) {
        captured.push(input);
        await writeFile(input.resultPath, JSON.stringify([]), "utf8");
        return { accepted: true };
      },
    }),
  });

  const packet = {
    id: colonId,
    payload: {
      packet_id: colonId,
      prompt_path: join(runDir, "task-results", "pkt.prompt.md"),
      result_path: join(runDir, "task-results", "pkt.inline-result.json"),
      access: { read_paths: [], write_paths: [], forbidden_patterns: [] },
      complexity: { estimated_tokens: 100, priority: "medium" },
    },
    estimatedTokens: 100,
    complexity: 0.5,
  };

  const outcome = await dispatcher(packet, { providerName: "openai-compatible", hostModel: null, poolId: "p" });
  expect(outcome.outcome, "must not error on a colon-bearing packet id").toBe("success");
  expect(captured.length, "the worker must actually launch (the sidecar write must not throw)").toBe(1);
  // Every sidecar filename the dispatcher derives must be free of ':' (FS-safe).
  for (const key of ["stdoutPath", "stderrPath"]) {
    expect(!basename(captured[0][key]).includes(":"), `${key} basename must be colon-free, got ${basename(captured[0][key])}`).toBeTruthy();
  }
});

// ── 5. Quota-escalation parity with remediate ─────────────────────────────────

test("A8a: a same-packet account wall escalates through the retained host-session source and captures a quota_escalation friction (parity with remediate)", async (t) => {
  // Parity coverage for the audit-side quota escalation feed. The shared engine +
  // HostSessionQuotaSource escalation is unit-tested in tests/shared; this pins the
  // AUDIT glue: the retained host-session source built for the dispatch is fed by
  // makeAuditProviderPacketDispatcher's rate_limited evidence via recordRateLimit,
  // isPacketEscalated strands the packet once the bound is crossed, and the driver's
  // onEscalation routes a `quota_escalation` fact to the friction chokepoint.
  const { artifactsDir, runDir } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // A single task → a single packet, so the same packet re-limits across every pool
  // (the escalation tracker is per-packet; interleaved packets would reset it).
  const oneTask = tasks().slice(0, 1);

  // Four pools that ALL rate-limit the packet with a parseable host-session-limit
  // string. Default bound is 3 consecutive same-packet re-limits, so the 4th pool's
  // re-limit (count 4 > 3) escalates — before pool exhaustion would strand it.
  const pools = ["pa", "pb", "pc", "pd"].map((id) => ({
    id,
    accountKey: id,
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
  }));

  const LIMIT_TEXT = "session limit reached. Resets in 1h";
  const attemptedPools = new Set();
  const stranding = async (packet, slot) => {
    attemptedPools.add(slot?.poolId);
    return { packet, outcome: "rate_limited", rateLimit: { channel: "error", text: LIMIT_TEXT } };
  };

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(artifactsDir, runDir),
    sessionConfig: { provider: "openai-compatible", quota: {} },
    timeoutMs: 1000,
    tasksOverride: oneTask,
    poolsOverride: pools,
    dispatchPacket: stranding,
    ingest: async () => {
      throw new Error("ingestion must be skipped on a full strand");
    },
  });

  // The packet stranded (escalation guard, not clean completion) → no ingest.
  expect(result.stranded_ids.length > 0, "escalated packet strands").toBeTruthy();
  expect(result.ingest, "no ingestion on a full strand").toBe(null);
  // Early strand: escalation fired on the 4th re-limit, so all four pools were
  // attempted but the strand is the escalation guard, not exhaustion of a 5th pool.
  expect(attemptedPools.size, "same packet re-limited across all four pools").toBe(4);

  // The audit driver routed the escalation to the friction chokepoint.
  const friction = JSON.parse(
    await readFile(join(artifactsDir, "friction", `${RUN_ID}.json`), "utf8"),
  );
  const escalation = friction.frictions.find((f) => f.id.startsWith("quota_escalation:"));
  expect(escalation, "a quota_escalation friction is captured for the audit run").toBeTruthy();
  expect(escalation.severity).toBe("high");
});

test("A8a: driveRollingAuditDispatch degrades to no-progress (does not crash) when every accepted result is ingestion-invalid", async (t) => {
  // A packet `outcome:"success"` only means the provider wrote a result file. When
  // every provider-accepted result is contract-invalid, mergeAndIngest raises a hard
  // "all assigned results invalid" block. In the rolling driver that throw must be
  // absorbed into a no-progress pass (ingest:null) so the fold blocks cleanly instead
  // of crashing next-step (robustness to any-strength provider).
  const { artifactsDir, runDir, taskList } = await makeRun();
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Workers "succeed" (write a result file) but ingestion is stubbed to throw the
  // same all-invalid error mergeAndIngest raises.
  const throwingIngest = async () => {
    throw new Error("All 4 assigned task result(s) were missing or invalid; blocked before ingestion.");
  };

  let result;
  await assert.doesNotReject(async () => {
    result = await driveRollingAuditDispatch({
      root: artifactsDir,
      artifactsDir,
      activeReviewRun: activeReviewRun(artifactsDir, runDir),
      sessionConfig: { provider: "openai-compatible" },
      timeoutMs: 1000,
      dispatchPacket: makeWritingDispatcher(runDir, taskList),
      ingest: throwingIngest,
    });
  }, "an all-invalid ingestion must not propagate out of the driver");

  expect(result.ingest, "no usable ingest result is recorded (no-progress pass)").toBe(null);
  expect(result.packet_count, "the packets were still dispatched").toBe(3);
});


// ── 6. F4: capability floor enforced by the ENGINE on the audit draw ──────────

test("F4: driveRollingAuditDispatch never dispatches a floor-carrying packet to an incapable pool", async (t) => {
  // A single security-lens, LOW-priority task: the sensitive-lens escalator lifts
  // its model_hint to "standard" (a real floor) while the low priority maps the
  // engine packet to complexity 0 — so pre-F4 the engine's preference order
  // (low complexity → least-capable pool first) selected exactly the bottom-band
  // pool the floor must exclude. Red on that HEAD semantics: the assertion is on
  // DISPATCH (which pool the worker launched on), not on a contract file.
  const securityTask = [
    {
      task_id: "t-sec",
      unit_id: "unit-sec",
      pass_id: "pass:security",
      lens: "security",
      file_paths: ["src/mod_sec/sec.ts"],
      file_line_counts: { "src/mod_sec/sec.ts": 120 },
      rationale: "review sec",
      priority: "low",
    },
  ];
  const { artifactsDir, runDir, taskList } = await makeRun(securityTask);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const poolBase = {
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
  };
  const capablePool = { ...poolBase, id: "src-deep", accountKey: "src-deep", rank: "deep" };
  const incapablePool = { ...poolBase, id: "src-small", accountKey: "src-small", rank: "small" };

  const writing = makeWritingDispatcher(runDir, taskList);
  const seen = [];
  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(artifactsDir, runDir),
    sessionConfig: { provider: "openai-compatible", quota: {} },
    timeoutMs: 1000,
    poolsOverride: [capablePool, incapablePool],
    dispatchPacket: async (packet, slot) => {
      seen.push(slot.poolId);
      return writing(packet, slot);
    },
    ingest: async ({ runId }) => ({ summary: { run_id: runId, accepted_count: 1 }, has_failures: false }),
  });

  expect(result.status).toBe("complete");
  expect(seen.length > 0, "the packet must actually dispatch").toBeTruthy();
  expect(seen.every((id) => id === "src-deep"), `dispatched pools were ${seen.join(", ")} — a standard-floor packet must never land on the bottom-band pool`).toBeTruthy();
});
