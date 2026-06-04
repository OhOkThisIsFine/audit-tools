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

// ── FINDING-011: single-worker canary ───────────────────────────────────────

await test("FINDING-011: first contact with multiple packets emits only the canary packet", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir, runDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);

  assert.equal(result.packet_count, 1, "only the canary packet is emitted");
  assert.equal(result.phase, "canary");
  assert.ok(result.canary_packet_id, "canary_packet_id is set");
  // task_count still reflects all remaining tasks, not just the canary's.
  assert.equal(result.task_count, tasks.length);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  assert.equal(plan.length, 1, "dispatch plan has exactly one entry");
  assert.equal(plan[0].packet_id, result.canary_packet_id);

  const active = await readActiveDispatch(artifactsDir);
  assert.equal(active.phase, "canary");
  assert.equal(active.canary_packet_id, result.canary_packet_id);
  assert.equal(active.packet_count, 1);
  assert.equal(active.task_count, tasks.length);

  // Exactly one packet prompt file exists.
  const taskResultsDir = join(runDir, "task-results");
  assert.ok(await exists(packetPromptPath(taskResultsDir, result.canary_packet_id)));
});

await test("FINDING-011: fan-out after an accepted canary result dispatches the remaining packets", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir, runDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const first = await run(artifactsDir);
  assert.equal(first.phase, "canary");
  const canaryPlan = await readJson(join(runDir, "dispatch-plan.json"));
  // Map the canary packet to its tasks via the result map, then accept them.
  const resultMap = await readJson(join(runDir, "dispatch-result-map.json"));
  const canaryTaskIds = resultMap.entries
    .filter((e) => e.packet_id === first.canary_packet_id)
    .map((e) => e.task_id);
  assert.ok(canaryTaskIds.length >= 1);
  await acceptPacketTasks(runDir, canaryTaskIds);

  const second = await run(artifactsDir);
  assert.equal(second.phase, "fan_out");
  assert.equal(second.canary_packet_id, null);
  assert.equal(second.skipped_task_count, canaryTaskIds.length);

  // The second round's plan excludes the canary's tasks and includes the rest.
  const plan2 = await readJson(join(runDir, "dispatch-plan.json"));
  const plan2PacketIds = plan2.map((p) => p.packet_id);
  assert.ok(
    !plan2PacketIds.includes(first.canary_packet_id),
    "canary packet not re-dispatched",
  );
  assert.equal(plan2.length, tasks.length - canaryTaskIds.length);

  // No canary_not_accepted warning since the canary was accepted.
  assert.equal(second.warning_count >= 0, true);
  const warningsPath = join(runDir, "dispatch-warnings.json");
  if (await exists(warningsPath)) {
    const warnings = await readJson(warningsPath);
    assert.ok(
      !warnings.some((w) => w.code === "canary_not_accepted"),
      "no canary_not_accepted warning when canary was accepted",
    );
  }
  // Sanity: the first plan was a single entry.
  assert.equal(canaryPlan.length, 1);
});

await test("FINDING-011 regression: canary graduates to fan-out even after merge-and-ingest prunes the accepted canary tasks from the pending list", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir, runDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const first = await run(artifactsDir);
  assert.equal(first.phase, "canary");

  // Accept the canary packet's tasks (submit-packet writes these result files).
  const resultMap = await readJson(join(runDir, "dispatch-result-map.json"));
  const canaryTaskIds = resultMap.entries
    .filter((e) => e.packet_id === first.canary_packet_id)
    .map((e) => e.task_id);
  await acceptPacketTasks(runDir, canaryTaskIds);

  // Reproduce what merge-and-ingest does after accepting the canary: it rewrites
  // pending-audit-tasks.json to EXCLUDE the now-completed canary tasks. The old
  // firstContact signal (result files keyed off the pending list) broke on exactly
  // this — the canary's task_ids leave the list, so no still-pending task has a
  // result file, priorResultTaskIds stayed empty, and the canary re-fired forever
  // (1 packet per cycle, never reaching fan-out). Graduation must now come from the
  // active-dispatch marker (run_id), not the prune-corrupted result-file scan.
  const remaining = tasks.filter((task) => !canaryTaskIds.includes(task.task_id));
  await writeFile(
    join(runDir, "pending-audit-tasks.json"),
    JSON.stringify(remaining),
    "utf8",
  );

  const second = await run(artifactsDir);
  assert.equal(second.phase, "fan_out", "canary must graduate to fan-out, not re-fire");
  assert.equal(second.canary_packet_id, null);
  // Every remaining packet is dispatched in this one fan-out round (parallelizable),
  // instead of one packet per cycle.
  const plan2 = await readJson(join(runDir, "dispatch-plan.json"));
  assert.equal(plan2.length, remaining.length);
  assert.ok(
    !plan2.some((p) => p.packet_id === first.canary_packet_id),
    "canary packet is not re-dispatched",
  );
});

