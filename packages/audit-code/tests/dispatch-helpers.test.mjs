import test from "node:test";
import assert from "node:assert/strict";

const {
  filterPackets,
  buildPacketPrompt,
  buildTaskSections,
  collectOversizedWarnings,
  resolveTierBudgets,
} = await import("../src/cli/dispatch.ts");
const { renderRollingDispatchPrompt } = await import("../src/cli/prompts.ts");

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
  return { dispatch: { ...overrides } };
}

test("filterPackets — all packets emitted when no budget cap", () => {
  const packets = [makePacket("p1"), makePacket("p2"), makePacket("p3")];

  const r1 = filterPackets(packets, makeSessionConfig());
  assert.equal(r1.emitPackets.length, 3);
  assert.equal(r1.deferredPackets.length, 0);
});

test("filterPackets — budget cap slices emitPackets and populates deferredPackets", () => {
  const packets = ["p1", "p2", "p3", "p4", "p5"].map((id) => makePacket(id));

  // max_packets=2 → emit first 2, defer remaining 3
  const r1 = filterPackets(packets, makeSessionConfig({ max_packets: 2 }));
  assert.equal(r1.emitPackets.length, 2);
  assert.equal(r1.deferredPackets.length, 3);

  // max_packets=0 → emit nothing, defer all
  const r2 = filterPackets(packets, makeSessionConfig({ max_packets: 0 }));
  assert.equal(r2.emitPackets.length, 0);
  assert.equal(r2.deferredPackets.length, 5);

  // max_packets >= length → no deferral
  const r3 = filterPackets(packets, makeSessionConfig({ max_packets: 10 }));
  assert.equal(r3.deferredPackets.length, 0);
  assert.equal(r3.emitPackets.length, 5);

  // Budget cap + multiple packets: only cap applies
  const r4 = filterPackets(packets, makeSessionConfig({ max_packets: 2 }));
  assert.equal(r4.emitPackets.length, 2);
  assert.equal(r4.deferredPackets.length, 3);
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

test("N-worker-prompt-and-result-contract: buildPacketPrompt — writes to result_path, requires quoted_text, no submit-packet command", () => {
  const packet = makePacket("abc");
  const packetTasks = [makeAuditTask("abc")];
  const fileList = "- src/abc.ts (100 lines)";
  const taskSections = ["### task-abc"];
  const resultPath = "/artifacts/runs/run-1/task-results/abc-inline-result.json";

  const prompt = buildPacketPrompt({ packet, packetTasks, fileList, largeFileSection: [], taskSections, resultPath });

  // No submit-packet shell command
  assert.doesNotMatch(prompt, /submit-packet/, "prompt must NOT contain submit-packet");
  assert.doesNotMatch(prompt, /Get-Content.*\|.*&/, "prompt must NOT contain PowerShell Get-Content pipe workaround");

  // result_path is present and the worker is told to WRITE it (not emit inline)
  assert.ok(prompt.includes(resultPath), "prompt must include the result_path value");
  assert.match(prompt, /result_path:/, "prompt must have result_path field in header");
  assert.match(
    prompt,
    /WRITE that array[\s\S]*to your result_path/i,
    "prompt must instruct the worker to write the array to result_path",
  );

  // Must NOT forbid writes or instruct inline-only emission (the data-loss bug)
  assert.doesNotMatch(prompt, /Do not write files/i, "prompt must NOT forbid file writes");
  assert.doesNotMatch(prompt, /emit it INLINE/i, "prompt must NOT instruct inline-only emission");
  assert.doesNotMatch(prompt, /skill captures/i, "prompt must NOT defer capture to a skill");

  // quoted_text grounding is effectively mandatory (the 174-ungrounded root cause)
  assert.match(prompt, /quoted_text/, "prompt must reference quoted_text in the finding schema");
  assert.match(
    prompt,
    /Grounding \(required\)/i,
    "prompt must include a required grounding instruction",
  );
});

// ── step-prompt ↔ packet-prompt result contract (no drift) ─────────────────────

test("N-worker-prompt-and-result-contract: rolling-dispatch step prompt and packet prompt agree the worker WRITES its result_path", () => {
  // The headline self-audit bug was a drift: the rolling-dispatch step prompt
  // told the host each worker writes its AuditResult[] to result_path, while the
  // generated worker packet prompt forbade writes and demanded inline JSON — so
  // reviewers wrote nothing and results were lost. This contract test fails if
  // either side regresses to the inline-only / forbid-writes contract.
  const stepPrompt = renderRollingDispatchPrompt({
    root: "/repo",
    artifactsDir: "/repo/.audit-tools/audit",
    runId: "run-1",
    dispatchPlanPath: "/repo/.audit-tools/audit/runs/run-1/dispatch-plan.json",
    dispatchQuotaPath: "/repo/.audit-tools/audit/runs/run-1/dispatch-quota.json",
    hostCanRestrictSubagentTools: true,
    hostCanSelectSubagentModel: false,
  });
  const resultPath = "/repo/.audit-tools/audit/runs/run-1/task-results/abc-inline-result.json";
  const packetPrompt = buildPacketPrompt({
    packet: makePacket("abc"),
    packetTasks: [makeAuditTask("abc")],
    fileList: "- src/abc.ts (100 lines)",
    largeFileSection: [],
    taskSections: ["### task-abc"],
    resultPath,
  });

  // Step prompt side: workers write their own result_path; pre-approval grants
  // write to that path; no "they do not write files" contradiction.
  assert.match(
    stepPrompt,
    /writes? its own AuditResult\[\] (JSON )?array to its assigned\s+`entry\.result_path`/i,
    "step prompt must state workers write to entry.result_path",
  );
  assert.match(
    stepPrompt,
    /grant write access to that subagent's `entry\.result_path`/i,
    "step prompt pre-approval must grant write to entry.result_path",
  );
  assert.doesNotMatch(
    stepPrompt,
    /read-only; they do not write files/i,
    "step prompt must not say workers are read-only / do not write files",
  );

  // Packet prompt side: the worker is told to WRITE the same result_path and is
  // never told to emit inline or forbidden from writing.
  assert.match(
    packetPrompt,
    /WRITE that array[\s\S]*to your result_path/i,
    "packet prompt must instruct the worker to write to result_path",
  );
  assert.doesNotMatch(packetPrompt, /emit it INLINE/i, "packet prompt must not instruct inline emission");
  assert.doesNotMatch(packetPrompt, /Do not write files/i, "packet prompt must not forbid file writes");
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

// ── resolveTierBudgets (COR-0e031ac0) ─────────────────────────────────────────

test("resolveTierBudgets — direct entries survive unchanged", () => {
  const perRank = new Map([["small", 1000], ["standard", 2000], ["deep", 4000]]);
  const out = resolveTierBudgets(perRank);
  assert.equal(out.small, 1000);
  assert.equal(out.standard, 2000);
  assert.equal(out.deep, 4000);
});

test("resolveTierBudgets — missing tier falls back to lower rank (not higher) when both equidistant", () => {
  // Only 'small' and 'deep' reported; 'standard' is equidistant from both.
  // Must prefer 'small' (lower / less capable) to avoid over-budgeting (COR-0e031ac0).
  const perRank = new Map([["small", 1000], ["deep", 4000]]);
  const out = resolveTierBudgets(perRank);
  assert.equal(out.standard, 1000, "standard should inherit from small (lower tier), not deep (higher tier)");
});

test("resolveTierBudgets — missing 'small' takes the nearest lower rank and does not inherit deep (COR-0e031ac0)", () => {
  // Only 'standard' and 'deep' reported. 'small' has no lower neighbour, so it
  // must take the nearest LOWER reported tier. Since only 'standard' is lower (i=0,
  // distance=1: up=standard, down=none — actually 'standard' is higher than 'small'),
  // in practice 'small' must fall back to 'standard' (the nearest reported).
  // Critical assertion: it must NOT take 'deep' budget when 'standard' is available.
  const perRank = new Map([["standard", 2000], ["deep", 4000]]);
  const out = resolveTierBudgets(perRank);
  // 'small' is below 'standard'; nearest is 'standard' (up at distance 1). It should
  // prefer down first, but there is no lower rank, so it must use 'standard', NOT 'deep'.
  assert.equal(out.small, 2000, "small must use standard's budget (not deep's) when standard is the nearest reported");
  assert.notEqual(out.small, 4000, "small must NOT inherit deep's over-sized budget");
});

test("resolveTierBudgets — missing 'deep' takes the nearest higher rank (standard, not small)", () => {
  // Only 'small' and 'standard' reported. 'deep' has no upper neighbour; it
  // should take the nearest lower = 'standard', NOT 'small'.
  const perRank = new Map([["small", 1000], ["standard", 2000]]);
  const out = resolveTierBudgets(perRank);
  assert.equal(out.deep, 2000, "deep should fall back to standard (nearest), not small");
});

test("resolveTierBudgets — throws on empty map", () => {
  assert.throws(() => resolveTierBudgets(new Map()), /requires at least one/);
});
