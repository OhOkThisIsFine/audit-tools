import { test, onTestFinished, expect } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { prepareDispatchArtifacts, ACTIVE_DISPATCH_FILENAME } = await import("../../src/audit/cli/dispatch.ts");
const { taskResultPath, packetPromptPath } = await import("../../src/audit/cli/args.ts");
const { packageRoot } = await import("../../src/audit/cli/paths.ts");

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
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);
  const taskResultsDir = join(runDir, "task-results");

  for (const name of [
    "audit_result.schema.json",
    "finding.schema.json",
    "audit_task.schema.json",
  ]) {
    const p = join(taskResultsDir, name);
    expect(await exists(p), `${name} should exist`).toBeTruthy();
    const parsed = await readJson(p); // throws if not valid JSON
    expect(typeof parsed).toBe("object");
  }
});

await test("FINDING-009: the task-results schema files are byte-for-byte equal to the canonical sources", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(multiPacketTasks());
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);
  const taskResultsDir = join(runDir, "task-results");

  for (const name of [
    "audit_result.schema.json",
    "finding.schema.json",
    "audit_task.schema.json",
  ]) {
    const copied = await readFile(join(taskResultsDir, name), "utf8");
    const canonical = await readFile(join(packageRoot, "schemas", name), "utf8");
    expect(copied, `${name} should match canonical source`).toBe(canonical);
  }
});

await test("FINDING-009: the packet prompt references the schema file and retains existing constraints", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(singlePacketTask());
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);
  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  expect(plan.length).toBe(1);
  const prompt = await readFile(plan[0].prompt_path, "utf8");

  expect(prompt).toMatch(/audit_result\.schema\.json/);
  expect(prompt.includes("finding.schema.json") ||
      prompt.includes("audit_task.schema.json"), "prompt should reference at least one $ref sibling schema").toBeTruthy();
  // Existing prose retained verbatim.
  expect(prompt).toMatch(/Required AuditResult fields:/);
  expect(prompt).toMatch(/1\. line_end must not exceed the file's actual line count\./);
  expect(prompt).toMatch(/2\. affected_files entries are objects with a path key/);
  expect(prompt).toMatch(/3\. Only reference files from the packet/);
  expect(prompt).toMatch(/4\. findings: \[\] is correct when you find nothing genuine\./);
});

// ── All packets dispatched in one round (canary removed) ──────────────────────

await test("all packets dispatched in one round on first contact", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  expect(result.packet_count).toBe(tasks.length);
});

await test("single packet on first contact dispatches normally", async (t) => {
  const { artifactsDir } = await makeArtifactsDir(singlePacketTask());
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  expect(result.packet_count).toBe(1);
});

// ── JIT graph partition drives packetization (N4b keystone) ──────────────────
// Two tasks on the SAME file, different lenses → a strong (cross_lens_same_file)
// affinity edge. Whether they share a packet is now decided by the dispatching
// model's context budget at dispatch time, not a frozen plan-time cap.

// `tokenEstimate` is the frozen per-task content-token estimate the partition
// accumulates against the model's context ceiling.
function sharedFileTasks(tokenEstimate) {
  const file = "src/shared/core.ts";
  return ["security", "correctness"].map((lens) => ({
    task_id: `t-${lens}`,
    unit_id: "unit-shared",
    pass_id: `pass:${lens}`,
    lens,
    file_paths: [file],
    file_line_counts: { [file]: 120 },
    rationale: `review ${lens}`,
    priority: "medium",
    token_estimate: tokenEstimate,
    risk_estimate: 0.2,
  }));
}

await test("JIT partition merges affinity-linked tasks under the context budget", async (t) => {
  // 2 × 4000 + prompt overhead sits well under the ~28k default input budget.
  const { artifactsDir } = await makeArtifactsDir(sharedFileTasks(4000));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  expect(result.packet_count, "small same-file tasks pack into one coherent packet").toBe(1);
});

