import { test, onTestFinished, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import via the tsx source-import pattern (same as dispatch-features.test.mjs
// and dispatch-fanout.test.mjs) — no compiled dist required.
const { cmdSubmitPacket } = await import("../../src/audit/cli/submitPacketCommand.ts");

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

  // Ensure task-results exists before writing any pre-existing result files.
  await mkdir(join(runDir, "task-results"), { recursive: true });

  // Add entries for other packets
  for (const other of otherPacketResults) {
    entries.push({
      packet_id: other.packetId,
      task_id: other.taskId,
      result_path: join(runDir, "task-results", `${other.taskId}.json`),
    });
    // Write the pre-existing result file
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
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit with wrong case and surrounding whitespace
  const weirdId = `  ${PACKET_ID.toUpperCase()}  `;
  const payload = [makeResult(task)];
  const argv = makeArgv(artifactsDir, weirdId, payload);

  const { stdout, stderr, error } = await runSubmit(argv);

  expect(error, `Should not throw; got: ${error?.message}`).toBe(null);
  expect(stderr.includes("normalization") || stderr.includes("Resolved"), `Expected normalization warning in stderr, got: ${stderr}`).toBeTruthy();
  expect(stdout.length > 0, "Expected JSON output on stdout").toBeTruthy();
  // The resolved packet_id in the output JSON must match the canonical (un-normalized) value
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.packet_id, `Expected canonical packet_id '${PACKET_ID}' in output, got '${parsed.packet_id}'`).toBe(PACKET_ID);
});

// ── 2. Unknown packet-id ───────────────────────────────────────────────────────

await test("unknown packet-id throws with valid id list", async (t) => {
  const task = makeTask("task-unk-1");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const argv = makeArgv(artifactsDir, "completely-unknown-id", [makeResult(task)]);
  const { error } = await runSubmit(argv);

  expect(error instanceof Error, "Expected an error to be thrown").toBeTruthy();
  expect(error.message.includes("Valid packet IDs"), `Expected 'Valid packet IDs' in error message, got: ${error.message}`).toBeTruthy();
});

// ── 3. Duplicate task_id in payload ───────────────────────────────────────────

await test("duplicate task_id in payload is rejected", async (t) => {
  const task = makeTask("task-dup-1");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const result = makeResult(task);
  // Submit the same result twice → duplicate task_id
  const argv = makeArgv(artifactsDir, PACKET_ID, [result, result]);
  const { error } = await runSubmit(argv);

  expect(error instanceof Error, "Expected an error to be thrown").toBeTruthy();
  expect(error.message.includes(task.task_id) ||
      error.message.toLowerCase().includes("duplicate"), `Expected duplicate mention in error message, got: ${error.message}`).toBeTruthy();
});

// ── 4. Unassigned task_id in payload ──────────────────────────────────────────

await test("unassigned task_id in payload is rejected", async (t) => {
  const task = makeTask("task-assigned-1");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit a result with a task_id that is NOT in the packet's assigned list
  const unassignedResult = makeResult(makeTask("task-NOT-in-packet"));
  const assignedResult = makeResult(task);
  const argv = makeArgv(artifactsDir, PACKET_ID, [assignedResult, unassignedResult]);
  const { error } = await runSubmit(argv);

  expect(error instanceof Error, "Expected an error to be thrown").toBeTruthy();
  expect(error.message.includes("task-NOT-in-packet") ||
      error.message.toLowerCase().includes("not assigned"), `Expected task_id or 'not assigned' in error, got: ${error.message}`).toBeTruthy();
});

// ── 5. Missing assigned task in payload ───────────────────────────────────────

