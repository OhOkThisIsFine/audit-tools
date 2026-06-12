import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prepareDispatchArtifacts, ACTIVE_DISPATCH_FILENAME } = await import(
  "../src/cli/dispatch.ts"
);
const { taskResultPath, packetPromptPath } = await import("../src/cli/args.ts");
const { packageRoot } = await import("../src/cli/paths.ts");

const RUN_ID = "test-run";

// Three tasks in three distinct units → three priority-ordered packets
// (high → medium → low). packets[0] is the high-priority security task.
function multiPacketTasks() {
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

function singlePacketTask() {
  return [
    {
      task_id: "t-only",
      unit_id: "unit-only",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_paths: ["src/only/only.ts"],
      file_line_counts: { "src/only/only.ts": 80 },
      rationale: "review only",
      priority: "medium",
    },
  ];
}

async function makeArtifactsDir(tasks) {
  const artifactsDir = await mkdtemp(join(tmpdir(), "audit-dispatch-"));
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "pending-audit-tasks.json"),
    JSON.stringify(tasks),
    "utf8",
  );
  return { artifactsDir, runDir };
}

function run(artifactsDir, sessionConfig) {
  return prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir, // repo root unused for non-large-file packets
    sessionConfig: sessionConfig ?? {},
    hostModel: null,
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readActiveDispatch(artifactsDir) {
  return readJson(join(artifactsDir, ACTIVE_DISPATCH_FILENAME));
}

// Simulate an accepted submit-packet by writing the per-task result files for a
// packet (submit-packet only writes these after validation passes).
async function acceptPacketTasks(runDir, taskIds) {
  const taskResultsDir = join(runDir, "task-results");
  for (const taskId of taskIds) {
    await writeFile(
      taskResultPath(taskResultsDir, taskId),
      JSON.stringify({ task_id: taskId, findings: [] }),
      "utf8",
    );
  }
}

// ── FINDING-009: schema pointer + reachable schema files ────────────────────

await test("FINDING-009: prepareDispatchArtifacts writes the three schema files into task-results/", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(multiPacketTasks());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);
  const taskResultsDir = join(runDir, "task-results");

  for (const name of [
    "audit_result.schema.json",
    "finding.schema.json",
    "audit_task.schema.json",
  ]) {
    const p = join(taskResultsDir, name);
    assert.ok(await exists(p), `${name} should exist`);
    const parsed = await readJson(p); // throws if not valid JSON
    assert.equal(typeof parsed, "object");
  }
});

await test("FINDING-009: the task-results schema files are byte-for-byte equal to the canonical sources", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(multiPacketTasks());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);
  const taskResultsDir = join(runDir, "task-results");

  for (const name of [
    "audit_result.schema.json",
    "finding.schema.json",
    "audit_task.schema.json",
  ]) {
    const copied = await readFile(join(taskResultsDir, name), "utf8");
    const canonical = await readFile(join(packageRoot, "schemas", name), "utf8");
    assert.equal(copied, canonical, `${name} should match canonical source`);
  }
});

await test("FINDING-009: the packet prompt references the schema file and retains existing constraints", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(singlePacketTask());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);
  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  assert.equal(plan.length, 1);
  const prompt = await readFile(plan[0].prompt_path, "utf8");

  assert.match(prompt, /audit_result\.schema\.json/);
  assert.ok(
    prompt.includes("finding.schema.json") ||
      prompt.includes("audit_task.schema.json"),
    "prompt should reference at least one $ref sibling schema",
  );
  // Existing prose retained verbatim.
  assert.match(prompt, /Required AuditResult fields:/);
  assert.match(prompt, /1\. line_end must not exceed the file's actual line count\./);
  assert.match(prompt, /2\. affected_files entries are objects with a path key/);
  assert.match(prompt, /3\. Only reference files from the packet/);
  assert.match(prompt, /4\. findings: \[\] is correct when you find nothing genuine\./);
});

// ── All packets dispatched in one round (canary removed) ──────────────────────

await test("all packets dispatched in one round on first contact", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  assert.equal(result.packet_count, tasks.length);
});

await test("single packet on first contact dispatches normally", async (t) => {
  const { artifactsDir } = await makeArtifactsDir(singlePacketTask());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  assert.equal(result.packet_count, 1);
});

// ── FINDING-012: confirmation threshold + dispatch summary ───────────────────

await test("FINDING-012: confirmation_recommended and dispatch_summary on the result", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);

  assert.equal(result.agent_count, tasks.length);
  assert.equal(typeof result.confirmation_recommended, "boolean");
  // Below the default threshold of 10 → not recommended.
  assert.equal(result.confirmation_recommended, false);
  assert.equal(typeof result.dispatch_summary, "string");
  assert.match(result.dispatch_summary, /agent.* max .* concurrent/);
  assert.equal(typeof result.max_concurrent_agents, "number");
});

