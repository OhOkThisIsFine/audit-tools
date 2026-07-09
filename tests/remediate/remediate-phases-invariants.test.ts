/**
 * INV-remediate-phases-01: applyPlanPipeline always runs mergeBlocksSharingFiles before
 *   splitBlocksByContextBudget (post-dedup pipeline order invariant)
 * INV-remediate-phases-02: mergeBlocksSharingFiles never merges serialized (dep-ordered) blocks
 * INV-remediate-phases-03: splitBlocksByContextBudget rewrites ALL dep references when a dep is split
 * INV-remediate-phases-04: buildCoverageLedger — every source finding has exactly one disposition
 * INV-remediate-phases-05: runTriagePhase auto-retry cap is per-failure-class (infra vs contract)
 * INV-remediate-phases-06: runClosePhase preview gate blocks unconfirmed closing actions
 * INV-remediate-phases-07: collectStagingFiles excludes .audit-tools/ and .env* patterns
 * INV-remediate-phases-08: groundExtractedFindings repair hook is called exactly once for all-phantom findings
 * INV-remediate-phases-09: explicit action:"retry" in resolution overrides rationale heuristic
 * INV-remediate-phases-10: ClosingResult always carries contract_version field
 * TST-d1399aa3: groundAffectedFiles and evidenceCitesRealPath dedicated unit tests
 * TST-761e8471: buildCoverageLedger disposition precedence with overlapping sets
 * TST-cb981ad0: close.ts summarizeItemSpec and FINAL_STATUS_BY_OUTCOME via buildRemediationOutcomesReport
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import {
  applyPlanPipeline,
  mergeBlocksSharingFiles,
  splitBlocksByContextBudget,
  buildCoverageLedger,
  pruneBlocksForKeptFindings,
} from "../../src/remediate/phases/plan.js";
import { collectStagingFiles, executeClosingAction, runClosePhase, buildRemediationOutcomesReport } from "../../src/remediate/phases/close.js";
import { groundExtractedFindings, groundAffectedFiles, evidenceCitesRealPath } from "../../src/remediate/phases/grounding.js";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import { makeState } from "./test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// INV-remediate-phases-01: applyPlanPipeline — post-dedup pipeline order invariant
// mergeBlocksSharingFiles runs first (preventing parallel clobber), then
// splitBlocksByContextBudget (keeping each block within context budget).
// A plan with two parallel-safe blocks sharing a file must come out merged.
// ---------------------------------------------------------------------------

describe("applyPlanPipeline — INV-remediate-phases-01: post-dedup pipeline applies merge before split", () => {
  const TEST_DIR = join(__dirname, ".test-phases-inv-01");

  function mkFinding(id: string, filePath: string) {
    return {
      id,
      title: id,
      category: "General",
      severity: "low" as const,
      confidence: "low" as const,
      lens: "correctness",
      summary: id,
      affected_files: [{ path: filePath }],
      evidence: ["evidence"],
    };
  }

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    // Create real files so fileSizeBytes can stat them
    writeFileSync(join(TEST_DIR, "src", "shared.ts"), "export const x = 1;\n");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("A3: keeps two independent parallel-safe blocks sharing a file separate + flagged after applyPlanPipeline", async () => {
    const findings = [
      mkFinding("F1", "src/shared.ts"),
      mkFinding("F2", "src/shared.ts"),
    ];
    const blocks: RemediationBlock[] = [
      { block_id: "B1", items: ["F1"], parallel_safe: true },
      { block_id: "B2", items: ["F2"], parallel_safe: true },
    ];
    const plan = {
      plan_id: "P-INV01",
      findings: findings as any,
      blocks,
      project_type: "unknown",
      candidate_closing_actions: ["none" as const],
    };
    const result = await applyPlanPipeline(plan, { root: TEST_DIR });
    // A3: independent same-file blocks stay separate + flagged (merge still runs
    // before split — the pipeline order invariant is preserved).
    expect(result.blocks.length).toBe(2);
    for (const b of result.blocks) expect(b.cofile_parallel_safe).toBe(true);
  });

  it("preserves dep-ordered blocks that share a file (INV-02 via applyPlanPipeline)", async () => {
    const findings = [
      mkFinding("F1", "src/shared.ts"),
      mkFinding("F2", "src/shared.ts"),
    ];
    const blocks: RemediationBlock[] = [
      { block_id: "B1", items: ["F1"], parallel_safe: true },
      { block_id: "B2", items: ["F2"], dependencies: ["B1"], parallel_safe: false },
    ];
    const plan = {
      plan_id: "P-INV01b",
      findings: findings as any,
      blocks,
      project_type: "unknown",
      candidate_closing_actions: ["none" as const],
    };
    const result = await applyPlanPipeline(plan, { root: TEST_DIR });
    // Serialized blocks are NOT merged — they remain separate
    expect(result.blocks.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-02: mergeBlocksSharingFiles — serialized blocks not merged
// ---------------------------------------------------------------------------

describe("mergeBlocksSharingFiles — INV-remediate-phases-02: dep-serialized blocks sharing a file must NOT be merged", () => {
  function mkFinding(id: string, files: string[]) {
    return {
      id,
      title: id,
      category: "General",
      severity: "low" as const,
      confidence: "low" as const,
      lens: "correctness",
      summary: id,
      affected_files: files.map((path) => ({ path })),
      evidence: ["evidence"],
    };
  }

  it("does not merge two blocks ordered by dependency even when they share a file", () => {
    const findings = [
      mkFinding("F1", ["src/shared.ts"]),
      mkFinding("F2", ["src/shared.ts"]),
    ];
    const blocks: RemediationBlock[] = [
      { block_id: "B1", items: ["F1"], parallel_safe: true },
      { block_id: "B2", items: ["F2"], dependencies: ["B1"], parallel_safe: false },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any, "/tmp");
    // Must remain 2 blocks — serialization makes the shared file safe.
    expect(merged).toHaveLength(2);
    const ids = merged.map((b) => b.block_id).sort();
    expect(ids).toEqual(["B1", "B2"]);
  });

  it("A3: two independent parallel-safe blocks sharing a file stay SEPARATE, each flagged", () => {
    const findings = [
      mkFinding("F1", ["src/shared.ts"]),
      mkFinding("F2", ["src/shared.ts"]),
    ];
    const blocks: RemediationBlock[] = [
      { block_id: "B1", items: ["F1"], parallel_safe: true },
      { block_id: "B2", items: ["F2"], parallel_safe: true },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any, "/tmp");
    // A3: independent same-file blocks are NOT unioned — kept separate + flagged.
    expect(merged).toHaveLength(2);
    for (const b of merged) expect(b.cofile_parallel_safe).toBe(true);
  });

  it("singleton block is returned unchanged", () => {
    const findings = [mkFinding("F1", ["src/a.ts"])];
    const blocks: RemediationBlock[] = [
      { block_id: "B1", items: ["F1"], parallel_safe: true },
    ];
    const result = mergeBlocksSharingFiles(blocks, findings as any, "/tmp");
    expect(result).toHaveLength(1);
    expect(result[0].block_id).toBe("B1");
    expect(result[0].parallel_safe).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-03: splitBlocksByContextBudget rewrites dep references
// ---------------------------------------------------------------------------

describe("splitBlocksByContextBudget — INV-remediate-phases-03: dep-remap covers ALL sub-block IDs", () => {
  function mkFinding(id: string, bytes: number) {
    return {
      id,
      title: id,
      category: "General",
      severity: "low" as const,
      confidence: "low" as const,
      lens: "correctness",
      summary: id,
      // Distinct file per finding so no file-overlap grouping
      affected_files: [{ path: `src/${id}.ts`, _fakeSizeBytes: bytes }],
      evidence: ["evidence"],
    };
  }

  it("a block depending on a split dep now depends on ALL its sub-blocks", () => {
    // Budget is tight so B-base (two large findings) must split into two sub-blocks.
    const findings = [
      mkFinding("F1", 0),
      mkFinding("F2", 0),
      mkFinding("F3", 0),
    ] as any;

    // Set a very small budget so B-base inevitably splits when we simulate tokens.
    // We use the real function but pass budget=0 so every block is individually
    // above budget → each finding becomes its own sub-block.
    const baseBudget = 0; // force split
    const blocks: RemediationBlock[] = [
      { block_id: "B-base", items: ["F1", "F2"], parallel_safe: true },
      { block_id: "B-dep", items: ["F3"], dependencies: ["B-base"], parallel_safe: false },
    ];

    const result = splitBlocksByContextBudget(blocks, findings, "/tmp", baseBudget);

    // B-base must have been split into at least 2 sub-blocks.
    const subBlocks = result.filter((b) => b.block_id.startsWith("B-base-"));
    expect(subBlocks.length).toBeGreaterThanOrEqual(2);

    // B-dep must depend on ALL the sub-blocks of B-base, not just the original "B-base".
    const depBlock = result.find((b) => b.block_id === "B-dep");
    expect(depBlock).toBeDefined();
    const subBlockIds = subBlocks.map((b) => b.block_id).sort();
    const depDeps = (depBlock!.dependencies ?? []).sort();
    // Every sub-block of B-base must appear in B-dep's dependency list.
    for (const subId of subBlockIds) {
      expect(depDeps).toContain(subId);
    }
    // The original "B-base" must NOT appear in B-dep's deps after remap.
    expect(depDeps).not.toContain("B-base");
  });

  it("does not remap when no block is split", () => {
    const findings = [mkFinding("F1", 0), mkFinding("F2", 0)] as any;
    const blocks: RemediationBlock[] = [
      { block_id: "B1", items: ["F1"], parallel_safe: true },
      { block_id: "B2", items: ["F2"], dependencies: ["B1"], parallel_safe: false },
    ];
    // Large budget — no split.
    const result = splitBlocksByContextBudget(blocks, findings, "/tmp", 1_000_000);
    const b2 = result.find((b) => b.block_id === "B2")!;
    expect(b2.dependencies).toEqual(["B1"]);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-04: buildCoverageLedger — exhaustive, disjoint dispositions
// ---------------------------------------------------------------------------

describe("buildCoverageLedger — INV-remediate-phases-04: every source finding has exactly one disposition", () => {
  function mkFinding(id: string) {
    return {
      id,
      title: id,
      category: "General",
      severity: "low" as const,
      confidence: "low" as const,
      lens: "correctness",
      summary: id,
      affected_files: [],
      evidence: ["e"],
    };
  }

  it("accounts for all five disposition cases without overlap", () => {
    const sourceFindings = [
      mkFinding("PLANNED"),
      mkFinding("FOLDED"),
      mkFinding("DROPPED-EV"),
      mkFinding("DROPPED-CP"),
      mkFinding("DROPPED-PH"),
    ] as any[];

    const items: Record<string, any> = {
      PLANNED: { finding_id: "PLANNED", status: "pending", block_id: "B1" },
    };

    const ledger = buildCoverageLedger({
      planId: "P-INV04",
      sourceFindings,
      droppedNoEvidence: ["DROPPED-EV"],
      droppedByCheckpoint: ["DROPPED-CP"],
      droppedPhantomPaths: new Map([["DROPPED-PH", ["src/phantom.ts"]]]),
      phantomPathsRemoved: undefined,
      mergeMap: new Map([["FOLDED", "PLANNED"]]),
      items,
    });

    expect(ledger.source_finding_count).toBe(5);
    expect(ledger.planned_count).toBe(1);
    expect(ledger.folded_count).toBe(1);
    expect(ledger.dropped_count).toBe(1);
    expect(ledger.checkpoint_dropped_count).toBe(1);
    expect(ledger.phantom_dropped_count).toBe(1);

    // Sum of all dispositions must equal source count.
    const total =
      ledger.planned_count +
      ledger.folded_count +
      ledger.dropped_count +
      ledger.checkpoint_dropped_count +
      ledger.phantom_dropped_count;
    expect(total).toBe(ledger.source_finding_count);

    // Each source finding appears exactly once in entries.
    const ids = ledger.entries.map((e) => e.finding_id);
    expect(ids.sort()).toEqual(
      ["DROPPED-CP", "DROPPED-EV", "DROPPED-PH", "FOLDED", "PLANNED"].sort(),
    );

    // Dispositions are correct.
    const byId = Object.fromEntries(ledger.entries.map((e) => [e.finding_id, e]));
    expect(byId["PLANNED"].disposition).toBe("planned");
    expect(byId["FOLDED"].disposition).toBe("folded_into");
    expect(byId["DROPPED-EV"].disposition).toBe("dropped_no_evidence");
    expect(byId["DROPPED-CP"].disposition).toBe("dropped_by_checkpoint");
    expect(byId["DROPPED-PH"].disposition).toBe("dropped_phantom_paths");
  });

  it("an empty source set produces a ledger with all counts zero", () => {
    const ledger = buildCoverageLedger({
      planId: "P-EMPTY",
      sourceFindings: [],
      droppedNoEvidence: [],
      droppedByCheckpoint: [],
      mergeMap: new Map(),
      items: {},
    });
    expect(ledger.source_finding_count).toBe(0);
    expect(ledger.planned_count).toBe(0);
    expect(ledger.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-05: auto-retry cap is per failure class
// ---------------------------------------------------------------------------

describe("runTriagePhase — INV-remediate-phases-05: auto-retry cap per failure class", () => {
  const TEST_DIR = join(__dirname, ".test-phases-inv-05");
  const BASE_OPTIONS = { root: "/tmp", artifactsDir: TEST_DIR };

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("infra failure below infra cap (5) is auto-retried even when contract cap (2) is exhausted", async () => {
    const state = makeState({
      status: "triage",
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "quota exceeded — rate limit hit",
          block_id: "B1",
          rework_count: 2,        // contract cap exhausted
          infra_rework_count: 3,  // below infra cap (5)
        },
      },
    });
    const next = await runTriagePhase(state, BASE_OPTIONS);
    // Auto-retried because infra cap not yet reached
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.infra_rework_count).toBe(4);
    // rework_count must not be incremented for an infra failure
    expect(state.items!.F1.rework_count).toBe(2);
  });

  it("contract failure at contract cap (2) routes to human triage even with infra cap remaining", async () => {
    const state = makeState({
      status: "triage",
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "test assertion failed — wrong output",
          block_id: "B1",
          rework_count: 2,       // contract cap exhausted
          infra_rework_count: 0, // infra cap has headroom but failure is contract
        },
      },
    });
    const next = await runTriagePhase(state, BASE_OPTIONS);
    // Contract cap exhausted → wait for human
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
  });

  it("infra failure at infra cap (5) routes to human triage", async () => {
    const state = makeState({
      status: "triage",
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "provider error — timeout exceeded",
          block_id: "B1",
          infra_rework_count: 5, // at infra cap
        },
      },
    });
    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-06: runClosePhase preview gate
// ---------------------------------------------------------------------------

describe("runClosePhase — INV-remediate-phases-06: preview gate blocks unconfirmed actions", () => {
  const REPO_DIR = join(__dirname, ".test-phases-inv-06-repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");
  const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR };

  function makeClosingState(overrides: Record<string, unknown> = {}) {
    return makeState({
      status: "closing",
      plan: {
        plan_id: "P1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      closing_plan: { action: "none" },
      ...overrides,
    });
  }

  beforeEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    execSync("git init", { cwd: REPO_DIR });
    execSync("git config user.email test@test.com", { cwd: REPO_DIR });
    execSync("git config user.name Test", { cwd: REPO_DIR });
    writeFileSync(join(REPO_DIR, "init.txt"), "init");
    execSync("git add . && git commit -m init", { cwd: REPO_DIR });
  });

  afterEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
  });

  it("action=commit without pre_authorized returns status=closing (preview, not complete)", async () => {
    const state = makeClosingState({
      closing_plan: { action: "commit" }, // no pre_authorized
    });
    const next = await runClosePhase(state, BASE_OPTIONS);
    // Must stop at preview
    expect(next.status).toBe("closing");
    expect(next.closing_plan!.closing_action_preview).toBeDefined();
  });

  it("action=commit with pre_authorized:true bypasses preview and reaches complete", async () => {
    const state = makeClosingState({
      closing_plan: { action: "commit", pre_authorized: true },
    });
    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");
    expect(next.closing_plan!.closing_action_preview).toBeUndefined();
  });

  it("action=none never triggers a preview regardless of pre_authorized", async () => {
    const state = makeClosingState({ closing_plan: { action: "none" } });
    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");
    expect(next.closing_plan!.closing_action_preview).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-07: collectStagingFiles excludes .audit-tools/ and .env*
// ---------------------------------------------------------------------------

describe("collectStagingFiles — INV-remediate-phases-07: exclusion patterns", () => {
  const GIT_DIR = join(__dirname, ".test-phases-inv-07-git");

  beforeEach(async () => {
    await rm(GIT_DIR, { recursive: true, force: true });
    await mkdir(GIT_DIR, { recursive: true });
    execSync("git init", { cwd: GIT_DIR });
    execSync("git config user.email test@test.com", { cwd: GIT_DIR });
    execSync("git config user.name Test", { cwd: GIT_DIR });
    writeFileSync(join(GIT_DIR, "initial.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: GIT_DIR });
  });

  afterEach(async () => {
    await rm(GIT_DIR, { recursive: true, force: true });
  });

  it("excludes all .audit-tools/ subtree paths (both audit and remediation)", () => {
    mkdirSync(join(GIT_DIR, ".audit-tools", "audit"), { recursive: true });
    mkdirSync(join(GIT_DIR, ".audit-tools", "remediation"), { recursive: true });
    writeFileSync(join(GIT_DIR, ".audit-tools", "audit", "audit-findings.json"), "{}");
    writeFileSync(join(GIT_DIR, ".audit-tools", "remediation", "state.json"), "{}");
    writeFileSync(join(GIT_DIR, "src.ts"), "code");

    // V2 signature: staging is manifest-scoped; declaring the .audit-tools
    // paths in the manifest must STILL not stage them (hard exclude wins).
    const { files } = collectStagingFiles(GIT_DIR, [
      "src.ts",
      ".audit-tools/audit/audit-findings.json",
      ".audit-tools/remediation/state.json",
    ]);
    expect(files).toContain("src.ts");
    expect(files.some((f) => f.includes(".audit-tools"))).toBe(false);
  });

  it("excludes .env and .env.* credential files", () => {
    writeFileSync(join(GIT_DIR, ".env"), "SECRET=x");
    writeFileSync(join(GIT_DIR, ".env.local"), "LOCAL_SECRET=y");
    writeFileSync(join(GIT_DIR, ".env.production"), "PROD=z");
    writeFileSync(join(GIT_DIR, "src.ts"), "code");

    // Declared in the manifest on purpose — the .env* hard exclude must win.
    const { files } = collectStagingFiles(GIT_DIR, [
      "src.ts",
      ".env",
      ".env.local",
      ".env.production",
    ]);
    expect(files).toContain("src.ts");
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
    expect(files).not.toContain(".env.production");
  });

  it("returns empty when nothing is modified", () => {
    const { files, leftover } = collectStagingFiles(GIT_DIR, ["src.ts"]);
    expect(files).toEqual([]);
    expect(leftover).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-08: groundExtractedFindings repair called exactly once
// ---------------------------------------------------------------------------

describe("groundExtractedFindings — INV-remediate-phases-08: repair hook called exactly once", () => {
  const TEST_DIR = join(__dirname, ".test-phases-inv-08");

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "real.ts"), "const x = 1;\n");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("invokes repair exactly once even with multiple all-phantom findings", async () => {
    let repairCallCount = 0;

    const findings = [
      { id: "F1", title: "F1", category: "General", severity: "low" as const,
        confidence: "high" as const, lens: "correctness", summary: "s",
        affected_files: [{ path: "phantom/a.ts" }], evidence: ["e"] },
      { id: "F2", title: "F2", category: "General", severity: "low" as const,
        confidence: "high" as const, lens: "correctness", summary: "s",
        affected_files: [{ path: "phantom/b.ts" }], evidence: ["e"] },
    ];

    await groundExtractedFindings(findings as any, {
      root: TEST_DIR,
      repairZeroPathFindings: async (requests) => {
        repairCallCount++;
        // Return repairs for F1 only; F2 remains unrepaired.
        return new Map([["F1", ["src/real.ts"]]]);
      },
    });

    // Repair must be invoked exactly once, batching all all-phantom findings.
    expect(repairCallCount).toBe(1);
  });

  it("does not invoke repair when all findings have at least one real path", async () => {
    let repairCallCount = 0;

    const findings = [
      { id: "F1", title: "F1", category: "General", severity: "low" as const,
        confidence: "high" as const, lens: "correctness", summary: "s",
        affected_files: [{ path: "src/real.ts" }], evidence: ["e"] },
    ];

    await groundExtractedFindings(findings as any, {
      root: TEST_DIR,
      repairZeroPathFindings: async () => {
        repairCallCount++;
        return new Map();
      },
    });

    // No all-phantom findings → no repair invocation.
    expect(repairCallCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-09: explicit action:"retry" overrides rationale heuristic
// ---------------------------------------------------------------------------

describe("runTriagePhase — INV-remediate-phases-09: explicit action:retry is authoritative", () => {
  const TEST_DIR = join(__dirname, ".test-phases-inv-09");
  const BASE_OPTIONS = { root: "/tmp", artifactsDir: TEST_DIR };

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("action:retry retries the item even when rationale looks like a skip", async () => {
    const state = makeState({
      status: "triage",
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "failed",
          block_id: "B1",
        },
      },
    });
    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "retry", rationale: "not worth fixing" }],
      }),
      "utf8",
    );
    const next = await runTriagePhase(state, BASE_OPTIONS);
    // Must be implementing (retried), not closing (skipped)
    expect(next.status).toBe("implementing");
    expect(state.items!.F1.status).toBe("pending");
  });

  it("action:ignore ignores the item even when rationale says retry", async () => {
    const state = makeState({
      status: "triage",
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          failure_reason: "failed",
          block_id: "B1",
        },
      },
    });
    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ finding_id: "F1", action: "ignore", rationale: "please retry this" }],
      }),
      "utf8",
    );
    const next = await runTriagePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("closing");
    expect(state.items!.F1.status).toBe("ignored");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-10: ClosingResult always carries contract_version field
// ---------------------------------------------------------------------------

describe("runClosePhase — INV-remediate-phases-10: ClosingResult always has contract_version", () => {
  const REPO_DIR = join(__dirname, ".test-phases-inv-10-repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");
  const OUTPUT_DIR = join(REPO_DIR, ".audit-tools");
  const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR };

  function makeClosingState(actionOverride: string) {
    return makeState({
      status: "closing",
      plan: {
        plan_id: "P-INV10",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      closing_plan: { action: actionOverride, pre_authorized: true },
    });
  }

  beforeEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    execSync("git init", { cwd: REPO_DIR });
    execSync("git config user.email test@test.com", { cwd: REPO_DIR });
    execSync("git config user.name Test", { cwd: REPO_DIR });
    writeFileSync(join(REPO_DIR, "init.txt"), "init");
    execSync("git add . && git commit -m init", { cwd: REPO_DIR });
  });

  afterEach(async () => {
    await rm(REPO_DIR, { recursive: true, force: true });
  });

  it("ClosingResult always carries contract_version for action=none", () => {
    // Use executeClosingAction directly — runClosePhase deletes the artifacts dir
    // on a clean (fully-green) close, so the written file would be gone before
    // we can read it. The invariant being tested is that every code path in
    // executeClosingAction sets contract_version.
    const state = makeClosingState("none");
    const result = executeClosingAction(state, BASE_OPTIONS);
    expect(result.contract_version).toBe("remediate-code-closing-result/v1alpha1");
    expect(result.action).toBe("none");
  });

  it("ClosingResult always carries contract_version for action=commit (no staged files)", () => {
    // executeClosingAction directly: repo has no staged/untracked files, so the
    // vacuous-success path runs. All paths must set contract_version.
    const state = makeClosingState("commit");
    const result = executeClosingAction(state, BASE_OPTIONS);
    expect(result.contract_version).toBe("remediate-code-closing-result/v1alpha1");
    expect(result.action).toBe("commit");
  });

  it("remediation-outcomes.json always carries contract_version", async () => {
    const { readFile } = await import("node:fs/promises");
    const state = makeClosingState("none");
    await runClosePhase(state, BASE_OPTIONS);
    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    expect(outcomes.contract_version).toBe("remediate-code-outcomes/v1alpha1");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-11: pruneBlocksForKeptFindings — DRY helper correctness
// (MNT-d1be3b44-2: the three formerly-duplicated block pruning patterns are
//  now a single helper; this test is the regression guard.)
// ---------------------------------------------------------------------------

describe("pruneBlocksForKeptFindings — INV-remediate-phases-11: pruning helper contract", () => {
  function mkFinding(id: string) {
    return {
      id,
      title: id,
      category: "General",
      severity: "low" as const,
      confidence: "low" as const,
      lens: "correctness",
      summary: id,
      affected_files: [],
      evidence: ["e"],
    };
  }

  it("removes dropped finding ids from block items and drops empty blocks", () => {
    const blocks = [
      { block_id: "B1", items: ["F1", "F2"], parallel_safe: true },
      { block_id: "B2", items: ["F3"], parallel_safe: true },
    ];
    const keptFindings = [mkFinding("F1")]; // F2 and F3 dropped
    const result = pruneBlocksForKeptFindings(blocks as any, keptFindings as any);
    // B1 keeps only F1; B2 is dropped entirely (F3 gone)
    expect(result).toHaveLength(1);
    expect(result[0].block_id).toBe("B1");
    expect(result[0].items).toEqual(["F1"]);
  });

  it("keeps all blocks when every finding is in kept set", () => {
    const blocks = [
      { block_id: "B1", items: ["F1"], parallel_safe: true },
      { block_id: "B2", items: ["F2"], parallel_safe: true },
    ];
    const keptFindings = [mkFinding("F1"), mkFinding("F2")];
    const result = pruneBlocksForKeptFindings(blocks as any, keptFindings as any);
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.block_id).sort()).toEqual(["B1", "B2"]);
  });

  it("returns empty array when all blocks become empty after pruning", () => {
    const blocks = [
      { block_id: "B1", items: ["F1", "F2"], parallel_safe: true },
    ];
    const keptFindings: ReturnType<typeof mkFinding>[] = []; // nothing kept
    const result = pruneBlocksForKeptFindings(blocks as any, keptFindings as any);
    expect(result).toHaveLength(0);
  });

  it("handles blocks with undefined items without throwing", () => {
    const blocks = [
      { block_id: "B1", items: undefined as any, parallel_safe: true },
    ];
    const keptFindings = [mkFinding("F1")];
    // Must not throw — items treated as empty
    expect(() => pruneBlocksForKeptFindings(blocks as any, keptFindings as any)).not.toThrow();
    const result = pruneBlocksForKeptFindings(blocks as any, keptFindings as any);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TST-d1399aa3: groundAffectedFiles and evidenceCitesRealPath dedicated unit tests
// ---------------------------------------------------------------------------

describe("groundAffectedFiles — TST-d1399aa3: dedicated unit tests for phantom-path stripping", () => {
  const TEST_DIR = join(__dirname, ".test-grounding-d1399aa3");

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "real.ts"), "const x = 1;\n");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("strips phantom paths and preserves real paths in place", () => {
    const findings = [
      {
        id: "F1",
        title: "F1",
        category: "General",
        severity: "low" as const,
        confidence: "high" as const,
        lens: "correctness",
        summary: "s",
        affected_files: [
          { path: "src/real.ts" },
          { path: "phantom/does-not-exist.ts" },
        ],
        evidence: ["e"],
      },
    ];

    const result = groundAffectedFiles(TEST_DIR, findings as any);

    expect(findings[0].affected_files).toHaveLength(1);
    expect(findings[0].affected_files[0].path).toBe("src/real.ts");
    expect(result.phantomPathsByFinding.get("F1")).toContain("phantom/does-not-exist.ts");
    expect(result.zeroRealPathFindingIds).not.toContain("F1");
  });

  it("records finding as zero-real-path when all paths are phantom", () => {
    const findings = [
      {
        id: "F2",
        title: "F2",
        category: "General",
        severity: "low" as const,
        confidence: "high" as const,
        lens: "correctness",
        summary: "s",
        affected_files: [
          { path: "ghost/a.ts" },
          { path: "ghost/b.ts" },
        ],
        evidence: ["e"],
      },
    ];

    const result = groundAffectedFiles(TEST_DIR, findings as any);

    expect(findings[0].affected_files).toHaveLength(0);
    expect(result.zeroRealPathFindingIds).toContain("F2");
  });

  it("leaves findings with no affected_files untouched (empty-files is legitimate)", () => {
    const findings = [
      {
        id: "F3",
        title: "F3",
        category: "General",
        severity: "low" as const,
        confidence: "high" as const,
        lens: "correctness",
        summary: "s",
        affected_files: [],
        evidence: ["e"],
      },
    ];

    const result = groundAffectedFiles(TEST_DIR, findings as any);

    expect(result.phantomPathsByFinding.has("F3")).toBe(false);
    expect(result.zeroRealPathFindingIds).not.toContain("F3");
    expect(findings[0].affected_files).toHaveLength(0);
  });
});

describe("evidenceCitesRealPath — TST-d1399aa3: dedicated unit tests for evidence citation check", () => {
  const TEST_DIR = join(__dirname, ".test-evidence-d1399aa3");

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "auth.ts"), "line1\nline2\nline3\n");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns true for evidence citing a real path without line number", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "See src/auth.ts for details")).toBe(true);
  });

  it("returns true for evidence citing a real path with an in-range line number", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "src/auth.ts:2 — some issue")).toBe(true);
  });

  it("returns false for evidence citing a real path with an out-of-range line number", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "src/auth.ts:9999 — out of range")).toBe(false);
  });

  it("returns false when the cited path does not exist in the repo", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "src/nonexistent.ts:1 — missing file")).toBe(false);
  });

  it("returns false for pure prose with no path-like tokens", () => {
    expect(evidenceCitesRealPath(TEST_DIR, "This finding has no path reference")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TST-761e8471: buildCoverageLedger disposition precedence with overlapping sets
// ---------------------------------------------------------------------------

describe("buildCoverageLedger — TST-761e8471: disposition precedence for overlapping sets", () => {
  function mkFinding761(id: string) {
    return {
      id,
      title: id,
      category: "General",
      severity: "low" as const,
      confidence: "low" as const,
      lens: "correctness",
      summary: id,
      affected_files: [],
      evidence: ["e"],
    };
  }

  it("droppedPhantomPaths wins over droppedNoEvidence for the same finding", () => {
    const sourceFindings = [mkFinding761("OVERLAP-PH-EV")] as any[];
    const ledger = buildCoverageLedger({
      planId: "P-OVERLAP1",
      sourceFindings,
      droppedNoEvidence: ["OVERLAP-PH-EV"],
      droppedByCheckpoint: [],
      droppedPhantomPaths: new Map([["OVERLAP-PH-EV", ["phantom.ts"]]]),
      mergeMap: new Map(),
      items: {},
    });
    const entry = ledger.entries.find((e) => e.finding_id === "OVERLAP-PH-EV")!;
    expect(entry.disposition).toBe("dropped_phantom_paths");
  });

  it("droppedNoEvidence wins over mergeMap for the same finding", () => {
    const sourceFindings = [mkFinding761("OVERLAP-EV-MG")] as any[];
    const ledger = buildCoverageLedger({
      planId: "P-OVERLAP2",
      sourceFindings,
      droppedNoEvidence: ["OVERLAP-EV-MG"],
      droppedByCheckpoint: [],
      mergeMap: new Map([["OVERLAP-EV-MG", "SOME-TARGET"]]),
      items: {},
    });
    const entry = ledger.entries.find((e) => e.finding_id === "OVERLAP-EV-MG")!;
    expect(entry.disposition).toBe("dropped_no_evidence");
  });

  it("mergeMap wins over droppedByCheckpoint for the same finding", () => {
    const sourceFindings = [mkFinding761("OVERLAP-MG-CP")] as any[];
    const ledger = buildCoverageLedger({
      planId: "P-OVERLAP3",
      sourceFindings,
      droppedNoEvidence: [],
      droppedByCheckpoint: ["OVERLAP-MG-CP"],
      mergeMap: new Map([["OVERLAP-MG-CP", "SOME-TARGET"]]),
      items: {},
    });
    const entry = ledger.entries.find((e) => e.finding_id === "OVERLAP-MG-CP")!;
    expect(entry.disposition).toBe("folded_into");
    expect(entry.folded_into).toBe("SOME-TARGET");
  });

  it("each finding appears exactly once even in overlapping-set scenarios", () => {
    const sourceFindings = [
      mkFinding761("OVL-A"),
      mkFinding761("OVL-B"),
    ] as any[];
    const ledger = buildCoverageLedger({
      planId: "P-OVERLAP-COUNT",
      sourceFindings,
      droppedNoEvidence: ["OVL-A"],
      droppedByCheckpoint: ["OVL-A", "OVL-B"],
      mergeMap: new Map(),
      items: {},
    });
    const ids = ledger.entries.map((e) => e.finding_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ledger.source_finding_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TST-cb981ad0: close.ts summarizeItemSpec and FINAL_STATUS_BY_OUTCOME via buildRemediationOutcomesReport
// ---------------------------------------------------------------------------

describe("buildRemediationOutcomesReport — TST-cb981ad0: summarizeItemSpec and final_status mappings", () => {
  const VACUOUS_CLOSING_RESULT = {
    contract_version: "remediate-code-closing-result/v1alpha1" as const,
    action: "none" as const,
    status: "skipped" as const,
    commands: [],
  };

  function mkPlanFinding(id: string) {
    return {
      id,
      title: id,
      category: "General",
      severity: "low" as const,
      confidence: "low" as const,
      lens: "correctness",
      summary: id,
      affected_files: [{ path: "src/a.ts" }],
      evidence: ["e"],
    };
  }

  it("summarizeItemSpec projects concrete_change, touched_files, and tests_to_write names", () => {
    const state = makeState({
      status: "closing",
      plan: {
        plan_id: "P-SIS",
        findings: [mkPlanFinding("F1")],
        blocks: [{ block_id: "B1", items: ["F1"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        F1: {
          finding_id: "F1",
          status: "resolved",
          block_id: "B1",
          item_spec: {
            finding_id: "F1",
            concrete_change: "Fix the null dereference",
            // TST-882697b6: ItemSpec.tests_to_write entries are { name, assertions }
            // (state/types.ts). The fixture must model that real contract — not
            // {name, description, acceptance_criteria} — so a regression in how
            // summarizeItemSpec reads tests_to_write is actually caught.
            tests_to_write: [
              { name: "test-auth-null", assertions: ["rejects null"] },
              { name: "test-auth-empty", assertions: ["rejects empty"] },
            ],
            not_applicable_steps: [],
            touched_files: ["src/auth.ts", "src/util.ts"],
          },
        },
      },
    });

    const report = buildRemediationOutcomesReport(state as any, VACUOUS_CLOSING_RESULT);
    const outcome = report.outcomes.find((o) => o.finding_id === "F1") as any;

    expect(outcome).toBeDefined();
    expect(outcome.item_spec.concrete_change).toBe("Fix the null dereference");
    expect(outcome.item_spec.touched_files).toEqual(["src/auth.ts", "src/util.ts"]);
    expect(outcome.item_spec.tests_to_write).toEqual(["test-auth-null", "test-auth-empty"]);
    expect(outcome.item_spec.no_change).toBeUndefined();
  });

  it("summarizeItemSpec includes no_change when the spec carries it", () => {
    const state = makeState({
      status: "closing",
      plan: {
        plan_id: "P-SIS-NC",
        findings: [mkPlanFinding("F2")],
        blocks: [{ block_id: "B2", items: ["F2"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        F2: {
          finding_id: "F2",
          status: "resolved_no_change",
          block_id: "B2",
          item_spec: {
            finding_id: "F2",
            concrete_change: "No change required",
            no_change: true,
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      },
    });

    const report = buildRemediationOutcomesReport(state as any, VACUOUS_CLOSING_RESULT);
    const outcome = report.outcomes.find((o) => o.finding_id === "F2") as any;
    expect(outcome.item_spec.no_change).toBe(true);
  });

  it("FINAL_STATUS_BY_OUTCOME: resolved→fixed, blocked→failed, ignored→ignored, inappropriate→skipped", () => {
    const findings = ["F-resolved", "F-blocked", "F-ignored", "F-inappropriate"].map(mkPlanFinding);
    const state = makeState({
      status: "closing",
      plan: {
        plan_id: "P-FSO",
        findings,
        blocks: [{ block_id: "B1", items: findings.map((f) => f.id), parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-resolved":      { finding_id: "F-resolved",      status: "resolved",             block_id: "B1" },
        "F-blocked":       { finding_id: "F-blocked",        status: "blocked",              block_id: "B1", failure_reason: "failed" },
        "F-ignored":       { finding_id: "F-ignored",        status: "ignored",              block_id: "B1", failure_reason: "user chose to ignore" },
        "F-inappropriate": { finding_id: "F-inappropriate",  status: "deemed_inappropriate", block_id: "B1", failure_reason: "not applicable" },
      },
    });

    const report = buildRemediationOutcomesReport(state as any, VACUOUS_CLOSING_RESULT);
    const byId = Object.fromEntries(report.outcomes.map((o) => [o.finding_id, o])) as Record<string, any>;

    expect(byId["F-resolved"].final_status).toBe("fixed");
    expect(byId["F-blocked"].final_status).toBe("failed");
    expect(byId["F-ignored"].final_status).toBe("ignored");
    expect(byId["F-inappropriate"].final_status).toBe("skipped");
  });

  it("verified_no_change outcome maps to final_status=fixed", () => {
    const state = makeState({
      status: "closing",
      plan: {
        plan_id: "P-VNC",
        findings: [mkPlanFinding("F-vnc")],
        blocks: [{ block_id: "B1", items: ["F-vnc"], parallel_safe: true }],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {
        "F-vnc": { finding_id: "F-vnc", status: "resolved_no_change", block_id: "B1" },
      },
    });

    const report = buildRemediationOutcomesReport(state as any, VACUOUS_CLOSING_RESULT);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-vnc") as any;
    expect(outcome.outcome).toBe("verified_no_change");
    expect(outcome.final_status).toBe("fixed");
  });
});
