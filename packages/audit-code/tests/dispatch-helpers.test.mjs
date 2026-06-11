import test from "node:test";
import assert from "node:assert/strict";

const {
  filterPackets,
  buildPacketPrompt,
  buildTaskSections,
  collectOversizedWarnings,
} = await import("../src/cli/dispatch.ts");

// ── filterPackets ─────────────────────────────────────────────────────────────

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
  };
}

function makeSessionConfig(overrides = {}) {
  return { dispatch: { canary: true, ...overrides } };
}

test("filterPackets — canary fires only on first contact when multiple packets exist", () => {
  const packets = [makePacket("p1"), makePacket("p2"), makePacket("p3")];

  // First contact (priorDispatchThisRun=false), canary ON, multiple packets → canary
  const r1 = filterPackets(packets, false, makeSessionConfig());
  assert.equal(r1.phase, "canary");
  assert.equal(r1.emitPackets.length, 1);
  assert.equal(r1.deferredPackets.length, 0);
  assert.equal(r1.doCanary, true);

  // After first dispatch (priorDispatchThisRun=true) → fan_out
  const r2 = filterPackets(packets, true, makeSessionConfig());
  assert.equal(r2.phase, "fan_out");
  assert.equal(r2.emitPackets.length, 3);
  assert.equal(r2.doCanary, false);

  // canary=false skips canary even on first contact
  const r3 = filterPackets(packets, false, makeSessionConfig({ canary: false }));
  assert.equal(r3.phase, "fan_out");
  assert.equal(r3.doCanary, false);

  // Single packet: canary is skipped regardless of firstContact
  const single = [makePacket("p1")];
  const r4 = filterPackets(single, false, makeSessionConfig());
  assert.equal(r4.phase, "fan_out");
  assert.equal(r4.doCanary, false);
});

test("filterPackets — budget cap slices emitPackets and populates deferredPackets", () => {
  const packets = ["p1", "p2", "p3", "p4", "p5"].map((id) => makePacket(id));

  // max_packets=2 → emit first 2, defer remaining 3
  const r1 = filterPackets(packets, true, makeSessionConfig({ max_packets: 2 }));
  assert.equal(r1.emitPackets.length, 2);
  assert.equal(r1.deferredPackets.length, 3);

  // max_packets=0 → emit nothing, defer all
  const r2 = filterPackets(packets, true, makeSessionConfig({ max_packets: 0 }));
  assert.equal(r2.emitPackets.length, 0);
  assert.equal(r2.deferredPackets.length, 5);

  // max_packets >= length → no deferral
  const r3 = filterPackets(packets, true, makeSessionConfig({ max_packets: 10 }));
  assert.equal(r3.deferredPackets.length, 0);
  assert.equal(r3.emitPackets.length, 5);

  // Budget cap + first contact + multiple packets: canary takes precedence → 1 packet emitted
  const r4 = filterPackets(packets, false, makeSessionConfig({ max_packets: 2 }));
  assert.equal(r4.emitPackets.length, 1, "canary wins: only 1 packet emitted");
  assert.equal(r4.doCanary, true);
});

// ── buildPacketPrompt ─────────────────────────────────────────────────────────

function makeAuditTask(id) {
  return {
    task_id: `task-${id}`,
    unit_id: `unit-${id}`,
    pass_id: `pass:correctness`,
    lens: "correctness",
    file_paths: [`src/${id}.ts`],
    file_line_counts: { [`src/${id}.ts`]: 50 },
    rationale: "check the logic",
    priority: "medium",
    tags: [],
  };
}

test("buildPacketPrompt — assembles expected prompt sections", () => {
  const packet = makePacket("abc");
  const packetTasks = [makeAuditTask("abc")];
  const fileList = "- src/abc.ts (100 lines)";
  const taskSections = ["### task-abc", "unit_id: unit-abc"];
  const resultPath = "/artifacts/runs/run-1/task-results/abc-inline-result.json";

  const prompt = buildPacketPrompt({ packet, packetTasks, fileList, largeFileSection: [], taskSections, resultPath });

  assert.ok(typeof prompt === "string");
  assert.match(prompt, /packet_id: abc/);
  assert.match(prompt, /result_path:/);
  assert.match(prompt, /Repository root:/);
  assert.match(prompt, /Set the shell\/tool workdir to the repository root/i);
  assert.doesNotMatch(prompt, /submit-packet/, "prompt must NOT contain submit-packet");
  assert.ok(prompt.includes(fileList));
  assert.ok(prompt.includes("### task-abc"));
  assert.match(prompt, /do not pipe an inline foreach statement directly into ConvertTo-Json/i);
  assert.match(prompt, /Assign the foreach output to a variable first/i);
  assert.match(prompt, /unwraps single-element arrays/i);
  assert.doesNotMatch(prompt, /current working directory/);
  assert.match(prompt, /valid: abc, findings=/);
});

