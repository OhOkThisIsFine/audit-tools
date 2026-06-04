import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runPlanPhase,
  mergeBlocksSharingFiles,
  buildCoverageLedger,
} from "../src/phases/plan.js";
import { validateRemediationPlan } from "../src/validation/remediationState.js";

// Derive the directory in ESM (no implicit `__dirname` under NodeNext/ESM).
const testDir = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(testDir, ".test-plan-artifacts");
const FIXTURE = join(testDir, "fixtures", "audit-findings-simple.json");

const baseState = { status: "pending" as const };
const baseOptions = { root: TEST_DIR, artifactsDir: TEST_DIR };

interface FindingOpts {
  severity?: string;
  confidence?: string;
  lens?: string;
  summary?: string;
  files?: string[];
  evidence?: string[];
}

function mkFinding(id: string, title: string, opts: FindingOpts = {}) {
  return {
    id,
    title,
    category: "General",
    severity: opts.severity ?? "low",
    confidence: opts.confidence ?? "low",
    lens: opts.lens ?? "correctness",
    summary: opts.summary ?? `${title}.`,
    affected_files: (opts.files ?? []).map((path) => ({ path })),
    evidence: opts.evidence ?? ["Evidence."],
  };
}

function mkBlock(id: string, findingIds: string[], dependsOn: string[] = []) {
  return {
    id,
    finding_ids: findingIds,
    unit_ids: [],
    owned_files: [],
    max_severity: "low",
    rationale: "",
    depends_on: dependsOn,
  };
}

function makeReport(findings: unknown[], workBlocks: unknown[] = []) {
  return {
    contract_version: "audit-findings/v1alpha1",
    summary: {
      finding_count: findings.length,
      work_block_count: workBlocks.length,
      severity_breakdown: {},
      audited_file_count: 0,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
    },
    findings,
    work_blocks: workBlocks,
  };
}

async function writeReport(
  name: string,
  findings: unknown[],
  workBlocks: unknown[] = [],
): Promise<string> {
  const path = join(TEST_DIR, name);
  await writeFile(path, JSON.stringify(makeReport(findings, workBlocks)), "utf8");
  return path;
}