await test("JIT partition splits a cluster that exceeds the context budget", async (t) => {
  // 2 × 20000 = 40000 exceeds the ~28k default input budget → cannot merge even
  // across a strong edge; the partition keeps them as separate packets.
  const { artifactsDir } = await makeArtifactsDir(sharedFileTasks(20000));
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  expect(result.packet_count, "an oversized cluster splits along its weakest edge under the budget").toBe(2);
});

await test("capability handshake: host-reported context window collapses the split (N5b)", async (t) => {
  // 2 × 20000 = 40000 exceeds the ~28k default input budget → splits to 2 packets
  // with no handshake. When the host reports a 200k window, the same cluster fits
  // in one packet — the budget now reflects the real dispatch model.
  const tasks = sharedFileTasks(20000);
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId: RUN_ID,
    artifactsDir,
    root: artifactsDir,
    sessionConfig: {},
    hostModel: null,
    hostContextTokens: 200_000,
    hostOutputTokens: 32_000,
  });
  expect(result.packet_count, "a 200k host window packs the cluster the 32k default would split").toBe(1);
  // The dispatch-quota records the discovered budget for this session.
  const quota = await readJson(join(artifactsDir, "runs", RUN_ID, "dispatch-quota.json"));
  expect(quota.resolved_limits.context_tokens).toBe(200_000);
  expect(quota.source).toBe("discovered_capability");
});

await test("JIT partition splits a coherent cluster at the risk-mass ceiling", async (t) => {
  // Small tokens (would merge on token budget alone) but each task is near-max
  // risk; risk_mass_budget caps aggregate risk so they cannot share a packet.
  const tasks = sharedFileTasks(2000).map((task) => ({
    ...task,
    risk_estimate: 0.9,
  }));
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir, { dispatch: { risk_mass_budget: 1.0 } });
  expect(result.packet_count, "0.9 + 0.9 = 1.8 exceeds the 1.0 risk-mass ceiling → no merge").toBe(2);
});

// ── FINDING-012: confirmation threshold + dispatch summary ───────────────────

await test("FINDING-012: confirmation_recommended and dispatch_summary on the result", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);

  expect(result.agent_count).toBe(tasks.length);
  expect(typeof result.confirmation_recommended).toBe("boolean");
  // Below the default threshold of 10 → not recommended.
  expect(result.confirmation_recommended).toBe(false);
  expect(typeof result.dispatch_summary).toBe("string");
  expect(result.dispatch_summary).toMatch(/packet.* granted this pass/);
  expect(typeof result.granted_count).toBe("number");
});

await test("FINDING-012: confirmation_recommended flips when agent_count exceeds confirm_threshold", async (t) => {
  const tasks = multiPacketTasks(); // 3 packets
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // threshold 2, agent_count 3 → recommended.
  const above = await run(artifactsDir, {
    dispatch: { confirm_threshold: 2 },
  });
  expect(above.agent_count).toBe(3);
  expect(above.confirmation_recommended).toBe(true);

  // threshold 3, agent_count 3 → NOT recommended (strictly greater-than).
  const at = await run(artifactsDir, {
    dispatch: { confirm_threshold: 3 },
  });
  expect(at.confirmation_recommended).toBe(false);
});

// ── Bug 8 / Slice A4: confirm-once-per-run ───────────────────────────────────

