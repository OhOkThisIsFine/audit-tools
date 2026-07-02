import { test, expect } from "vitest";
import assert from "node:assert/strict";

const {
  filterPackets,
  buildPacketPrompt,
  buildTaskSections,
  collectOversizedWarnings,
  resolveTierBudgets,
} = await import("../../src/audit/cli/dispatch.ts");
const { renderRollingDispatchPrompt } = await import("../../src/audit/cli/prompts.ts");
const { buildAnalyzerSignalAnchorIndex } = await import(
  "../../src/audit/orchestrator/fileAnchors.ts"
);

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
  expect(r1.emitPackets.length).toBe(3);
  expect(r1.deferredPackets.length).toBe(0);
});

test("filterPackets — budget cap slices emitPackets and populates deferredPackets", () => {
  const packets = ["p1", "p2", "p3", "p4", "p5"].map((id) => makePacket(id));

  // max_packets=2 → emit first 2, defer remaining 3
  const r1 = filterPackets(packets, makeSessionConfig({ max_packets: 2 }));
  expect(r1.emitPackets.length).toBe(2);
  expect(r1.deferredPackets.length).toBe(3);

  // max_packets=0 → emit nothing, defer all
  const r2 = filterPackets(packets, makeSessionConfig({ max_packets: 0 }));
  expect(r2.emitPackets.length).toBe(0);
  expect(r2.deferredPackets.length).toBe(5);

  // max_packets >= length → no deferral
  const r3 = filterPackets(packets, makeSessionConfig({ max_packets: 10 }));
  expect(r3.deferredPackets.length).toBe(0);
  expect(r3.emitPackets.length).toBe(5);

  // Budget cap + multiple packets: only cap applies
  const r4 = filterPackets(packets, makeSessionConfig({ max_packets: 2 }));
  expect(r4.emitPackets.length).toBe(2);
  expect(r4.deferredPackets.length).toBe(3);
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

  expect(typeof prompt === "string").toBeTruthy();
  expect(prompt).toMatch(/packet_id: abc/);
  expect(prompt).toMatch(/result_path:/);
  expect(prompt).toMatch(/Repository root:/);
  expect(prompt).toMatch(/Set the shell\/tool workdir to the repository root/i);
  expect(prompt, "prompt must NOT contain submit-packet").not.toMatch(/submit-packet/);
  expect(prompt.includes(fileList)).toBeTruthy();
  expect(prompt.includes("### task-abc")).toBeTruthy();
  expect(prompt).toMatch(/do not pipe an inline foreach statement directly into ConvertTo-Json/i);
  expect(prompt).toMatch(/Assign the foreach output to a variable first/i);
  expect(prompt).toMatch(/unwraps single-element arrays/i);
  expect(prompt).not.toMatch(/current working directory/);
  expect(prompt).toMatch(/valid: abc, findings=/);
});