await test("FINDING-012: confirmation_recommended flips when agent_count exceeds confirm_threshold", async (t) => {
  const tasks = multiPacketTasks(); // 3 packets
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // threshold 2, agent_count 3 → recommended.
  const above = await run(artifactsDir, {
    dispatch: { confirm_threshold: 2 },
  });
  assert.equal(above.agent_count, 3);
  assert.equal(above.confirmation_recommended, true);

  // threshold 3, agent_count 3 → NOT recommended (strictly greater-than).
  const at = await run(artifactsDir, {
    dispatch: { confirm_threshold: 3 },
  });
  assert.equal(at.confirmation_recommended, false);
});

// ── FINDING-013: top-K coverage budget ──────────────────────────────────────

await test("FINDING-013: max_packets caps emitted packets and records deferred ids", async (t) => {
  const tasks = multiPacketTasks(); // 3 packets
  const { artifactsDir, runDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Cap at 2 of 3.
  const result = await run(artifactsDir, {
    dispatch: { max_packets: 2 },
  });
  assert.equal(result.budget_capped, true);
  assert.equal(result.packet_count, 2);
  assert.equal(result.deferred_packet_count, 1);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  assert.equal(plan.length, 2);

  const active = await readActiveDispatch(artifactsDir);
  assert.equal(active.budget_packet_count, 3, "total before cap");
  assert.equal(active.deferred_packet_ids.length, 1);
  assert.equal(active.deferred_task_ids.length, 1);
  // The deferred packet id must be the one NOT in the plan.
  const planIds = new Set(plan.map((p) => p.packet_id));
  assert.ok(!planIds.has(active.deferred_packet_ids[0]));
});

await test("FINDING-013: max_packets >= packet count is no cap (budget off)", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir, {
    dispatch: { max_packets: 99 },
  });
  assert.equal(result.budget_capped, false);
  assert.equal(result.packet_count, tasks.length);
  assert.equal(result.deferred_packet_count, 0);
  const active = await readActiveDispatch(artifactsDir);
  assert.equal(active.deferred_packet_ids, undefined);
  assert.equal(active.budget_packet_count, undefined);
});

await test("FINDING-013: budget defaults OFF — all packets emitted when max_packets is unset", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  assert.equal(result.budget_capped, false);
  assert.equal(result.packet_count, tasks.length);
});

// ── FINDING-018: per-packet access metadata ──────────────────────────────────

await test("FINDING-018: dispatch plan entries include access.read_paths with prompt path and source files", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(singlePacketTask());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  assert.equal(plan.length, 1);
  const entry = plan[0];

  assert.ok(entry.access, "plan entry should have access object");
  assert.ok(Array.isArray(entry.access.read_paths), "access.read_paths should be an array");
  assert.ok(
    entry.access.read_paths.some((p) => p === entry.prompt_path),
    "access.read_paths should include the prompt path",
  );
  assert.ok(
    entry.access.read_paths.some((p) => p.includes("only.ts")),
    "access.read_paths should include the packet's source file path",
  );
});

await test("FINDING-018: dispatch plan entries access.write_paths contains only task result paths, not directories", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(singlePacketTask());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  const entry = plan[0];
  const taskResultsDir = join(runDir, "task-results");

  assert.ok(Array.isArray(entry.access.write_paths), "access.write_paths should be an array");
  assert.equal(entry.access.write_paths.length, 1, "should have one write path per task");
  assert.ok(
    entry.access.write_paths[0].startsWith(taskResultsDir),
    "write_path should be inside task-results/",
  );
  assert.ok(
    !entry.access.write_paths.includes(taskResultsDir),
    "write_paths should not contain the task-results directory itself",
  );
  assert.ok(
    !entry.access.write_paths.includes(runDir),
    "write_paths should not contain the run directory",
  );
  assert.ok(
    !entry.access.write_paths.includes(artifactsDir),
    "write_paths should not contain the repo root or artifacts dir",
  );
});

await test("FINDING-018: dispatch plan entries include forbidden_patterns for common stray filenames", async (t) => {
  const { artifactsDir } = await makeArtifactsDir(singlePacketTask());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);

  const plan = await readJson(join(join(artifactsDir, "runs", RUN_ID), "dispatch-plan.json"));
  const entry = plan[0];

  assert.ok(Array.isArray(entry.access.forbidden_patterns), "access.forbidden_patterns should be an array");
  assert.ok(
    entry.access.forbidden_patterns.some((p) => p.includes("packet-") && p.includes("result")),
    "forbidden_patterns should include a packet-result glob",
  );
  assert.ok(
    entry.access.forbidden_patterns.some((p) => p.includes("audit_result")),
    "forbidden_patterns should include an audit_result glob",
  );
});