test("N-A06: buildPacketPrompt — instructs inline emit, includes result_path, no submit-packet command", () => {
  const packet = makePacket("abc");
  const packetTasks = [makeAuditTask("abc")];
  const fileList = "- src/abc.ts (100 lines)";
  const taskSections = ["### task-abc"];
  const resultPath = "/artifacts/runs/run-1/task-results/abc-inline-result.json";

  const prompt = buildPacketPrompt({ packet, packetTasks, fileList, largeFileSection: [], taskSections, resultPath });

  // No submit-packet shell command
  assert.doesNotMatch(prompt, /submit-packet/, "prompt must NOT contain submit-packet");
  assert.doesNotMatch(prompt, /Get-Content.*\|.*&/, "prompt must NOT contain PowerShell Get-Content pipe workaround");

  // result_path is present
  assert.ok(prompt.includes(resultPath), "prompt must include the result_path value");
  assert.match(prompt, /result_path:/, "prompt must have result_path field in header");

  // Inline emit instruction
  assert.match(prompt, /emit.*inline/i, "prompt must instruct worker to emit inline");
  assert.match(prompt, /skill captures/i, "prompt must state skill captures the payload");

  // Still forbids ad-hoc writes
  assert.match(prompt, /Do not write files/i, "prompt must still forbid ad-hoc file writes");
});

// ── buildTaskSections ─────────────────────────────────────────────────────────

function makeLensDefs() {
  return {
    correctness: { description: "Check for correctness bugs.", do_not_report: "style issues" },
  };
}

test("buildTaskSections — produces one section per task with correct fields", () => {
  const tasks = [makeAuditTask("t1"), makeAuditTask("t2")];
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50, "src/t2.ts": 50 };

  const sections = buildTaskSections(tasks, lensDefs, lineIndex);
  const joined = sections.join("\n");

  assert.match(joined, /### task-t1/);
  assert.match(joined, /### task-t2/);
  assert.match(joined, /unit_id: unit-t1/);
  assert.match(joined, /pass_id: pass:correctness/);
  assert.match(joined, /lens: correctness/);
});

test("buildTaskSections — uses lens name as fallback when lensDef is missing", () => {
  const task = { ...makeAuditTask("t1"), lens: "security" };
  const lensDefs = {}; // no entry for "security"
  const lineIndex = { "src/t1.ts": 50 };

  const sections = buildTaskSections([task], lensDefs, lineIndex);
  const joined = sections.join("\n");

  assert.match(joined, /Lens guidance: security/);
  assert.match(joined, /Do NOT report: N\/A/);
});

test("buildTaskSections — lens_verification tasks include the verification mode instruction block", () => {
  const task = { ...makeAuditTask("t1"), tags: ["lens_verification"] };
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };

  const sections = buildTaskSections([task], lensDefs, lineIndex);
  const joined = sections.join("\n");

  assert.match(joined, /Lens verification mode/);
  assert.match(joined, /Return findings: \[\]/);
});

test("buildTaskSections — coverageTemplate JSON is embedded verbatim", () => {
  const task = makeAuditTask("t1");
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };

  const sections = buildTaskSections([task], lensDefs, lineIndex);
  const joined = sections.join("\n");

  assert.ok(
    joined.includes(JSON.stringify([{ path: "src/t1.ts", total_lines: 50 }])),
    "coverage template JSON should be embedded verbatim",
  );
});

// ── collectOversizedWarnings ──────────────────────────────────────────────────

function makeWaveSchedule(confidence, contextTokens = 10000, outputTokens = 2000) {
  return {
    confidence,
    resolved_limits: { context_tokens: contextTokens, output_tokens: outputTokens },
  };
}

function makePlanEntry(packetId, estimatedTokens) {
  return {
    packet_id: packetId,
    complexity: { estimated_tokens: estimatedTokens, priority: "medium", task_count: 1, file_count: 1, total_lines: 100, lenses: ["correctness"], tags: [], large_file_mode: false },
  };
}

test("collectOversizedWarnings — returns empty array when confidence is 'low'", () => {
  const plan = [makePlanEntry("p1", 99999)];
  const warnings = collectOversizedWarnings(plan, makeWaveSchedule("low"));
  assert.deepEqual(warnings, []);
});

test("collectOversizedWarnings — emits warning when packet estimated_tokens exceed context budget", () => {
  const contextBudget = 10000 - 2000; // 8000
  const plan = [makePlanEntry("p1", 9000), makePlanEntry("p2", 100)];
  const warnings = collectOversizedWarnings(plan, makeWaveSchedule("high"));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "oversized_packet");
  assert.match(warnings[0].message, /p1/);
  assert.match(warnings[0].message, new RegExp(String(9000)));
  assert.match(warnings[0].message, new RegExp(String(contextBudget)));
});

test("collectOversizedWarnings — returns empty array when all packets are within budget", () => {
  const plan = [makePlanEntry("p1", 100), makePlanEntry("p2", 200)];
  const warnings = collectOversizedWarnings(plan, makeWaveSchedule("medium"));
  assert.deepEqual(warnings, []);
});
