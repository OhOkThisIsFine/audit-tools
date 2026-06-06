import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import via the tsx source-import pattern (same as dispatch-features.test.mjs
// and dispatch-fanout.test.mjs) — no compiled dist required.
const { cmdSubmitPacket } = await import("../src/cli/submitPacketCommand.ts");

// ── Test fixtures ─────────────────────────────────────────────────────────────

const RUN_ID = "run-test-001";
const PACKET_ID = "pkt-alpha";

/**
 * Build a minimal AuditTask suitable for the tests.
 */
function makeTask(taskId, unitId = "unit-1") {
  return {
    task_id: taskId,
    unit_id: unitId,
    pass_id: `pass:correctness`,
    lens: "correctness",
    file_paths: [`src/${taskId}.ts`],
    file_line_counts: { [`src/${taskId}.ts`]: 50 },
    rationale: `review ${taskId}`,
    priority: "medium",
    status: "pending",
  };
}

function makeTaskCovering(taskId, path, lens = "security", unitId = "unit-1") {
  return {
    ...makeTask(taskId, unitId),
    pass_id: `pass:${lens}`,
    lens,
    file_paths: [path],
    file_line_counts: { [path]: 50 },
  };
}

/**
 * Build a minimal AuditResult for a given task.
 */
function makeResult(task) {
  return {
    task_id: task.task_id,
    unit_id: task.unit_id,
    pass_id: task.pass_id,
    lens: task.lens,
    agent_role: "test",
    file_coverage: (task.file_paths ?? []).map((p) => ({
      path: p,
      total_lines: task.file_line_counts?.[p] ?? 10,
    })),
    findings: [],
    notes: [],
    requires_followup: false,
  };
}

/**
 * Set up a temp artifacts directory containing the two files that
 * cmdSubmitPacket reads: pending-audit-tasks.json and dispatch-result-map.json.
 *
 * @param {object[]} tasks  All tasks in the run.
 * @param {string}   packetId  The packet to create entries for (defaults to PACKET_ID).
 * @param {string[]} packetTaskIds  Which task IDs belong to this packet.
 * @param {object[]} otherPacketResults  Pre-existing result files for OTHER packets.
 */
async function makeArtifactsDir({
  tasks,
  packetId = PACKET_ID,
  packetTaskIds,
  otherPacketResults = [],
}) {
  const artifactsDir = await mkdtemp(join(tmpdir(), "spc-test-"));
  const runDir = join(artifactsDir, "runs", RUN_ID);
  await mkdir(runDir, { recursive: true });

  const taskSet = packetTaskIds ?? tasks.map((t) => t.task_id);

  // pending-audit-tasks.json
  await writeFile(
    join(runDir, "pending-audit-tasks.json"),
    JSON.stringify(tasks),
    "utf8",
  );

  // dispatch-result-map.json
  const entries = taskSet.map((taskId) => ({
    packet_id: packetId,
    task_id: taskId,
    result_path: join(runDir, "task-results", `${taskId}.json`),
  }));

  // Add entries for other packets
  for (const other of otherPacketResults) {
    entries.push({
      packet_id: other.packetId,
      task_id: other.taskId,
      result_path: join(runDir, "task-results", `${other.taskId}.json`),
    });
    // Write the pre-existing result file
    await mkdir(join(runDir, "task-results"), { recursive: true });
    await writeFile(
      join(runDir, "task-results", `${other.taskId}.json`),
      JSON.stringify(other.result),
      "utf8",
    );
  }

  await writeFile(
    join(runDir, "dispatch-result-map.json"),
    JSON.stringify({
      contract_version: "audit-code-dispatch-results/v1alpha1",
      run_id: RUN_ID,
      entries,
    }),
    "utf8",
  );

  await mkdir(join(runDir, "task-results"), { recursive: true });
  return { artifactsDir, runDir };
}

/**
 * Run cmdSubmitPacket, capturing stdout and stderr, and returning
 * { stdout, stderr, error } where error is the thrown Error (if any).
 */
async function runSubmit(argv) {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalConsoleLog = console.log;

  process.stdout.write = (chunk) => {
    stdout += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...args) => {
    stdout += args.join(" ") + "\n";
  };

  let error = null;
  try {
    await cmdSubmitPacket(argv);
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    console.log = originalConsoleLog;
  }
  return { stdout, stderr, error };
}

/**
 * Build argv[] for cmdSubmitPacket given the artifacts dir and a JSON payload.
 */
function makeArgv(artifactsDir, packetId, payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return [
    "node",
    "audit-code.mjs",
    "submit-packet",
    "--run-id",
    RUN_ID,
    "--packet-id",
    packetId,
    "--artifacts-dir",
    artifactsDir,
    "--results-b64",
    payloadB64,
  ];
}

// ── 1. Packet-id normalization ─────────────────────────────────────────────────

await test("packet-id normalization resolves case/whitespace variants", async (t) => {
  const task = makeTask("task-norm-1");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit with wrong case and surrounding whitespace
  const weirdId = `  ${PACKET_ID.toUpperCase()}  `;
  const payload = [makeResult(task)];
  const argv = makeArgv(artifactsDir, weirdId, payload);

  const { stdout, stderr, error } = await runSubmit(argv);

  assert.equal(error, null, `Should not throw; got: ${error?.message}`);
  assert.ok(
    stderr.includes("normalization") || stderr.includes("Resolved"),
    `Expected normalization warning in stderr, got: ${stderr}`,
  );
  assert.ok(stdout.length > 0, "Expected JSON output on stdout");
  // The resolved packet_id in the output JSON must match the canonical (un-normalized) value
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.packet_id, PACKET_ID, `Expected canonical packet_id '${PACKET_ID}' in output, got '${parsed.packet_id}'`);
});