await test("Bug 8: confirmation_recommended fires on the first grant, is suppressed on a repeat grant of the SAME run, and fires again on a fresh run", async (t) => {
  const tasks = multiPacketTasks(); // 3 packets, agent_count stays 3 across passes below
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const sessionConfig = { dispatch: { confirm_threshold: 2 } }; // 3 > 2 → arithmetic is true every pass

  // Pass 1 (first grant of run "test-run"): arithmetic says true, nothing
  // carried yet → recommended, and confirmation_shown is persisted.
  const pass1 = await run(artifactsDir, sessionConfig);
  expect(pass1.agent_count).toBe(3);
  expect(pass1.confirmation_recommended).toBe(true);
  const activeAfterPass1 = await readActiveDispatch(artifactsDir);
  expect(activeAfterPass1.confirmation_shown).toBe(true);

  // Pass 2 (same run_id "test-run", same shape — no packets accepted, so
  // agent_count is still 3 and the raw arithmetic is still true): the prior
  // confirmation_shown must suppress the recommendation.
  const pass2 = await run(artifactsDir, sessionConfig);
  expect(pass2.agent_count).toBe(3);
  expect(pass2.confirmation_recommended, "steady-state repeat grant must not re-recommend").toBe(false);
  const activeAfterPass2 = await readActiveDispatch(artifactsDir);
  expect(activeAfterPass2.confirmation_shown).toBe(true);

  // A NEW run_id (fresh ActiveDispatchState, even under the same artifacts
  // dir) has no carried confirmation_shown → recommends again. Distinct
  // task_ids from pass 1/2 (task-claims.json is shared across runs in the
  // SAME artifacts dir, keyed by task_id) so this run's claim isn't skipped
  // as "held live by a peer" (the still-live pass-1/2 claims on t-a/t-b/t-c).
  const freshRunId = "test-run-fresh";
  const freshTasks = tasks.map((task) => ({
    ...task,
    task_id: `${task.task_id}-fresh`,
    unit_id: `${task.unit_id}-fresh`,
  }));
  const freshRunDir = join(artifactsDir, "runs", freshRunId);
  await mkdir(freshRunDir, { recursive: true });
  await writeFile(
    join(freshRunDir, "pending-audit-tasks.json"),
    JSON.stringify(freshTasks),
    "utf8",
  );
  const pass3 = await prepareDispatchArtifacts({
    packageRoot,
    runId: freshRunId,
    artifactsDir,
    root: artifactsDir,
    sessionConfig,
    hostModel: null,
  });
  expect(pass3.agent_count).toBe(3);
  expect(pass3.confirmation_recommended, "a fresh run confirms again").toBe(true);
});

// ── FINDING-013: top-K coverage budget ──────────────────────────────────────

await test("FINDING-013: max_packets caps emitted packets and records deferred ids", async (t) => {
  const tasks = multiPacketTasks(); // 3 packets
  const { artifactsDir, runDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Cap at 2 of 3.
  const result = await run(artifactsDir, {
    dispatch: { max_packets: 2 },
  });
  expect(result.budget_capped).toBe(true);
  expect(result.packet_count).toBe(2);
  expect(result.deferred_packet_count).toBe(1);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  expect(plan.length).toBe(2);

  const active = await readActiveDispatch(artifactsDir);
  expect(active.budget_packet_count, "total before cap").toBe(3);
  expect(active.deferred_packet_ids.length).toBe(1);
  expect(active.deferred_task_ids.length).toBe(1);
  // The deferred packet id must be the one NOT in the plan.
  const planIds = new Set(plan.map((p) => p.packet_id));
  expect(!planIds.has(active.deferred_packet_ids[0])).toBeTruthy();
});

await test("FINDING-013: max_packets >= packet count is no cap (budget off)", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir, {
    dispatch: { max_packets: 99 },
  });
  expect(result.budget_capped).toBe(false);
  expect(result.packet_count).toBe(tasks.length);
  expect(result.deferred_packet_count).toBe(0);
  const active = await readActiveDispatch(artifactsDir);
  expect(active.deferred_packet_ids).toBe(undefined);
  expect(active.budget_packet_count).toBe(undefined);
});

await test("FINDING-013: budget defaults OFF — all packets emitted when max_packets is unset", async (t) => {
  const tasks = multiPacketTasks();
  const { artifactsDir } = await makeArtifactsDir(tasks);
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  const result = await run(artifactsDir);
  expect(result.budget_capped).toBe(false);
  expect(result.packet_count).toBe(tasks.length);
});

// ── FINDING-018: per-packet access metadata ──────────────────────────────────