await test("missing assigned task in payload is rejected", async (t) => {
  const task1 = makeTask("task-miss-1");
  const task2 = makeTask("task-miss-2");
  const { artifactsDir } = await makeArtifactsDir({
    tasks: [task1, task2],
    packetTaskIds: [task1.task_id, task2.task_id],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit only task1, omitting task2
  const argv = makeArgv(artifactsDir, PACKET_ID, [makeResult(task1)]);
  const { error } = await runSubmit(argv);

  expect(error instanceof Error, "Expected an error to be thrown").toBeTruthy();
  expect(error.message.includes(task2.task_id), `Expected missing task_id ${task2.task_id} in error, got: ${error.message}`).toBeTruthy();
});

// ── 6. Cross-packet duplicate-finding: submit-packet does NOT warn (handled at merge-and-ingest) ─

await test("cross-packet duplicate finding does NOT emit a warning at submit time (dedup is at merge-and-ingest)", async (t) => {
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
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit a result for pkt-alpha that contains the same finding key.
  // submit-packet no longer performs cross-packet dedup scanning — that
  // responsibility moved to merge-and-ingest where all results are available.
  const newResult = {
    ...makeResult(task1),
    findings: [
      { ...duplicateFinding, id: "DUP-002" },
    ],
  };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stdout, stderr, error } = await runSubmit(argv);

  expect(error, `Should not throw; got: ${error?.message}`).toBe(null);
  // No cross-packet dedup warning at submit time
  expect(!stderr.toLowerCase().includes("duplicate"), `Did not expect cross-packet duplicate warning in stderr at submit time, got: ${stderr}`).toBeTruthy();
  // No duplicate_warning_count in stdout
  const parsedOut = JSON.parse(stdout.trim());
  expect(parsedOut.duplicate_warning_count, `Expected no duplicate_warning_count in output, got: ${JSON.stringify(parsedOut)}`).toBe(undefined);
  // Result files should still be written
  const resultPath = join(runDir, "task-results", `${task1.task_id}.json`);
  const written = JSON.parse(await readFile(resultPath, "utf8"));
  expect(written.task_id).toBe(task1.task_id);
});

// ── 7. Happy path — persistence gate ──────────────────────────────────────────

await test("happy path writes per-task result files and outputs accepted count", async (t) => {
  const task1 = makeTask("task-happy-1");
  const task2 = makeTask("task-happy-2", "unit-2");
  const { artifactsDir, runDir } = await makeArtifactsDir({
    tasks: [task1, task2],
    packetTaskIds: [task1.task_id, task2.task_id],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const payload = [makeResult(task1), makeResult(task2)];
  const argv = makeArgv(artifactsDir, PACKET_ID, payload);
  const { stdout, error } = await runSubmit(argv);

  expect(error, `Should not throw; got: ${error?.message}`).toBe(null);

  // Each task should have a result file written
  for (const task of [task1, task2]) {
    const resultPath = join(runDir, "task-results", `${task.task_id}.json`);
    const written = JSON.parse(await readFile(resultPath, "utf8"));
    expect(written.task_id).toBe(task.task_id);
  }

  // stdout should be valid JSON with the expected fields
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.run_id).toBe(RUN_ID);
  expect(parsed.packet_id).toBe(PACKET_ID);
  expect(parsed.accepted_count).toBe(2);
  expect(typeof parsed.finding_count).toBe("number");
});

// -- 8. Happy path stamps run metadata ----------------------------------------

await test("happy path stamps run_id and one submitted_at value on each result", async (t) => {
  const task1 = makeTask("task-stamp-1");
  const task2 = makeTask("task-stamp-2", "unit-2");
  const { artifactsDir, runDir } = await makeArtifactsDir({
    tasks: [task1, task2],
    packetTaskIds: [task1.task_id, task2.task_id],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const payload = [makeResult(task1), makeResult(task2)];
  const argv = makeArgv(artifactsDir, PACKET_ID, payload);
  const { error } = await runSubmit(argv);

  expect(error, `Should not throw; got: ${error?.message}`).toBe(null);

  const writtenResults = [];
  for (const task of [task1, task2]) {
    const resultPath = join(runDir, "task-results", `${task.task_id}.json`);
    writtenResults.push(JSON.parse(await readFile(resultPath, "utf8")));
  }

  const submittedAtValues = new Set(writtenResults.map((result) => result.submitted_at));
  expect(submittedAtValues.size, "all files should share one submitted_at value").toBe(1);
  const submittedAt = writtenResults[0].submitted_at;
  expect(typeof submittedAt).toBe("string");
  expect(new Date(submittedAt).toISOString()).toBe(submittedAt);

  for (const [index, written] of writtenResults.entries()) {
    const original = payload[index];
    expect(written.run_id).toBe(RUN_ID);
    expect(written.task_id).toBe(original.task_id);
    expect(written.unit_id).toBe(original.unit_id);
    expect(written.pass_id).toBe(original.pass_id);
    expect(written.lens).toBe(original.lens);
    expect(written.file_coverage).toEqual(original.file_coverage);
    expect(written.findings).toEqual(original.findings);
  }
});

// ── 8. findingKey dedup: cross-packet dedup is handled at merge-and-ingest ─────
//
// submit-packet no longer scans prior result files for duplicate findings —
// that responsibility moved to merge-and-ingest where all results are available
// in memory for an accurate full-run dedup pass. These tests verify submit-packet
// accepts without any cross-packet duplicate warning regardless of other packets.

await test("findingKey dedup: same finding in two packets is accepted without warning at submit time", async (t) => {
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
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit same finding (different id, same key fields) in pkt-alpha.
  // No cross-packet dedup warning expected at submit time.
  const newResult = { ...makeResult(task1), findings: [{ ...sharedFinding, id: "FK-002" }] };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stdout, stderr, error } = await runSubmit(argv);

  expect(error, `Should not throw; got: ${error?.message}`).toBe(null);
  expect(!stderr.toLowerCase().includes("duplicate"), `Did not expect cross-packet duplicate warning at submit time, got: ${stderr}`).toBeTruthy();
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.duplicate_warning_count, `Expected no duplicate_warning_count in output, got: ${JSON.stringify(parsed)}`).toBe(undefined);
});

await test("findingKey dedup: finding differing in any key field is NOT a duplicate (submit-packet never warns either way)", async (t) => {
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
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Finding differs only in affected_files path
  const newResult = {
    ...makeResult(task1),
    findings: [{ ...baseFinding, id: "FK-DIFF-002", affected_files: [{ path: "src/other.ts" }] }],
  };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stdout, stderr, error } = await runSubmit(argv);

  expect(error, `Should not throw; got: ${error?.message}`).toBe(null);
  // No cross-packet warning expected (submit-packet delegates this to merge-and-ingest)
  expect(!stderr.toLowerCase().includes("duplicate"), `Did not expect any duplicate warning at submit time, got: ${stderr}`).toBeTruthy();
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.duplicate_warning_count).toBe(undefined);
});