// Windows can hold a handle on a directory briefly after spawnSync returns,
// causing EBUSY when rm() runs immediately in afterEach.
async function rmWithRetry(path: string, retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (e: any) {
      if (e.code !== "EBUSY" || i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}

describe("runPlanPhase — audit-findings.json consume path", () => {
  beforeEach(async () => {
    await rmWithRetry(TEST_DIR);
    await mkdir(TEST_DIR, { recursive: true });
  }, 60_000);

  afterEach(async () => {
    await rmWithRetry(TEST_DIR);
  }, 60_000);

  it("produces a valid RemediationPlan from the simple fixture", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    expect(state.plan).toBeDefined();
    const issues = validateRemediationPlan(state.plan);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("skips a finding with empty evidence instead of crashing the plan", async () => {
    const reportPath = await writeReport("empty-evidence.json", [
      mkFinding("F-001", "Has evidence", { files: ["a.ts"] }),
      mkFinding("BAD-001", "No evidence", { files: ["b.ts"], evidence: [] }),
    ]);

    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: reportPath,
    });

    const ids = state.plan!.findings.map((f) => f.id);
    expect(ids).toContain("F-001");
    expect(ids).not.toContain("BAD-001");
    const errors = validateRemediationPlan(state.plan).filter(
      (i) => i.severity === "error",
    );
    expect(errors).toHaveLength(0);
  });

  it("consumes both findings from the fixture", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    expect(state.plan!.findings).toHaveLength(2);
    const ids = state.plan!.findings.map((f) => f.id);
    expect(ids).toContain("F-001");
    expect(ids).toContain("F-002");
  });

  it("preserves finding fields verbatim", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    const f1 = state.plan!.findings.find((f) => f.id === "F-001")!;
    expect(f1.title).toBe("Unvalidated user input in login handler");
    expect(f1.severity).toBe("high");
    expect(f1.confidence).toBe("high");

    const f2 = state.plan!.findings.find((f) => f.id === "F-002")!;
    expect(f2.title).toBe("Missing rate limiting on password reset");
    expect(f2.severity).toBe("medium");
  });

  it("preserves affected files", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    const f1 = state.plan!.findings.find((f) => f.id === "F-001")!;
    expect(f1.affected_files).toHaveLength(1);
    expect(f1.affected_files[0].path).toBe("src/auth/login.ts");
  });

  it("derives blocks from the report work_blocks", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    expect(state.plan!.blocks).toHaveLength(2);
    const b1 = state.plan!.blocks.find((b) => b.block_id === "B-001")!;
    expect(b1.items).toContain("F-001");
    const b2 = state.plan!.blocks.find((b) => b.block_id === "B-002")!;
    expect(b2.items).toContain("F-002");
  });

  it("emits remediation_plan.json that passes schema validation", async () => {
    await runPlanPhase(baseState, { ...baseOptions, input: FIXTURE });

    const planJson = JSON.parse(
      await readFile(join(TEST_DIR, "remediation_plan.json"), "utf8"),
    );
    const errors = validateRemediationPlan(planJson).filter(
      (i) => i.severity === "error",
    );
    expect(errors).toHaveLength(0);
  });

  it("initialises item states for each finding", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    expect(state.items).toBeDefined();
    expect(state.items!["F-001"]).toMatchObject({
      finding_id: "F-001",
      status: "pending",
    });
    expect(state.items!["F-002"]).toMatchObject({
      finding_id: "F-002",
      status: "pending",
    });
  });

  it("carries synthesis themes onto the plan", async () => {
    const reportPath = join(TEST_DIR, "themed.json");
    const report = makeReport(
      [mkFinding("F-009", "Themed finding", { files: ["src/x.ts"] })],
      [mkBlock("B-001", ["F-009"])],
    ) as Record<string, unknown>;
    report.themes = [
      {
        theme_id: "T-1",
        title: "Validation gaps",
        root_cause: "No boundary validation.",
        finding_ids: ["F-009"],
        suggested_fix_pattern: "Validate at the entry point.",
      },
    ];
    await writeFile(reportPath, JSON.stringify(report), "utf8");

    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: reportPath,
    });
    expect(state.plan!.themes).toHaveLength(1);
    expect(state.plan!.themes![0].theme_id).toBe("T-1");
  });

  it("throws when input path does not exist", async () => {
    await expect(
      runPlanPhase(baseState, {
        ...baseOptions,
        input: join(TEST_DIR, "nonexistent.json"),
      }),
    ).rejects.toThrow();
  });

  it("falls back to file_overlap block derivation when the report has no work_blocks", async () => {
    const reportPath = await writeReport("minimal.json", [
      mkFinding("F-003", "Test finding", { files: ["src/foo.ts"] }),
    ]);

    const state = await runPlanPhase(
      baseState,
      { ...baseOptions, input: reportPath },
      { enumerateTestFiles: () => [] },
    );

    expect(state.plan!.blocks.length).toBeGreaterThan(0);
    const allItems = state.plan!.blocks.flatMap((b) => b.items);
    expect(allItems).toContain("F-003");
  });

  it("uses test_graph grouping when test coverage overlaps", async () => {
    const reportPath = await writeReport("test-graph.json", [
      mkFinding("F-101", "First test finding", {
        lens: "tests",
        confidence: "high",
        files: ["src/shared.ts"],
      }),
      mkFinding("F-102", "Second test finding", {
        lens: "tests",
        confidence: "high",
        files: ["lib/shared.ts"],
      }),
    ]);

    const state = await runPlanPhase(
      baseState,
      { ...baseOptions, input: reportPath },
      {
        enumerateTestFiles: () => ["tests/shared.ts", "tests/other.ts"],
      },
    );

    expect(state.plan!.block_strategy).toBe("test_graph");
    expect(state.plan!.blocks).toHaveLength(1);
    expect(state.plan!.blocks[0].items).toEqual(["F-101", "F-102"]);
  });

  it("uses git_cocommit grouping after test_graph produces no useful grouping", async () => {
    const reportPath = await writeReport("git.json", [
      mkFinding("F-201", "First git finding", {
        lens: "tests",
        confidence: "high",
        files: ["src/a.ts"],
      }),
      mkFinding("F-202", "Second git finding", {
        lens: "tests",
        confidence: "high",
        files: ["src/b.ts"],
      }),
    ]);

    const state = await runPlanPhase(
      baseState,
      { ...baseOptions, input: reportPath },
      {
        enumerateTestFiles: () => ["tests/a.test.ts", "tests/b.test.ts"],
        runCommand: () => ({ status: 0, stdout: "commit-a\ncommit-b\n" }) as any,
      },
    );

    expect(state.plan!.block_strategy).toBe("git_cocommit");
    expect(state.plan!.blocks).toHaveLength(1);
    expect(state.plan!.blocks[0].items).toEqual(["F-201", "F-202"]);
  });

  it("records git_cocommit strategy when test_graph falls back without grouping", async () => {
    const reportPath = await writeReport("git-no-group.json", [
      mkFinding("F-301", "First isolated finding", {
        lens: "tests",
        confidence: "high",
        files: ["src/alpha.ts"],
      }),
      mkFinding("F-302", "Second isolated finding", {
        lens: "tests",
        confidence: "high",
        files: ["src/beta.ts"],
      }),
    ]);

    const state = await runPlanPhase(
      baseState,
      { ...baseOptions, input: reportPath },
      {
        enumerateTestFiles: () => ["tests/one.test.ts", "tests/two.test.ts"],
        runCommand: () => ({ status: 0, stdout: "" }) as any,
      },
    );

    expect(state.plan!.block_strategy).toBe("git_cocommit");
    expect(state.plan!.blocks).toHaveLength(2);
  });

  it("splits a block by byte-based context budget (Phase 2 size_bytes)", async () => {
    // One work block holding two findings on two separate files.
    const reportPath = await writeReport(
      "byte-split.json",
      [
        mkFinding("F-401", "Module A issue", {
          severity: "high",
          confidence: "high",
          lens: "security",
          files: ["src/a.ts"],
        }),
        mkFinding("F-402", "Module B issue", {
          severity: "medium",
          confidence: "high",
          lens: "reliability",
          files: ["src/b.ts"],
        }),
      ],
      [mkBlock("B-001", ["F-401", "F-402"])],
    );
    await mkdir(join(TEST_DIR, "src"), { recursive: true });

    // Budget fits both groups' base+overhead (~3000 tokens) but not the byte
    // contribution of two ~50KB files (~12500 tokens each).
    await writeFile(
      join(TEST_DIR, "session-config.json"),
      JSON.stringify({
        block_quota: { context_tokens: 20000, reserved_output_tokens: 8192 },
      }),
      "utf8",
    );

    const big = "x".repeat(50_000);
    await writeFile(join(TEST_DIR, "src", "a.ts"), big, "utf8");
    await writeFile(join(TEST_DIR, "src", "b.ts"), big, "utf8");

    const split = await runPlanPhase(baseState, {
      ...baseOptions,
      input: reportPath,
    });
    expect(split.plan!.blocks.length).toBe(2);
    const items = split.plan!.blocks.flatMap((b) => b.items).sort();
    expect(items).toEqual(["F-401", "F-402"]);

    // Control: empty files keep the block whole, proving the split was driven
    // by file size, not by a degenerate budget.
    await writeFile(join(TEST_DIR, "src", "a.ts"), "", "utf8");
    await writeFile(join(TEST_DIR, "src", "b.ts"), "", "utf8");
    const whole = await runPlanPhase(baseState, {
      ...baseOptions,
      input: reportPath,
    });
    expect(whole.plan!.blocks.length).toBe(1);
  });

  it("emits remediation-coverage.json accounting for every source finding", async () => {
    const state = await runPlanPhase(baseState, { ...baseOptions, input: FIXTURE });
    const coverage = JSON.parse(
      await readFile(join(TEST_DIR, "remediation-coverage.json"), "utf8"),
    );
    expect(coverage.source_finding_count).toBe(2);
    expect(coverage.planned_count).toBe(2);
    expect(coverage.dropped_count).toBe(0);
    expect(coverage.entries).toHaveLength(2);
    expect(
      coverage.entries.every((e: any) => e.disposition === "planned"),
    ).toBe(true);
    const f1 = coverage.entries.find((e: any) => e.finding_id === "F-001");
    expect(f1.block_id).toBe(state.items!["F-001"].block_id);
  });
});