test("N-worker-prompt-and-result-contract: buildPacketPrompt — writes to result_path, requires quoted_text, no submit-packet command", () => {
  const packet = makePacket("abc");
  const packetTasks = [makeAuditTask("abc")];
  const fileList = "- src/abc.ts (100 lines)";
  const taskSections = ["### task-abc"];
  const resultPath = "/artifacts/runs/run-1/task-results/abc-inline-result.json";

  const prompt = buildPacketPrompt({ packet, packetTasks, fileList, largeFileSection: [], taskSections, resultPath });

  // No submit-packet shell command
  expect(prompt, "prompt must NOT contain submit-packet").not.toMatch(/submit-packet/);
  expect(prompt, "prompt must NOT contain PowerShell Get-Content pipe workaround").not.toMatch(/Get-Content.*\|.*&/);

  // result_path is present and the worker is told to WRITE it (not emit inline)
  expect(prompt.includes(resultPath), "prompt must include the result_path value").toBeTruthy();
  expect(prompt, "prompt must have result_path field in header").toMatch(/result_path:/);
  expect(prompt, "prompt must instruct the worker to write the array to result_path").toMatch(/WRITE that array[\s\S]*to your result_path/i);

  // Must NOT forbid writes or instruct inline-only emission (the data-loss bug)
  expect(prompt, "prompt must NOT forbid file writes").not.toMatch(/Do not write files/i);
  expect(prompt, "prompt must NOT instruct inline-only emission").not.toMatch(/emit it INLINE/i);
  expect(prompt, "prompt must NOT defer capture to a skill").not.toMatch(/skill captures/i);

  // quoted_text grounding is effectively mandatory (the 174-ungrounded root cause)
  expect(prompt, "prompt must reference quoted_text in the finding schema").toMatch(/quoted_text/);
  expect(prompt, "prompt must include a required grounding instruction").toMatch(/Grounding \(required\)/i);
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
  expect(stepPrompt, "step prompt must state workers write to entry.result_path").toMatch(/writes? its own AuditResult\[\] (JSON )?array to its assigned\s+`entry\.result_path`/i);
  expect(stepPrompt, "step prompt pre-approval must grant write to entry.result_path").toMatch(/grant write access to that subagent's `entry\.result_path`/i);
  expect(stepPrompt, "step prompt must not say workers are read-only / do not write files").not.toMatch(/read-only; they do not write files/i);

  // Packet prompt side: the worker is told to WRITE the same result_path and is
  // never told to emit inline or forbidden from writing.
  expect(packetPrompt, "packet prompt must instruct the worker to write to result_path").toMatch(/WRITE that array[\s\S]*to your result_path/i);
  expect(packetPrompt, "packet prompt must not instruct inline emission").not.toMatch(/emit it INLINE/i);
  expect(packetPrompt, "packet prompt must not forbid file writes").not.toMatch(/Do not write files/i);
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

  expect(joined).toMatch(/### task-t1/);
  expect(joined).toMatch(/### task-t2/);
  expect(joined).toMatch(/unit_id: unit-t1/);
  expect(joined).toMatch(/pass_id: pass:correctness/);
  expect(joined).toMatch(/lens: correctness/);
});

test("buildTaskSections — uses lens name as fallback when lensDef is missing", () => {
  const task = { ...makeAuditTask("t1"), lens: "security" };
  const lensDefs = {}; // no entry for "security"
  const lineIndex = { "src/t1.ts": 50 };

  const sections = buildTaskSections([task], lensDefs, lineIndex);
  const joined = sections.join("\n");

  expect(joined).toMatch(/Lens guidance: security/);
  expect(joined).toMatch(/Do NOT report: N\/A/);
});

test("buildTaskSections — lens_verification tasks include the verification mode instruction block", () => {
  const task = { ...makeAuditTask("t1"), tags: ["lens_verification"] };
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };

  const sections = buildTaskSections([task], lensDefs, lineIndex);
  const joined = sections.join("\n");

  expect(joined).toMatch(/Lens verification mode/);
  expect(joined).toMatch(/Return findings: \[\]/);
});

test("buildTaskSections — coverageTemplate JSON is embedded verbatim", () => {
  const task = makeAuditTask("t1");
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };

  const sections = buildTaskSections([task], lensDefs, lineIndex);
  const joined = sections.join("\n");

  expect(joined.includes(JSON.stringify([{ path: "src/t1.ts", total_lines: 50 }])), "coverage template JSON should be embedded verbatim").toBeTruthy();
});

test("buildTaskSections — renders external analyzer signal detail for tagged tasks, not just the generic tag", () => {
  const task = { ...makeAuditTask("t1"), tags: ["external_analyzer_signal"] };
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };
  const externalAnalyzerResults = [
    {
      tool: "knip",
      results: [
        {
          id: "knip-1",
          category: "unused-export",
          severity: "low",
          path: "src/t1.ts",
          line_start: 12,
          summary: "Unused export 'helper'",
          rule: "exports",
        },
      ],
    },
  ];

  const sections = buildTaskSections([task], lensDefs, lineIndex, buildAnalyzerSignalAnchorIndex(externalAnalyzerResults));
  const joined = sections.join("\n");

  expect(joined).toMatch(/External analyzer signals for this task/);
  expect(joined).toMatch(/src\/t1\.ts:12 \[exports\] Unused export 'helper'/);
});

test("buildTaskSections — caps analyzer signal lines at 24 with an omitted-count footer (N4)", () => {
  const task = { ...makeAuditTask("t1"), tags: ["external_analyzer_signal"] };
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 500 };
  const results = Array.from({ length: 30 }, (_, i) => ({
    id: `knip-${i}`,
    category: "unused-export",
    severity: "low",
    path: "src/t1.ts",
    line_start: i + 1,
    summary: `Unused export 'helper${i}'`,
    rule: "exports",
  }));
  const externalAnalyzerResults = [{ tool: "knip", results }];

  const sections = buildTaskSections([task], lensDefs, lineIndex, buildAnalyzerSignalAnchorIndex(externalAnalyzerResults));
  const joined = sections.join("\n");
  const shown = sections.filter((line) => /^- src\/t1\.ts:\d+ \[exports\]/.test(line));

  expect(shown.length).toBe(24);
  expect(joined).toMatch(/…and 6 more analyzer signal\(s\); see the full set in packet\.json\./);
});

test("buildTaskSections — omits the analyzer signal section for tasks without the tag, even when results exist", () => {
  const task = makeAuditTask("t1"); // no tags
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };
  const externalAnalyzerResults = [
    {
      tool: "knip",
      results: [
        { id: "knip-1", category: "unused-export", severity: "low", path: "src/t1.ts", line_start: 12, summary: "Unused export 'helper'" },
      ],
    },
  ];

  const sections = buildTaskSections([task], lensDefs, lineIndex, buildAnalyzerSignalAnchorIndex(externalAnalyzerResults));
  const joined = sections.join("\n");

  expect(joined).not.toMatch(/External analyzer signals for this task/);
});

