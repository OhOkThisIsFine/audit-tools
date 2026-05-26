import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPlanPhase } from "../src/phases/plan.js";
import { validateRemediationPlan } from "../src/validation/remediationState.js";

const TEST_DIR = join(__dirname, ".test-plan-artifacts");
const FIXTURE = join(__dirname, "fixtures", "audit-report-simple.md");

const baseState = { status: "pending" as const };
const baseOptions = { root: TEST_DIR, artifactsDir: TEST_DIR };

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

describe("runPlanPhase — audit-report.md parse path", () => {
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

  it("parses both findings from the fixture", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    expect(state.plan!.findings).toHaveLength(2);
    const ids = state.plan!.findings.map((f) => f.id);
    expect(ids).toContain("F-001");
    expect(ids).toContain("F-002");
  });

  it("parses finding titles correctly", async () => {
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

  it("parses affected files", async () => {
    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: FIXTURE,
    });

    const f1 = state.plan!.findings.find((f) => f.id === "F-001")!;
    expect(f1.affected_files).toHaveLength(1);
    expect(f1.affected_files[0].path).toBe("src/auth/login.ts");
  });

  it("parses work blocks from the report", async () => {
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

  it("throws when input path does not exist", async () => {
    await expect(
      runPlanPhase(baseState, {
        ...baseOptions,
        input: join(TEST_DIR, "nonexistent.md"),
      }),
    ).rejects.toThrow();
  });

  it("falls back to file_overlap block derivation when the report has no block entries", async () => {
    const minimalReport = `# Audit Report\n\n## Work Blocks\n\nNo remediation work blocks were generated.\n\n## Findings\n\n### F-003 — Test finding\n- Severity: low\n- Confidence: low\n- Lens: correctness\n- Summary: Test.\n- Files: src/foo.ts\n- Evidence:\n  - Line 1: test\n\n## Scope and Coverage\n...\n`;
    const reportPath = join(TEST_DIR, "minimal-report.md");
    await writeFile(reportPath, minimalReport, "utf8");

    const state = await runPlanPhase(baseState, {
      ...baseOptions,
      input: reportPath,
    }, { enumerateTestFiles: () => [] });

    expect(state.plan!.blocks.length).toBeGreaterThan(0);
    const allItems = state.plan!.blocks.flatMap((b) => b.items);
    expect(allItems).toContain("F-003");
  });

  it("uses test_graph grouping when test coverage overlaps", async () => {
    const reportPath = join(TEST_DIR, "test-graph-report.md");
    await writeFile(
      reportPath,
      `# Audit Report\n\n## Work Blocks\n\nNo remediation work blocks were generated.\n\n## Findings\n\n### F-101 — First test finding\n- Severity: low\n- Confidence: high\n- Lens: tests\n- Summary: First.\n- Files: src/shared.ts\n- Evidence:\n  - Evidence 1\n\n### F-102 — Second test finding\n- Severity: low\n- Confidence: high\n- Lens: tests\n- Summary: Second.\n- Files: lib/shared.ts\n- Evidence:\n  - Evidence 2\n\n## Scope and Coverage\n...\n`,
      "utf8",
    );

    const state = await runPlanPhase(
      baseState,
      { ...baseOptions, input: reportPath },
      {
        enumerateTestFiles: () => [
          "tests/shared.ts",
          "tests/other.ts",
        ],
      },
    );

    expect(state.plan!.block_strategy).toBe("test_graph");
    expect(state.plan!.blocks).toHaveLength(1);
    expect(state.plan!.blocks[0].items).toEqual(["F-101", "F-102"]);
  });

  it("uses git_cocommit grouping after test_graph produces no useful grouping", async () => {
    const reportPath = join(TEST_DIR, "git-report.md");
    await writeFile(
      reportPath,
      `# Audit Report\n\n## Work Blocks\n\nNo remediation work blocks were generated.\n\n## Findings\n\n### F-201 — First git finding\n- Severity: low\n- Confidence: high\n- Lens: tests\n- Summary: First.\n- Files: src/a.ts\n- Evidence:\n  - Evidence 1\n\n### F-202 — Second git finding\n- Severity: low\n- Confidence: high\n- Lens: tests\n- Summary: Second.\n- Files: src/b.ts\n- Evidence:\n  - Evidence 2\n\n## Scope and Coverage\n...\n`,
      "utf8",
    );

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
    const reportPath = join(TEST_DIR, "git-no-group-report.md");
    await writeFile(
      reportPath,
      `# Audit Report\n\n## Work Blocks\n\nNo remediation work blocks were generated.\n\n## Findings\n\n### F-301 — First isolated finding\n- Severity: low\n- Confidence: high\n- Lens: tests\n- Summary: First.\n- Files: src/alpha.ts\n- Evidence:\n  - Evidence 1\n\n### F-302 — Second isolated finding\n- Severity: low\n- Confidence: high\n- Lens: tests\n- Summary: Second.\n- Files: src/beta.ts\n- Evidence:\n  - Evidence 2\n\n## Scope and Coverage\n...\n`,
      "utf8",
    );

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
});