describe("mergeBlocksSharingFiles", () => {
  const f = (id: string, file: string) => mkFinding(id, id, { files: [file] });

  it("merges parallel blocks that touch a shared file", () => {
    const findings = [f("F-1", "shared.ts"), f("F-2", "shared.ts")];
    const blocks = [
      { block_id: "B-001", items: ["F-1"], parallel_safe: true },
      { block_id: "B-002", items: ["F-2"], parallel_safe: true },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any);
    expect(merged).toHaveLength(1);
    expect(merged[0].items.sort()).toEqual(["F-1", "F-2"]);
    expect(merged[0].parallel_safe).toBe(true);
  });

  it("does not merge blocks already serialized by a dependency", () => {
    const findings = [f("F-1", "shared.ts"), f("F-2", "shared.ts")];
    const blocks = [
      { block_id: "B-001", items: ["F-1"], parallel_safe: true },
      {
        block_id: "B-002",
        items: ["F-2"],
        parallel_safe: false,
        dependencies: ["B-001"],
      },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any);
    expect(merged).toHaveLength(2);
  });

  it("leaves blocks that share no file untouched", () => {
    const findings = [f("F-1", "a.ts"), f("F-2", "b.ts")];
    const blocks = [
      { block_id: "B-001", items: ["F-1"], parallel_safe: true },
      { block_id: "B-002", items: ["F-2"], parallel_safe: true },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any);
    expect(merged).toHaveLength(2);
  });

  it("remaps an external dependency onto the merged block id", () => {
    // B-001 and B-002 share a file and merge to B-001; B-003 depended on B-002,
    // so after the merge it must depend on B-001 instead.
    const findings = [
      f("F-1", "shared.ts"),
      f("F-2", "shared.ts"),
      f("F-3", "other.ts"),
    ];
    const blocks = [
      { block_id: "B-001", items: ["F-1"], parallel_safe: true },
      { block_id: "B-002", items: ["F-2"], parallel_safe: true },
      {
        block_id: "B-003",
        items: ["F-3"],
        parallel_safe: false,
        dependencies: ["B-002"],
      },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any);
    expect(merged).toHaveLength(2);
    const b3 = merged.find((b) => b.block_id === "B-003")!;
    expect(b3.dependencies).toEqual(["B-001"]);
  });
});

