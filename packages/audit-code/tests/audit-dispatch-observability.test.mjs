/**
 * Regression tests for audit-dispatch observability findings:
 *   FND-OBS-c8d43100 — selectiveDeepening/index.ts strategy logging
 *   FND-OBS-99e3a861 — rollingDispatch.ts packet_result progress events
 *   FND-OBS-48c05a13 — mergeAndIngestCommand notDispatched task IDs logging
 *   FND-OBS-bf5c7331 — merge-results.mjs structured JSON summary
 *   FND-OBS-6e84f23c — dispatchStatusCommand run log entry
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ── Shared helpers ────────────────────────────────────────────────────────────

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-dispatch-obs-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}


/** Capture stderr writes during an async body. */
async function withCapturedStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    return await fn(lines);
  } finally {
    process.stderr.write = original;
  }
}

// ── FND-OBS-c8d43100: selectiveDeepening strategy_summary event ──────────────

const { buildSelectiveDeepeningTasks } = await import(
  "../src/orchestrator/selectiveDeepening/index.ts"
);
const { DEEPENING_TAG } = await import(
  "../src/orchestrator/selectiveDeepening/shared.ts"
);

function makeResult(taskId, lens = "correctness", overrides = {}) {
  return {
    task_id: taskId,
    unit_id: `unit:${taskId}`,
    pass_id: `pass:${lens}`,
    lens,
    findings: [],
    file_coverage: [{ path: `src/${taskId}.ts`, total_lines: 10 }],
    ...overrides,
  };
}

function makeTask(taskId, lens = "correctness", filePaths, overrides = {}) {
  return {
    task_id: taskId,
    unit_id: `unit:${taskId}`,
    pass_id: `pass:${lens}`,
    lens,
    file_paths: filePaths ?? [`src/${taskId}.ts`],
    rationale: "test",
    priority: "medium",
    status: "complete",
    ...overrides,
  };
}

test("FND-OBS-c8d43100: buildSelectiveDeepeningTasks emits a strategy_summary structured log line to stderr", () => {
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };
  try {
    buildSelectiveDeepeningTasks({
      results: [makeResult("t1")],
      existingTasks: [makeTask("t1")],
      lineIndex: {},
    });
  } finally {
    process.stderr.write = origWrite;
  }

  const summaryLines = stderrLines.filter((l) => {
    try {
      const obj = JSON.parse(l.trim());
      return obj.event === "strategy_summary";
    } catch { return false; }
  });
  assert.equal(summaryLines.length, 1, "expected exactly one strategy_summary log line");
  const parsed = JSON.parse(summaryLines[0].trim());
  assert.equal(parsed.source, "audit-code:selectiveDeepening");
  assert.equal(parsed.level, "info");
  assert.ok(typeof parsed.created === "number", "created is a number");
  assert.ok(typeof parsed.strategy_contributions === "object", "strategy_contributions is an object");
  assert.ok("finding_followup" in parsed.strategy_contributions);
  assert.ok("conflict" in parsed.strategy_contributions);
  assert.ok("steward_followup" in parsed.strategy_contributions);
  assert.ok("runtime_validation" in parsed.strategy_contributions);
  assert.ok("lens_verification" in parsed.strategy_contributions);
  assert.ok("high_risk_clean" in parsed.strategy_contributions);
  assert.ok(typeof parsed.ts === "string" && !isNaN(Date.parse(parsed.ts)), "ts is a valid ISO timestamp");
});

test("buildSelectiveDeepeningTasks is self-bounding: each qualifying finding is deepened at most once (converges, no count cap)", () => {
  const results = [
    makeResult("t1", "correctness", {
      findings: [
        {
          id: "F1",
          severity: "high",
          confidence: "high",
          title: "x",
          category: "c",
          summary: "s",
          affected_files: [{ path: "src/t1.ts" }],
          evidence: [],
        },
      ],
    }),
  ];
  const existingTasks = [makeTask("t1")];

  const first = buildSelectiveDeepeningTasks({ results, existingTasks, lineIndex: {} });
  assert.ok(first.length >= 1, "a high-severity finding produces a deepening task");

  // Feed the created deepening tasks back in as existing tasks; the same results
  // must now produce zero new tasks — the qualifying set is deepened at most once,
  // so the chain converges without any per-batch or total-count limit.
  const second = buildSelectiveDeepeningTasks({
    results,
    existingTasks: [...existingTasks, ...first],
    lineIndex: {},
  });
  assert.equal(second.length, 0, "no new deepening tasks on the second pass — converges");
});

// ── FND-OBS-99e3a861: rollingDispatch packet_result progress events ───────────

const { runRollingDispatch } = await import(
  "../src/orchestrator/rollingDispatch.ts"
);