await test("FINDING-011: fan-out warns when the prior canary produced no accepted result", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir, runDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const first = await run(artifactsDir);
  assert.equal(first.phase, "canary");
  // Do NOT accept the canary. Instead, simulate at least one OTHER task being
  // done so priorResultTaskIds is non-empty (forces fan-out) while the canary's
  // own task remains unaccepted.
  const resultMap = await readJson(join(runDir, "dispatch-result-map.json"));
  const canaryTaskIds = new Set(
    resultMap.entries
      .filter((e) => e.packet_id === first.canary_packet_id)
      .map((e) => e.task_id),
  );
  const otherTaskId = tasks.map((t) => t.task_id).find((id) => !canaryTaskIds.has(id));
  assert.ok(otherTaskId, "a non-canary task exists");
  await acceptPacketTasks(runDir, [otherTaskId]);

  const second = await run(artifactsDir);
  assert.equal(second.phase, "fan_out");
  assert.ok(second.dispatch_warnings_path, "warnings file written");
  assert.ok(second.warning_count >= 1);
  const warnings = await readJson(second.dispatch_warnings_path);
  assert.ok(
    warnings.some((w) => w.code === "canary_not_accepted"),
    "canary_not_accepted warning emitted",
  );
  // Fan-out still proceeds: remaining packets are dispatched.
  const plan2 = await readJson(join(runDir, "dispatch-plan.json"));
  assert.ok(plan2.length >= 1, "remaining packets dispatched, not blocked");
});

await test("FINDING-011: no-op for a single packet on first contact", async (t) => {
  const { artifactsDir } = await makeArtifactsDir(singlePacketTask());
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  assert.equal(result.packet_count, 1);
  assert.equal(result.phase, "fan_out");
  assert.equal(result.canary_packet_id, null);
});

await test("FINDING-011: canary disabled dispatches all packets in one round", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir, { dispatch: { canary: false } });
  assert.equal(result.packet_count, tasks.length);
  assert.equal(result.phase, "fan_out");
  assert.equal(result.canary_packet_id, null);
});

await test("FINDING-011: canary defaults on when sessionConfig.dispatch is undefined", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir, {}); // no dispatch field
  assert.equal(result.phase, "canary");
  assert.equal(result.packet_count, 1);
});

// ── FINDING-012: confirmation threshold + dispatch summary ───────────────────

await test("FINDING-012: confirmation_recommended, wave_count, and dispatch_summary on the result", async (t) => {
  // Disable canary so all packets are emitted in one round and agent_count is
  // the full packet count.
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir, { dispatch: { canary: false } });

  assert.equal(result.agent_count, tasks.length);
  assert.equal(typeof result.confirmation_recommended, "boolean");
  // Below the default threshold of 10 → not recommended.
  assert.equal(result.confirmation_recommended, false);
  assert.equal(typeof result.dispatch_summary, "string");
  assert.match(result.dispatch_summary, /agent.* across .*wave/);
  // wave_count = ceil(agent_count / max(1, wave_size)).
  assert.equal(
    result.wave_count,
    Math.ceil(result.agent_count / Math.max(1, result.wave_size)),
  );
});

await test("FINDING-012: confirmation_recommended flips when agent_count exceeds confirm_threshold", async (t) => {
  const tasks = multiPacketTasks(); // 3 packets when canary off
  const { artifactsDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // threshold 2, agent_count 3 → recommended.
  const above = await run(artifactsDir, {
    dispatch: { canary: false, confirm_threshold: 2 },
  });
  assert.equal(above.agent_count, 3);
  assert.equal(above.confirmation_recommended, true);

  // threshold 3, agent_count 3 → NOT recommended (strictly greater-than).
  const at = await run(artifactsDir, {
    dispatch: { canary: false, confirm_threshold: 3 },
  });
  assert.equal(at.confirmation_recommended, false);
});

// ── FINDING-013: top-K coverage budget ──────────────────────────────────────

await test("FINDING-013: max_packets caps emitted packets and records deferred ids", async (t) => {
  const tasks = multiPacketTasks(); // 3 packets
  const { artifactsDir, runDir } = await makeArtifactsDir(tasks);
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Disable canary so the budget is the only filter; cap at 2 of 3.
  const result = await run(artifactsDir, {
    dispatch: { canary: false, max_packets: 2 },
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
    dispatch: { canary: false, max_packets: 99 },
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
  const result = await run(artifactsDir, { dispatch: { canary: false } });
  assert.equal(result.budget_capped, false);
  assert.equal(result.packet_count, tasks.length);
});