// ── 2. Unknown packet-id ───────────────────────────────────────────────────────

await test("unknown packet-id throws with valid id list", async (t) => {
  const task = makeTask("task-unk-1");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const argv = makeArgv(artifactsDir, "completely-unknown-id", [makeResult(task)]);
  const { error } = await runSubmit(argv);

  assert.ok(error instanceof Error, "Expected an error to be thrown");
  assert.ok(
    error.message.includes("Valid packet IDs"),
    `Expected 'Valid packet IDs' in error message, got: ${error.message}`,
  );
});

// ── 3. Duplicate task_id in payload ───────────────────────────────────────────

await test("duplicate task_id in payload is rejected", async (t) => {
  const task = makeTask("task-dup-1");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const result = makeResult(task);
  // Submit the same result twice → duplicate task_id
  const argv = makeArgv(artifactsDir, PACKET_ID, [result, result]);
  const { error } = await runSubmit(argv);

  assert.ok(error instanceof Error, "Expected an error to be thrown");
  assert.ok(
    error.message.includes(task.task_id) ||
      error.message.toLowerCase().includes("duplicate"),
    `Expected duplicate mention in error message, got: ${error.message}`,
  );
});

// ── 4. Unassigned task_id in payload ──────────────────────────────────────────

await test("unassigned task_id in payload is rejected", async (t) => {
  const task = makeTask("task-assigned-1");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit a result with a task_id that is NOT in the packet's assigned list
  const unassignedResult = makeResult(makeTask("task-NOT-in-packet"));
  const assignedResult = makeResult(task);
  const argv = makeArgv(artifactsDir, PACKET_ID, [assignedResult, unassignedResult]);
  const { error } = await runSubmit(argv);

  assert.ok(error instanceof Error, "Expected an error to be thrown");
  assert.ok(
    error.message.includes("task-NOT-in-packet") ||
      error.message.toLowerCase().includes("not assigned"),
    `Expected task_id or 'not assigned' in error, got: ${error.message}`,
  );
});

// ── 5. Missing assigned task in payload ───────────────────────────────────────