// ── 10b. COR-d31ca6b5: cross-packet dedup is at merge-and-ingest, not submit-packet ─
//
// The original COR-d31ca6b5 fix moved the array-expansion logic to submit-packet.
// That responsibility has since moved to merge-and-ingest where warnOnDuplicateFindings
// operates on the in-memory passing[] list — no file scanning needed. This test
// verifies submit-packet still accepts without cross-packet dedup interference.

await test("submit-packet accepts without warning even when prior result is array-format (dedup is at merge-and-ingest)", async (t) => {
  const task1 = makeTaskCovering("task-arrdup-1", "src/shared.ts");
  const dupFinding = {
    id: "ARR-DUP-001",
    title: "Array-Wrapped Finding",
    lens: "security",
    category: "Injection",
    severity: "high",
    confidence: "high",
    summary: "Found via array-format prior result.",
    affected_files: [{ path: "src/shared.ts" }],
    evidence: ["src/shared.ts:1 - evidence"],
  };

  const otherTask = makeTaskCovering("task-arrdup-other", "src/shared.ts");
  // Prior result is an AuditResult[] array — submit-packet no longer reads it.
  const priorResultArray = [{ ...makeResult(otherTask), findings: [dupFinding] }];

  const { artifactsDir } = await makeArtifactsDir({
    tasks: [task1, otherTask],
    packetTaskIds: [task1.task_id],
    otherPacketResults: [
      { packetId: "pkt-arr-other", taskId: otherTask.task_id, result: priorResultArray },
    ],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // Submit a result for pkt-alpha containing the same finding key.
  // No cross-packet dedup at submit time — this is now merge-and-ingest's concern.
  const newResult = { ...makeResult(task1), findings: [{ ...dupFinding, id: "ARR-DUP-002" }] };
  const argv = makeArgv(artifactsDir, PACKET_ID, [newResult]);
  const { stdout, stderr, error } = await runSubmit(argv);

  expect(error, `Should not throw; got: ${error?.message}`).toBe(null);
  expect(!stderr.toLowerCase().includes("duplicate"), `Did not expect cross-packet duplicate warning at submit time, got: ${stderr}`).toBeTruthy();
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.duplicate_warning_count, `Expected no duplicate_warning_count in output, got: ${JSON.stringify(parsed)}`).toBe(undefined);
});

// ── 11. Missing --run-id flag ─────────────────────────────────────────────────

await test("throws when --run-id is missing", async (t) => {
  const task = makeTask("task-no-runid");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

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

  expect(error instanceof Error, "Expected an error to be thrown").toBeTruthy();
  expect(/--run-id/i.test(error.message), `Expected '--run-id' in error message, got: ${error.message}`).toBeTruthy();
});

// ── 12. Missing --packet-id flag ─────────────────────────────────────────────

await test("throws when --packet-id is missing", async (t) => {
  const task = makeTask("task-no-packetid");
  const { artifactsDir } = await makeArtifactsDir({ tasks: [task] });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

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

  expect(error instanceof Error, "Expected an error to be thrown").toBeTruthy();
  expect(/--packet-id/i.test(error.message), `Expected '--packet-id' in error message, got: ${error.message}`).toBeTruthy();
});

// ── 13. F-6: packet/unit boundary widens the file_coverage hard-reject gate ────
//
// Both packet tasks are assigned to PACKET_ID, so the packet boundary is the
// union { src/task-bound-a.ts, src/task-bound-b.ts }. A result for task A that
// declares coverage of task B's file (unassigned to A, but in-boundary) must be
// ACCEPTED rather than hard-rejected — the boundary is computed by the real
// submit-packet path, not hand-injected. An out-of-boundary file must still be
// hard-rejected.

await test("F-6: file_coverage of an in-boundary (sibling-assigned) file is accepted", async (t) => {
  const taskA = makeTaskCovering("task-bound-a", "src/task-bound-a.ts", "correctness");
  const taskB = makeTaskCovering("task-bound-b", "src/task-bound-b.ts", "correctness", "unit-2");
  const { artifactsDir, runDir } = await makeArtifactsDir({
    tasks: [taskA, taskB],
    packetTaskIds: [taskA.task_id, taskB.task_id],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // taskA's result declares coverage of BOTH its own file and taskB's file.
  // taskB's file is unassigned to taskA but lives inside the packet boundary.
  const resultA = {
    ...makeResult(taskA),
    file_coverage: [
      { path: "src/task-bound-a.ts", total_lines: 50 },
      { path: "src/task-bound-b.ts", total_lines: 50 },
    ],
  };
  const resultB = makeResult(taskB);

  const argv = makeArgv(artifactsDir, PACKET_ID, [resultA, resultB]);
  const { stdout, error } = await runSubmit(argv);

  expect(error, `In-boundary coverage should be accepted; got: ${error?.message}`).toBe(null);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.accepted_count).toBe(2);
  // Result files still written.
  const written = JSON.parse(
    await readFile(join(runDir, "task-results", `${taskA.task_id}.json`), "utf8"),
  );
  expect(written.task_id).toBe(taskA.task_id);
});

await test("F-6: file_coverage of an out-of-boundary file is still hard-rejected", async (t) => {
  const taskA = makeTaskCovering("task-oob-a", "src/task-oob-a.ts", "correctness");
  const taskB = makeTaskCovering("task-oob-b", "src/task-oob-b.ts", "correctness", "unit-2");
  const { artifactsDir } = await makeArtifactsDir({
    tasks: [taskA, taskB],
    packetTaskIds: [taskA.task_id, taskB.task_id],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  // taskA declares coverage of a file NOT assigned to any sibling in the packet.
  const resultA = {
    ...makeResult(taskA),
    file_coverage: [
      { path: "src/task-oob-a.ts", total_lines: 50 },
      { path: "src/totally-outside.ts", total_lines: 50 },
    ],
  };
  const resultB = makeResult(taskB);

  const argv = makeArgv(artifactsDir, PACKET_ID, [resultA, resultB]);
  const { error } = await runSubmit(argv);

  expect(error instanceof Error, "Out-of-boundary coverage must be rejected").toBeTruthy();
  expect(error.message.includes("src/totally-outside.ts"), `Expected out-of-boundary path in error, got: ${error.message}`).toBeTruthy();
});

// ── 14. F-6: boundary widens the verification.followup_tasks.file_paths gate ───

function makeLensVerificationTask(taskId, path, unitId = "unit-1") {
  return {
    ...makeTaskCovering(taskId, path, "correctness", unitId),
    tags: ["lens_verification"],
  };
}

await test("F-6: followup_tasks targeting an in-boundary file is accepted", async (t) => {
  // Verification task A is tagged lens_verification; its followup may target a
  // file assigned to sibling task B (in-boundary) without a hard reject.
  const taskA = makeLensVerificationTask("task-fu-a", "src/fu-a.ts");
  const taskB = makeTaskCovering("task-fu-b", "src/fu-b.ts", "correctness", "unit-2");
  const { artifactsDir } = await makeArtifactsDir({
    tasks: [taskA, taskB],
    packetTaskIds: [taskA.task_id, taskB.task_id],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const resultA = {
    ...makeResult(taskA),
    verification: {
      verified: true,
      needs_followup: true,
      followup_tasks: [
        {
          task_id: "followup-fu-1",
          unit_id: "unit-1",
          pass_id: "pass:correctness",
          lens: "correctness",
          rationale: "cross-cutting concern surfaced in the packet",
          priority: "medium",
          file_paths: ["src/fu-b.ts"],
        },
      ],
    },
  };
  const resultB = makeResult(taskB);

  const argv = makeArgv(artifactsDir, PACKET_ID, [resultA, resultB]);
  const { stdout, error } = await runSubmit(argv);

  expect(error, `In-boundary followup file should be accepted; got: ${error?.message}`).toBe(null);
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.accepted_count).toBe(2);
});

await test("F-6: followup_tasks targeting an out-of-boundary file is still hard-rejected", async (t) => {
  const taskA = makeLensVerificationTask("task-fuoob-a", "src/fuoob-a.ts");
  const taskB = makeTaskCovering("task-fuoob-b", "src/fuoob-b.ts", "correctness", "unit-2");
  const { artifactsDir } = await makeArtifactsDir({
    tasks: [taskA, taskB],
    packetTaskIds: [taskA.task_id, taskB.task_id],
  });
  onTestFinished(() => rm(artifactsDir, { recursive: true, force: true }));

  const resultA = {
    ...makeResult(taskA),
    verification: {
      verified: true,
      needs_followup: true,
      followup_tasks: [
        {
          task_id: "followup-oob-1",
          unit_id: "unit-1",
          pass_id: "pass:correctness",
          lens: "correctness",
          rationale: "out of the packet boundary",
          priority: "medium",
          file_paths: ["src/way-outside.ts"],
        },
      ],
    },
  };
  const resultB = makeResult(taskB);

  const argv = makeArgv(artifactsDir, PACKET_ID, [resultA, resultB]);
  const { error } = await runSubmit(argv);

  expect(error instanceof Error, "Out-of-boundary followup file must be rejected").toBeTruthy();
  expect(error.message.includes("src/way-outside.ts"), `Expected out-of-boundary followup path in error, got: ${error.message}`).toBeTruthy();
});