test("buildTaskSections — omits the analyzer signal section when tagged but no results match this task's files", () => {
  const task = { ...makeAuditTask("t1"), tags: ["external_analyzer_signal"] };
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };
  const externalAnalyzerResults = [
    {
      tool: "knip",
      results: [
        { id: "knip-1", category: "unused-export", severity: "low", path: "src/other.ts", line_start: 3, summary: "Unused export 'x'" },
      ],
    },
  ];

  const sections = buildTaskSections([task], lensDefs, lineIndex, buildAnalyzerSignalAnchorIndex(externalAnalyzerResults));
  const joined = sections.join("\n");

  expect(joined).not.toMatch(/External analyzer signals for this task/);
});

test("buildTaskSections — renders the knip↔graph cross-check tag inline for a knip lead (CP-NODE-2)", async () => {
  const { buildKnipGraphIndex } = await import(
    "../../src/audit/orchestrator/knipGraphCrosscheck.ts"
  );
  const task = { ...makeAuditTask("t1"), tags: ["external_analyzer_signal"] };
  const lensDefs = makeLensDefs();
  const lineIndex = { "src/t1.ts": 50 };
  const externalAnalyzerResults = [
    {
      tool: "knip",
      results: [
        {
          id: "knip-exports:src/t1.ts:helper:12",
          category: "maintainability",
          severity: "low",
          path: "src/t1.ts",
          line_start: 12,
          summary: "knip: unused export 'helper'",
          rule: "knip-exports",
        },
      ],
    },
  ];
  // Empty graph + entrypoints, but the TS analyzer ran → in-degree 0,
  // non-entrypoint, own analyzer present → LIKELY-DEAD.
  const index = buildKnipGraphIndex({
    graphBundle: { graphs: {}, analyzers_used: ["typescript"] },
    surfaceManifest: { surfaces: [] },
    criticalFlows: { flows: [] },
  });

  const sections = buildTaskSections(
    [task],
    lensDefs,
    lineIndex,
    buildAnalyzerSignalAnchorIndex(externalAnalyzerResults),
    index,
  );
  const joined = sections.join("\n");

  expect(joined).toMatch(/\[knip-exports\] \{graph-crosscheck: LIKELY-DEAD\}/);
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
  expect(warnings).toEqual([]);
});

test("collectOversizedWarnings — emits warning when packet estimated_tokens exceed context budget", () => {
  const contextBudget = 10000 - 2000; // 8000
  const plan = [makePlanEntry("p1", 9000), makePlanEntry("p2", 100)];
  const warnings = collectOversizedWarnings(plan, makeWaveSchedule("high"));
  expect(warnings.length).toBe(1);
  expect(warnings[0].code).toBe("oversized_packet");
  expect(warnings[0].message).toMatch(/p1/);
  expect(warnings[0].message).toMatch(new RegExp(String(9000)));
  expect(warnings[0].message).toMatch(new RegExp(String(contextBudget)));
});

test("collectOversizedWarnings — returns empty array when all packets are within budget", () => {
  const plan = [makePlanEntry("p1", 100), makePlanEntry("p2", 200)];
  const warnings = collectOversizedWarnings(plan, makeWaveSchedule("medium"));
  expect(warnings).toEqual([]);
});

// ── resolveTierBudgets (COR-0e031ac0) ─────────────────────────────────────────

test("resolveTierBudgets — direct entries survive unchanged", () => {
  const perRank = new Map([["small", 1000], ["standard", 2000], ["deep", 4000]]);
  const out = resolveTierBudgets(perRank);
  expect(out.small).toBe(1000);
  expect(out.standard).toBe(2000);
  expect(out.deep).toBe(4000);
});

test("resolveTierBudgets — missing tier falls back to lower rank (not higher) when both equidistant", () => {
  // Only 'small' and 'deep' reported; 'standard' is equidistant from both.
  // Must prefer 'small' (lower / less capable) to avoid over-budgeting (COR-0e031ac0).
  const perRank = new Map([["small", 1000], ["deep", 4000]]);
  const out = resolveTierBudgets(perRank);
  expect(out.standard, "standard should inherit from small (lower tier), not deep (higher tier)").toBe(1000);
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
  expect(out.small, "small must use standard's budget (not deep's) when standard is the nearest reported").toBe(2000);
  expect(out.small, "small must NOT inherit deep's over-sized budget").not.toBe(4000);
});

test("resolveTierBudgets — missing 'deep' takes the nearest higher rank (standard, not small)", () => {
  // Only 'small' and 'standard' reported. 'deep' has no upper neighbour; it
  // should take the nearest lower = 'standard', NOT 'small'.
  const perRank = new Map([["small", 1000], ["standard", 2000]]);
  const out = resolveTierBudgets(perRank);
  expect(out.deep, "deep should fall back to standard (nearest), not small").toBe(2000);
});

test("resolveTierBudgets — throws on empty map", () => {
  assert.throws(() => resolveTierBudgets(new Map()), /requires at least one/);
});