await test("missing assigned task in payload is rejected", async (t) => {
  const task1 = makeTask("task-miss-1");
  const task2 = makeTask("task-miss-2");
  const { artifactsDir } = await makeArtifactsDir({
    tasks: [task1, task2],
    packetTaskIds: [task1.task_id, task2.task_id],
  });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit only task1, omitting task2
  const argv = makeArgv(artifactsDir, PACKET_ID, [makeResult(task1)]);
  const { error } = await runSubmit(argv);

  assert.ok(error instanceof Error, "Expected an error to be thrown");
  assert.ok(
    error.message.includes(task2.task_id),
    `Expected missing task_id ${task2.task_id} in error, got: ${error.message}`,
  );
});

// ── 6. Cross-packet duplicate-finding warning ─────────────────────────────────

await test("cross-packet duplicate finding emits a warning but still accepts", async (t) => {
  const task1 = makeTaskCovering("task-dup-find-1", "src/shared.ts");

  // Pre-existing result in another packet with the same finding key
  const duplicateFinding = {
    id: "DUP-001",
    title: "Duplicate Finding",
    lens: "security",
    category: "Injection",
    severity: "high",
    confidence: "high",
    summary: "Dup.",
    affected_files: [{ path: "src/shared.ts" }],
    evidence: ["evidence"],
  };

  const otherTask = makeTaskCovering("task-other-pkt", "src/shared.ts");
  const otherResult = {
    ...makeResult(otherTask),
    findings: [duplicateFinding],
  };

  const { artifactsDir, runDir } = await makeArtifactsDir({
    tasks: [task1, otherTask],
    packetTaskIds: [task1.task_id],
    otherPacketResults: [
      {
        packetId: "pkt-other",
        taskId: otherTask.task_id,
        result: otherResult,
      },
    ],
  });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit a result for pkt-alpha that contains the same finding key
  const newResult = {
    ...makeResult(task1),
    findings: [
      { ...duplicateFinding, id: "DUP-002" },
    ],
  };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stdout, stderr, error } = await runSubmit(argv);

  assert.equal(error, null, `Should not throw; got: ${error?.message}`);
  assert.ok(
    stderr.includes("duplicate") || stderr.includes("Warning"),
    `Expected duplicate warning in stderr, got: ${stderr}`,
  );
  // The parsed stdout JSON must include duplicate_warning_count >= 1
  const parsedOut = JSON.parse(stdout.trim());
  assert.ok(
    typeof parsedOut.duplicate_warning_count === "number" && parsedOut.duplicate_warning_count >= 1,
    `Expected duplicate_warning_count >= 1 in output, got: ${JSON.stringify(parsedOut)}`,
  );
  // Result files should still be written (duplicate is warning-only)
  const resultPath = join(runDir, "task-results", `${task1.task_id}.json`);
  const written = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(written.task_id, task1.task_id);
});

// ── 7. Happy path — persistence gate ──────────────────────────────────────────

await test("happy path writes per-task result files and outputs accepted count", async (t) => {
  const task1 = makeTask("task-happy-1");
  const task2 = makeTask("task-happy-2", "unit-2");
  const { artifactsDir, runDir } = await makeArtifactsDir({
    tasks: [task1, task2],
    packetTaskIds: [task1.task_id, task2.task_id],
  });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const payload = [makeResult(task1), makeResult(task2)];
  const argv = makeArgv(artifactsDir, PACKET_ID, payload);
  const { stdout, error } = await runSubmit(argv);

  assert.equal(error, null, `Should not throw; got: ${error?.message}`);

  // Each task should have a result file written
  for (const task of [task1, task2]) {
    const resultPath = join(runDir, "task-results", `${task.task_id}.json`);
    const written = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(written.task_id, task.task_id);
  }

  // stdout should be valid JSON with the expected fields
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.run_id, RUN_ID);
  assert.equal(parsed.packet_id, PACKET_ID);
  assert.equal(parsed.accepted_count, 2);
  assert.equal(typeof parsed.finding_count, "number");
});

// -- 8. Happy path stamps run metadata ----------------------------------------