test("FND-OBS-99e3a861: runRollingDispatch emits packet_result progress events to stderr for each completed packet", async () => {
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

  // CapacityPool with unlimited quota so selectProvider always grants a slot.
  const pool = {
    id: "test-pool",
    providerName: "local-subprocess",
    hostModel: null,
    hostConcurrencyLimit: null,
  };
  const packets = [
    { id: "p1", payload: {}, estimatedTokens: 1, complexity: 0.5 },
    { id: "p2", payload: {}, estimatedTokens: 1, complexity: 0.5 },
  ];
  let dispatchCount = 0;
  try {
    await runRollingDispatch(
      packets,
      [pool],
      {},
      {},
      async (packet) => {
        dispatchCount++;
        return { packet, outcome: "success" };
      },
    );
  } finally {
    process.stderr.write = origWrite;
  }

  assert.equal(dispatchCount, 2, "both packets were dispatched");
  const resultLines = stderrLines.filter((l) => {
    try {
      const obj = JSON.parse(l.trim());
      return obj.event === "packet_result";
    } catch { return false; }
  });
  assert.equal(resultLines.length, 2, "expected one packet_result log line per packet");
  for (const line of resultLines) {
    const parsed = JSON.parse(line.trim());
    assert.equal(parsed.source, "audit-code:rollingDispatch");
    assert.ok(typeof parsed.packet_id === "string", "packet_id present");
    assert.equal(parsed.outcome, "success");
    assert.ok(typeof parsed.completed === "number", "completed count present");
    assert.ok(typeof parsed.total === "number", "total count present");
    assert.ok(typeof parsed.ts === "string", "ts present");
  }
  // completed count should be monotonically increasing
  const counts = resultLines.map((l) => JSON.parse(l.trim()).completed).sort((a, b) => a - b);
  assert.deepEqual(counts, [1, 2]);
});

// ── FND-OBS-48c05a13: mergeAndIngestCommand logs notDispatched task IDs ──────

const { cmdMergeAndIngest } = await import(
  "../src/cli/mergeAndIngestCommand.ts"
);
const { DISPATCH_RESULT_MAP_FILENAME } = await import("../src/cli/dispatch.ts");
const { writeJsonFile } = await import("@audit-tools/shared");

test("FND-OBS-48c05a13: mergeAndIngestCommand logs notDispatched task IDs to stderr when budget-capped", async () => {
  await withTempDir(async (artifactsDir) => {
    const runId = "run-not-dispatched-obs";
    const runDir = join(artifactsDir, "runs", runId);
    const taskResultsDir = join(runDir, "task-results");
    await mkdir(taskResultsDir, { recursive: true });

    const workerTask = {
      obligation_id: "audit_tasks_completed",
      repo_root: artifactsDir,
      result_path: join(runDir, "worker-result.json"),
    };
    await writeFile(join(runDir, "task.json"), JSON.stringify(workerTask), "utf8");

    // Two pending tasks but only one dispatched (one notDispatched → budget-capped).
    const taskA = {
      task_id: "task-obs-a",
      unit_id: "src/a.ts",
      pass_id: "pass-1",
      lens: "correctness",
      file_paths: ["src/a.ts"],
      rationale: "test",
      priority: "medium",
      file_line_counts: { "src/a.ts": 10 },
    };
    const taskB = {
      task_id: "task-obs-b",
      unit_id: "src/b.ts",
      pass_id: "pass-2",
      lens: "security",
      file_paths: ["src/b.ts"],
      rationale: "test",
      priority: "medium",
      file_line_counts: { "src/b.ts": 10 },
    };
    await writeFile(join(runDir, "pending-audit-tasks.json"), JSON.stringify([taskA, taskB]), "utf8");

    // Only task-obs-a has a result entry in the dispatch result map.
    // task-obs-b has no entry → it becomes notDispatched.
    const resultMap = {
      contract_version: "audit-code-dispatch-results/v1alpha1",
      run_id: runId,
      entries: [
        {
          packet_id: "packet-1",
          task_id: taskA.task_id,
          result_path: join(taskResultsDir, `${taskA.task_id}.json`),
        },
      ],
    };
    await writeFile(join(runDir, DISPATCH_RESULT_MAP_FILENAME), JSON.stringify(resultMap), "utf8");

    // Write a valid result for task-obs-a.
    const resultA = {
      task_id: taskA.task_id,
      unit_id: taskA.unit_id,
      pass_id: taskA.pass_id,
      lens: taskA.lens,
      file_coverage: [{ path: "src/a.ts", total_lines: 10 }],
      findings: [],
    };
    await writeFile(join(taskResultsDir, `${taskA.task_id}.json`), JSON.stringify(resultA), "utf8");

    // Provide a minimal repo_manifest so loadArtifactBundle doesn't fail
    // before the notDispatched log fires.
    const repoManifest = {
      contract_version: "audit-tools/repo-manifest/v1",
      repository: { name: "test", root: artifactsDir },
      generated_at: new Date().toISOString(),
      files: [],
      file_count: 0,
      total_size_bytes: 0,
    };
    await writeJsonFile(join(artifactsDir, "repo_manifest.json"), repoManifest);

    const stderrLines = [];
    await withCapturedStderr(async (lines) => {
      try {
        await cmdMergeAndIngest(["--run-id", runId, "--artifacts-dir", artifactsDir]);
      } catch {
        // May throw in runAuditStep internals — we only care about whether
        // the notDispatched log line was emitted before the error.
      }
      stderrLines.push(...lines);
    });

    const notDispatchedLine = stderrLines.find((l) =>
      l.includes("[merge-and-ingest]") && l.includes("not dispatched") && l.includes("task-obs-b"),
    );
    assert.ok(notDispatchedLine, "expected stderr log of notDispatched task IDs containing 'task-obs-b'");
    assert.match(notDispatchedLine, /1 task\(s\) not dispatched/);
  });
});