describe("buildCoverageLedger", () => {
  it("classifies planned, folded, and dropped findings", () => {
    const sourceFindings = [
      mkFinding("A", "Kept", { files: ["a.ts"] }),
      mkFinding("B", "Folded", { files: ["a.ts"] }),
      mkFinding("C", "NoEvidence", { files: ["c.ts"] }),
    ];
    const ledger = buildCoverageLedger({
      planId: "PLAN-X",
      sourceFindings: sourceFindings as any,
      droppedNoEvidence: ["C"],
      mergeMap: new Map([["B", "A"]]),
      items: { A: { finding_id: "A", status: "pending", block_id: "B-001" } },
    });
    expect(ledger.source_finding_count).toBe(3);
    expect(ledger.planned_count).toBe(1);
    expect(ledger.folded_count).toBe(1);
    expect(ledger.dropped_count).toBe(1);
    const byId = Object.fromEntries(
      ledger.entries.map((e) => [e.finding_id, e]),
    );
    expect(byId.A.disposition).toBe("planned");
    expect(byId.A.block_id).toBe("B-001");
    expect(byId.B.disposition).toBe("folded_into");
    expect(byId.B.folded_into).toBe("A");
    expect(byId.C.disposition).toBe("dropped_no_evidence");
    expect(byId.C.rationale).toBeTruthy();
  });
});