await test("happy path stamps run_id and one submitted_at value on each result", async (t) => {
  const task1 = makeTask("task-stamp-1");
  const task2 = makeTask("task-stamp-2", "unit-2");
  const { artifactsDir, runDir } = await makeArtifactsDir({
    tasks: [task1, task2],
    packetTaskIds: [task1.task_id, task2.task_id],
  });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const payload = [makeResult(task1), makeResult(task2)];
  const argv = makeArgv(artifactsDir, PACKET_ID, payload);
  const { error } = await runSubmit(argv);

  assert.equal(error, null, `Should not throw; got: ${error?.message}`);

  const writtenResults = [];
  for (const task of [task1, task2]) {
    const resultPath = join(runDir, "task-results", `${task.task_id}.json`);
    writtenResults.push(JSON.parse(await readFile(resultPath, "utf8")));
  }

  const submittedAtValues = new Set(writtenResults.map((result) => result.submitted_at));
  assert.equal(submittedAtValues.size, 1, "all files should share one submitted_at value");
  const submittedAt = writtenResults[0].submitted_at;
  assert.equal(typeof submittedAt, "string");
  assert.equal(new Date(submittedAt).toISOString(), submittedAt);

  for (const [index, written] of writtenResults.entries()) {
    const original = payload[index];
    assert.equal(written.run_id, RUN_ID);
    assert.equal(written.task_id, original.task_id);
    assert.equal(written.unit_id, original.unit_id);
    assert.equal(written.pass_id, original.pass_id);
    assert.equal(written.lens, original.lens);
    assert.deepEqual(written.file_coverage, original.file_coverage);
    assert.deepEqual(written.findings, original.findings);
  }
});

// ── 8. findingKey dedup: cross-packet duplicate detection ─────────────────────

await test("findingKey dedup: same finding in two packets is flagged as duplicate", async (t) => {
  const task1 = makeTaskCovering("task-fkdup-1", "src/auth.ts");
  const sharedFinding = {
    id: "FK-001",
    title: "Injection Risk",
    lens: "security",
    category: "Injection",
    severity: "high",
    confidence: "high",
    summary: "Shared finding.",
    affected_files: [{ path: "src/auth.ts" }],
    evidence: ["src/auth.ts:1 - shared injection risk"],
  };

  const otherTask = makeTaskCovering("task-fkdup-other", "src/auth.ts");
  const otherResult = { ...makeResult(otherTask), findings: [sharedFinding] };

  const { artifactsDir } = await makeArtifactsDir({
    tasks: [task1, otherTask],
    packetTaskIds: [task1.task_id],
    otherPacketResults: [
      { packetId: "pkt-other", taskId: otherTask.task_id, result: otherResult },
    ],
  });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit same finding (different id, same key fields) in pkt-alpha
  const newResult = { ...makeResult(task1), findings: [{ ...sharedFinding, id: "FK-002" }] };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stderr, error } = await runSubmit(argv);

  assert.equal(error, null, `Should not throw; got: ${error?.message}`);
  assert.ok(
    stderr.includes("duplicate") || stderr.includes("Warning"),
    `Expected duplicate warning in stderr, got: ${stderr}`,
  );
});

await test("findingKey dedup: case-insensitive lens match is still a duplicate", async (t) => {
  const task1 = makeTaskCovering("task-fkcase-1", "src/handler.ts");
  const baseFinding = {
    id: "FK-CASE-001",
    title: "Unhandled Error",
    lens: "Security",
    category: "error-handling",
    severity: "medium",
    confidence: "medium",
    summary: "Errors not handled.",
    affected_files: [{ path: "src/handler.ts" }],
    evidence: ["src/handler.ts:1 - unhandled error"],
  };

  const otherTask = makeTaskCovering("task-fkcase-other", "src/handler.ts");
  // Other packet uses uppercase "Security"; this packet will use lowercase "security"
  const otherResult = { ...makeResult(otherTask), findings: [baseFinding] };

  const { artifactsDir } = await makeArtifactsDir({
    tasks: [task1, otherTask],
    packetTaskIds: [task1.task_id],
    otherPacketResults: [
      { packetId: "pkt-case-other", taskId: otherTask.task_id, result: otherResult },
    ],
  });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const newResult = {
    ...makeResult(task1),
    findings: [{ ...baseFinding, id: "FK-CASE-002", lens: "security" }],
  };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stderr, error } = await runSubmit(argv);

  assert.equal(error, null, `Should not throw; got: ${error?.message}`);
  assert.ok(
    stderr.includes("duplicate") || stderr.includes("Warning"),
    `Expected duplicate warning for case-insensitive lens match, got: ${stderr}`,
  );
});