// ── FND-OBS-bf5c7331: merge-results.mjs structured JSON summary ──────────────

const mergeScript = join(here, "..", "dispatch", "merge-results.mjs");

function runScript(args = [], cwd = process.cwd()) {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return spawnSync(process.execPath, [mergeScript, ...args], {
    encoding: "utf8",
    cwd,
    env,
    timeout: 10_000,
  });
}

function minimalValidResult(taskId) {
  return {
    task_id: taskId,
    unit_id: "src/utils/helper.ts",
    pass_id: "pass-1",
    lens: "correctness",
    file_coverage: [{ path: "src/utils/helper.ts", total_lines: 10 }],
    findings: [],
  };
}

test("FND-OBS-bf5c7331: merge-results.mjs emits a structured JSON merge_summary line on stdout before the plain text line", async () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), "audit-merge-obs-"));
  try {
    const runId = "run-obs-bf5c7331";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    const goodId = "task-obs-good";
    writeFileSync(
      join(taskResultsDir, `${goodId}.json`),
      JSON.stringify(minimalValidResult(goodId), null, 2),
      "utf8",
    );

    const result = runScript([
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    assert.equal(result.status, 0, `expected clean exit; stderr: ${result.stderr}`);

    // stdout must contain a parseable JSON line with event=merge_summary
    const stdoutLines = result.stdout.split("\n").filter((l) => l.trim().length > 0);
    const summaryLine = stdoutLines.find((l) => {
      try {
        const obj = JSON.parse(l.trim());
        return obj.event === "merge_summary";
      } catch { return false; }
    });
    assert.ok(summaryLine, "expected a JSON merge_summary line on stdout");
    const parsed = JSON.parse(summaryLine.trim());
    assert.equal(parsed.source, "audit-code:merge-results");
    assert.equal(parsed.total, 1);
    assert.equal(parsed.accepted, 1);
    assert.equal(parsed.rejected, 0);
    assert.ok(typeof parsed.audit_results_path === "string");
    assert.ok(typeof parsed.ts === "string" && !isNaN(Date.parse(parsed.ts)), "ts is a valid ISO timestamp");

    // The JSON summary line must appear before the plain text line
    const summaryIdx = stdoutLines.findIndex((l) => {
      try { return JSON.parse(l.trim()).event === "merge_summary"; } catch { return false; }
    });
    const textIdx = stdoutLines.findIndex((l) => l.includes("tasks valid"));
    assert.ok(summaryIdx !== -1, "JSON summary line present");
    assert.ok(textIdx !== -1, "plain text line present");
    assert.ok(summaryIdx < textIdx, "JSON summary comes before plain text");
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});

test("FND-OBS-bf5c7331: merge-results.mjs JSON summary includes failed_tasks_path when rejections exist", () => {
  const artifactsDir = mkdtempSync(join(tmpdir(), "audit-merge-obs-fail-"));
  try {
    const runId = "run-obs-fail";
    const taskResultsDir = join(artifactsDir, "runs", runId, "task-results");
    mkdirSync(taskResultsDir, { recursive: true });

    writeFileSync(join(taskResultsDir, "bad.json"), "{ not valid json", "utf8");

    const result = runScript([
      "--run-id", runId,
      "--artifacts-dir", artifactsDir,
    ]);
    assert.equal(result.status, 1, "expected non-zero exit on validation failure");

    const summaryLine = result.stdout.split("\n").find((l) => {
      try { return JSON.parse(l.trim()).event === "merge_summary"; } catch { return false; }
    });
    assert.ok(summaryLine, "expected a JSON merge_summary line on stdout");
    const parsed = JSON.parse(summaryLine.trim());
    assert.equal(parsed.rejected, 1);
    assert.ok(typeof parsed.failed_tasks_path === "string", "failed_tasks_path present when rejections > 0");
  } finally {
    rmSync(artifactsDir, { recursive: true, force: true });
  }
});
