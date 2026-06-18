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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  makeAuditProviderPacketDispatcher,
  driveRollingAuditDispatch,
} = await import("../src/cli/rollingAuditDispatch.ts");
const { ACTIVE_DISPATCH_FILENAME } = await import("../src/cli/dispatch.ts");

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

async function makeRun() {
  const artifactsDir = await mkdtemp(join(tmpdir(), "rolling-audit-"));
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  const taskList = tasks();
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
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

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
  assert.equal(outcome.outcome, "success");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].repoRoot, artifactsDir, "must launch read-only against the real repo root (no worktree)");
  assert.equal(captured[0].promptPath, packet.payload.prompt_path);
  assert.equal(captured[0].resultPath, resultPath);
  assert.equal(captured[0].uiMode, "headless");
});

test("A8a: makeAuditProviderPacketDispatcher returns error when the provider rejects the launch", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
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
  assert.equal(outcome.outcome, "error");
  assert.match(String(outcome.error), /no api key/);
});

test("A8a: makeAuditProviderPacketDispatcher returns error when the worker wrote no result file", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
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
  assert.equal(outcome.outcome, "error");
  assert.match(String(outcome.error), /wrote no result/);
});

// ── 2. driveRollingAuditDispatch happy path ───────────────────────────────────

test("A8a: driveRollingAuditDispatch drives every packet, writes results, and folds them in via the terminal ingestor", async (t) => {
  const { artifactsDir, runDir, taskList } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

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
      assert.ok(
        Array.isArray(arr) && arr.length > 0,
        `worker wrote results to ${entry.result_path}`,
      );
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

  assert.equal(result.status, "complete");
  assert.equal(result.packet_count, 3, "three distinct units → three packets");
  assert.equal(result.stranded_ids.length, 0);
  assert.equal(ingestCalls, 1, "ingestion runs exactly once after dispatch");
  assert.equal(result.ingest.summary.accepted_count, 3);
});

// ── 3. driveRollingAuditDispatch strand path ──────────────────────────────────

test("A8a: driveRollingAuditDispatch records a partial-completion terminal when packets strand", async (t) => {
  const { artifactsDir, runDir } = await makeRun();
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // A dispatcher that always rate-limits exhausts the single host pool, so the
  // rolling engine strands every packet (INV-QD-07 empty-pool terminal).
  const stranding = async (packet) => ({ packet, outcome: "rate_limited" });
  const ingestStub = async () => {
    throw new Error("ingestion must be skipped on a full strand");
  };

  const result = await driveRollingAuditDispatch({
    root: artifactsDir,
    artifactsDir,
    activeReviewRun: activeReviewRun(artifactsDir, runDir),
    sessionConfig: { provider: "openai-compatible", quota: { enabled: false } },
    timeoutMs: 1000,
    dispatchPacket: stranding,
    ingest: ingestStub,
  });

  assert.equal(result.status, "partial");
  assert.ok(result.stranded_ids.length > 0, "packets stranded on an exhausted pool");
  assert.equal(result.ingest, null, "no ingestion on a full strand");

  const activeDispatch = JSON.parse(
    await readFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), "utf8"),
  );
  assert.ok(
    activeDispatch.partial_completion_terminal,
    "partial-completion terminal must be stamped onto the active-dispatch artifact",
  );
  assert.deepEqual(
    activeDispatch.partial_completion_terminal.stranded_ids.sort(),
    result.stranded_ids.sort(),
  );
});