await test("findingKey dedup: finding differing in any key field is NOT a duplicate", async (t) => {
  const task1 = makeTaskCovering("task-fkdiff-1", "src/other.ts");
  const baseFinding = {
    id: "FK-DIFF-001",
    title: "SQL Injection",
    lens: "security",
    category: "Injection",
    severity: "critical",
    confidence: "high",
    summary: "SQL injection vector.",
    affected_files: [{ path: "src/db.ts" }],
    evidence: ["src/db.ts:1 - SQL injection vector"],
  };

  const otherTask = makeTaskCovering("task-fkdiff-other", "src/db.ts");
  const otherResult = { ...makeResult(otherTask), findings: [baseFinding] };

  const { artifactsDir } = await makeArtifactsDir({
    tasks: [task1, otherTask],
    packetTaskIds: [task1.task_id],
    otherPacketResults: [
      { packetId: "pkt-diff-other", taskId: otherTask.task_id, result: otherResult },
    ],
  });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  // Finding differs only in affected_files path — not a duplicate
  const newResult = {
    ...makeResult(task1),
    findings: [{ ...baseFinding, id: "FK-DIFF-002", affected_files: [{ path: "src/other.ts" }] }],
  };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stdout, stderr, error } = await runSubmit(argv);

  assert.equal(error, null, `Should not throw; got: ${error?.message}`);
  // No duplicate warning expected
  assert.ok(
    !stderr.includes("duplicate") && !stderr.includes("Warning"),
    `Did not expect duplicate warning for differing path, got: ${stderr}`,
  );
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.duplicate_warning_count, undefined);
});

// ── 11. Missing --run-id flag ─────────────────────────────────────────────────

await test("throws when --run-id is missing", async (t) => {
  const task = makeTask("task-no-runid");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const payloadB64 = Buffer.from(JSON.stringify([makeResult(task)])).toString("base64url");
  // Omit --run-id entirely
  const argv = [
    "node",
    "audit-code.mjs",
    "submit-packet",
    "--packet-id",
    PACKET_ID,
    "--artifacts-dir",
    artifactsDir,
    "--results-b64",
    payloadB64,
  ];
  const { error } = await runSubmit(argv);

  assert.ok(error instanceof Error, "Expected an error to be thrown");
  assert.ok(
    /--run-id/i.test(error.message),
    `Expected '--run-id' in error message, got: ${error.message}`,
  );
});

// ── 12. Missing --packet-id flag ─────────────────────────────────────────────

await test("throws when --packet-id is missing", async (t) => {
  const task = makeTask("task-no-packetid");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  t.after(() => rm(artifactsDir, { recursive: true, force: true }));

  const payloadB64 = Buffer.from(JSON.stringify([makeResult(task)])).toString("base64url");
  // Omit --packet-id entirely
  const argv = [
    "node",
    "audit-code.mjs",
    "submit-packet",
    "--run-id",
    RUN_ID,
    "--artifacts-dir",
    artifactsDir,
    "--results-b64",
    payloadB64,
  ];
  const { error } = await runSubmit(argv);

  assert.ok(error instanceof Error, "Expected an error to be thrown");
  assert.ok(
    /--packet-id/i.test(error.message),
    `Expected '--packet-id' in error message, got: ${error.message}`,
  );
});