await test("FINDING-018: dispatch plan entries include access.read_paths with prompt path and source files", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(singlePacketTask());
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  expect(plan.length).toBe(1);
  const entry = plan[0];

  expect(entry.access, "plan entry should have access object").toBeTruthy();
  expect(Array.isArray(entry.access.read_paths), "access.read_paths should be an array").toBeTruthy();
  expect(entry.access.read_paths.some((p) => p === entry.prompt_path), "access.read_paths should include the prompt path").toBeTruthy();
  expect(entry.access.read_paths.some((p) => p.includes("only.ts")), "access.read_paths should include the packet's source file path").toBeTruthy();
});

await test("dispatch plan entry file_paths is the REPO-RELATIVE source set (for single-shot content inlining), excluding the prompt artifact", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(singlePacketTask());
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  const entry = plan[0];

  // file_paths drives openai-compatible / NIM content-inlining. It must be the
  // repo-relative source set — NOT access.read_paths, which is absolute and carries
  // the prompt artifact (self-inlining it, or false-refusing on an out-of-repo
  // artifacts dir).
  expect(Array.isArray(entry.file_paths), "entry should carry file_paths").toBeTruthy();
  expect(entry.file_paths.some((p) => p.includes("only.ts")), "file_paths should include the packet source file").toBeTruthy();
  // Repo-relative: no drive letter, no leading slash, no artifacts-dir prefix.
  for (const p of entry.file_paths) {
    expect(/^[A-Za-z]:[\\/]/.test(p), `file_paths entry must not be absolute: ${p}`).toBe(false);
    expect(p.startsWith("/"), `file_paths entry must not be root-absolute: ${p}`).toBe(false);
  }
  // The prompt artifact must NOT be in file_paths (it would self-inline).
  expect(entry.file_paths.includes(entry.prompt_path), "file_paths must not contain the prompt artifact").toBe(false);
});

await test("FINDING-018: dispatch plan entries access.write_paths contains only task result paths, not directories", async (t) => {
  const { artifactsDir, runDir } = await makeArtifactsDir(singlePacketTask());
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);

  const plan = await readJson(join(runDir, "dispatch-plan.json"));
  const entry = plan[0];
  const taskResultsDir = join(runDir, "task-results");

  expect(Array.isArray(entry.access.write_paths), "access.write_paths should be an array").toBeTruthy();
  // Per-task canonical ingestion target(s) plus the per-packet result file the
  // worker actually writes (packetResultPath) — both pre-approved so hosts that
  // enforce write_paths don't block the result write. For a single-task packet
  // that is 2 entries: one per-task path + the inline-result.json packet file.
  expect(entry.access.write_paths.length, "single-task packet has one per-task path + the packet result file").toBe(2);
  expect(entry.access.write_paths.every((p) => p.startsWith(taskResultsDir)), "every write_path should be a file inside task-results/").toBeTruthy();
  expect(entry.access.write_paths.some((p) => p.endsWith("inline-result.json")), "write_paths should include the per-packet result file the worker writes").toBeTruthy();
  expect(!entry.access.write_paths.includes(taskResultsDir), "write_paths should not contain the task-results directory itself").toBeTruthy();
  expect(!entry.access.write_paths.includes(runDir), "write_paths should not contain the run directory").toBeTruthy();
  expect(!entry.access.write_paths.includes(artifactsDir), "write_paths should not contain the repo root or artifacts dir").toBeTruthy();
});

await test("FINDING-018: dispatch plan entries include forbidden_patterns for common stray filenames", async (t) => {
  const { artifactsDir } = await makeArtifactsDir(singlePacketTask());
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));
  await run(artifactsDir);

  const plan = await readJson(join(join(artifactsDir, "runs", RUN_ID), "dispatch-plan.json"));
  const entry = plan[0];

  expect(Array.isArray(entry.access.forbidden_patterns), "access.forbidden_patterns should be an array").toBeTruthy();
  expect(entry.access.forbidden_patterns.some((p) => p.includes("packet-") && p.includes("result")), "forbidden_patterns should include a packet-result glob").toBeTruthy();
  expect(entry.access.forbidden_patterns.some((p) => p.includes("audit_result")), "forbidden_patterns should include an audit_result glob").toBeTruthy();
});
