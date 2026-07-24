import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyPlanPipeline,
  mergeBlocksSharingFiles,
  buildCoverageLedger,
  splitBlocksByContextBudget,
  estimateGroupTokens,
  ESTIMATED_BLOCK_BASE_TOKENS,
  ESTIMATED_FINDING_OVERHEAD_TOKENS,
} from "../../src/remediate/phases/plan.js";
import { checkAffectedFileIntegrity } from "../../src/remediate/utils/fileIntegrity.js";
import { scratchDir } from "../helpers/scratch.js";

// Derive the directory in ESM (no implicit `__dirname` under NodeNext/ESM).
const testDir = dirname(fileURLToPath(import.meta.url));

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

describe("mergeBlocksSharingFiles", () => {
  const f = (id: string, file: string) => mkFinding(id, id, { files: [file] });

  it("A3: independent parallel blocks sharing a file stay SEPARATE, each cofile_parallel_safe", () => {
    const findings = [f("F-1", "shared.ts"), f("F-2", "shared.ts")];
    const blocks = [
      { block_id: "B-001", items: ["F-1"], parallel_safe: true },
      { block_id: "B-002", items: ["F-2"], parallel_safe: true },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any);
    expect(merged).toHaveLength(2);
    expect(merged.map((b) => b.block_id).sort()).toEqual(["B-001", "B-002"]);
    for (const b of merged) expect(b.cofile_parallel_safe).toBe(true);
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

  it("CE-008/A3: blocks citing one physical file under different spellings share via canonical identity", () => {
    // `src/x.ts` vs `./src/x.ts` are the SAME physical file. Under A3 they are no
    // longer unioned, but the canonical-identity share detection still applies —
    // both independent blocks are flagged cofile_parallel_safe.
    const findings = [f("F-1", "src/x.ts"), f("F-2", "./src/x.ts")];
    const blocks = [
      { block_id: "B-001", items: ["F-1"], parallel_safe: true },
      { block_id: "B-002", items: ["F-2"], parallel_safe: true },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any, "/repo");
    expect(merged).toHaveLength(2);
    for (const b of merged) expect(b.cofile_parallel_safe).toBe(true);
  });

  it("CE-008: distinct files under different spellings still do NOT merge", () => {
    const findings = [f("F-1", "src/x.ts"), f("F-2", "./src/y.ts")];
    const blocks = [
      { block_id: "B-001", items: ["F-1"], parallel_safe: true },
      { block_id: "B-002", items: ["F-2"], parallel_safe: true },
    ];
    const merged = mergeBlocksSharingFiles(blocks, findings as any, "/repo");
    expect(merged).toHaveLength(2);
  });

  it("A3: independent co-file blocks are NOT unioned, so no dependency remap occurs", () => {
    // B-001 and B-002 are independent findings on shared.ts — under A3 they stay
    // separate (flagged parallel-safe), NOT unioned. B-003 depends on B-002 and
    // keeps that edge unchanged (nothing was remapped).
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
    expect(merged).toHaveLength(3);
    expect(
      merged.find((b) => b.block_id === "B-001")!.cofile_parallel_safe,
    ).toBe(true);
    expect(
      merged.find((b) => b.block_id === "B-002")!.cofile_parallel_safe,
    ).toBe(true);
    const b3 = merged.find((b) => b.block_id === "B-003")!;
    expect(b3.dependencies).toEqual(["B-002"]);
  });
});

// ── MNT-6b371840: splitBlocksByContextBudget rewrites dependent block dependencies after a split ──

describe("splitBlocksByContextBudget — dependency remap after split", () => {
  // Tiny budget: base+overhead only, so any non-empty file forces a split across groups.
  // We use in-memory findings with no actual files (size=0 bytes → 0 extra tokens),
  // so we set the budget to just above one group's overhead to trigger splits easily.
  const perGroupTokens = ESTIMATED_BLOCK_BASE_TOKENS + ESTIMATED_FINDING_OVERHEAD_TOKENS;
  const tightBudget = perGroupTokens + 1; // fits exactly one finding group

  function finding(id: string, file: string) {
    return {
      id,
      title: id,
      category: "correctness",
      severity: "low" as const,
      confidence: "high" as const,
      lens: "correctness" as const,
      summary: `summary ${id}`,
      affected_files: [{ path: file }],
      evidence: ["Evidence."],
    };
  }

  it("rewrites B's dependencies from A to [A-01, A-02] when A is split", () => {
    // A has 2 findings on separate files → forced into 2 sub-blocks.
    // B depends on A; after the split B should depend on [A-01, A-02].
    const findings = [
      finding("FA1", "file-a1.ts"),
      finding("FA2", "file-a2.ts"),
      finding("FB1", "file-b1.ts"),
    ];
    const blocks = [
      { block_id: "A", items: ["FA1", "FA2"], parallel_safe: true },
      { block_id: "B", items: ["FB1"], parallel_safe: false, dependencies: ["A"] },
    ];
    // root is not used for file-size stats when files are absent (returns 0 bytes)
    const result = splitBlocksByContextBudget(blocks as any, findings as any, "/tmp", tightBudget);

    // A must be split into A-01 and A-02
    const subA = result.filter((b) => b.block_id.startsWith("A-"));
    expect(subA).toHaveLength(2);
    expect(subA.map((b) => b.block_id).sort()).toEqual(["A-01", "A-02"]);

    // B must have its dependencies expanded to the two sub-block IDs
    const blockB = result.find((b) => b.block_id === "B");
    expect(blockB).toBeDefined();
    expect(blockB!.dependencies!.sort()).toEqual(["A-01", "A-02"]);
  });

  it("leaves B's dependencies unchanged when A fits within budget (no split)", () => {
    const findings = [
      finding("FA1", "file-a1.ts"),
      finding("FB1", "file-b1.ts"),
    ];
    const blocks = [
      { block_id: "A", items: ["FA1"], parallel_safe: true },
      { block_id: "B", items: ["FB1"], parallel_safe: false, dependencies: ["A"] },
    ];
    // Budget is large enough that A's single finding never splits
    const result = splitBlocksByContextBudget(blocks as any, findings as any, "/tmp", 1_000_000);

    const blockA = result.find((b) => b.block_id === "A");
    expect(blockA).toBeDefined();
    const blockB = result.find((b) => b.block_id === "B");
    expect(blockB!.dependencies).toEqual(["A"]);
  });

  it("leaves C's dependency on B unchanged when only A splits (B did not split)", () => {
    const findings = [
      finding("FA1", "file-a1.ts"),
      finding("FA2", "file-a2.ts"),
      finding("FB1", "file-b1.ts"),
      finding("FC1", "file-c1.ts"),
    ];
    const blocks = [
      { block_id: "A", items: ["FA1", "FA2"], parallel_safe: true },
      { block_id: "B", items: ["FB1"], parallel_safe: false, dependencies: ["A"] },
      { block_id: "C", items: ["FC1"], parallel_safe: false, dependencies: ["B"] },
    ];
    const result = splitBlocksByContextBudget(blocks as any, findings as any, "/tmp", tightBudget);

    // A was split; B was not
    const blockC = result.find((b) => b.block_id === "C");
    expect(blockC!.dependencies).toEqual(["B"]);
  });

  it("expands dependencies in B's sub-blocks when both A and B split", () => {
    // A: FA1, FA2 (2 separate files → 2 sub-blocks under tight budget)
    // B: FB1, FB2 (2 separate files → 2 sub-blocks under tight budget), depends on A
    const findings = [
      finding("FA1", "fa1.ts"),
      finding("FA2", "fa2.ts"),
      finding("FB1", "fb1.ts"),
      finding("FB2", "fb2.ts"),
    ];
    const blocks = [
      { block_id: "A", items: ["FA1", "FA2"], parallel_safe: true },
      { block_id: "B", items: ["FB1", "FB2"], parallel_safe: false, dependencies: ["A"] },
    ];
    const result = splitBlocksByContextBudget(blocks as any, findings as any, "/tmp", tightBudget);

    const subB = result.filter((b) => b.block_id.startsWith("B-"));
    expect(subB).toHaveLength(2);
    for (const b of subB) {
      // Each B sub-block should reference both A sub-block IDs
      expect(b.dependencies!.sort()).toEqual(["A-01", "A-02"]);
    }
  });

  it("carries the split block's own dependencies unchanged onto sub-blocks", () => {
    // Prereq → A → B (B splits). B's sub-blocks should still carry A as their
    // prerequisite, and Prereq should not be affected at all by the remap.
    const findings = [
      finding("FP1", "pre1.ts"),
      finding("FA1", "a1.ts"),
      finding("FB1", "b1.ts"),
      finding("FB2", "b2.ts"),
    ];
    const blocks = [
      { block_id: "Prereq", items: ["FP1"], parallel_safe: true },
      { block_id: "A", items: ["FA1"], parallel_safe: false, dependencies: ["Prereq"] },
      { block_id: "B", items: ["FB1", "FB2"], parallel_safe: false, dependencies: ["A"] },
    ];
    const result = splitBlocksByContextBudget(blocks as any, findings as any, "/tmp", tightBudget);

    // A did not split (single finding); B did split into B-01 and B-02
    const blockA = result.find((b) => b.block_id === "A");
    expect(blockA).toBeDefined();
    expect(blockA!.dependencies).toEqual(["Prereq"]);

    const subB = result.filter((b) => b.block_id.startsWith("B-"));
    expect(subB).toHaveLength(2);
    // B's sub-blocks inherit B's original dependency on A (not affected by any remap)
    for (const b of subB) {
      expect(b.dependencies).toEqual(["A"]);
    }
  });

  it("splits an oversized hub-file overlap group into deterministic sub-blocks", () => {
    const findings = Array.from({ length: 5 }, (_, index) => {
      const id = `FH${index + 1}`;
      return finding(id, `src/leaf-${index + 1}.ts`);
    });
    for (const f of findings) {
      f.affected_files.unshift({ path: "src/hub.ts" });
    }
    const blocks = [
      {
        block_id: "Hub",
        items: findings.map((f) => f.id),
        parallel_safe: true,
      },
    ];

    const result = splitBlocksByContextBudget(
      blocks as any,
      findings as any,
      "/tmp",
      tightBudget,
    );

    expect(result.length).toBeGreaterThan(1);
    expect(result.map((b) => b.block_id)).toEqual([
      "Hub-01",
      "Hub-02",
      "Hub-03",
      "Hub-04",
      "Hub-05",
    ]);
    expect(result.flatMap((b) => b.items).sort()).toEqual(
      findings.map((f) => f.id).sort(),
    );
  });

  it("keeps small same-file conflict groups together when they fit", () => {
    const findings = [
      finding("FS1", "src/shared-small.ts"),
      finding("FS2", "src/shared-small.ts"),
    ];
    const blocks = [
      {
        block_id: "Small",
        items: ["FS1", "FS2"],
        parallel_safe: true,
      },
    ];

    const result = splitBlocksByContextBudget(
      blocks as any,
      findings as any,
      "/tmp",
      ESTIMATED_BLOCK_BASE_TOKENS + 2 * ESTIMATED_FINDING_OVERHEAD_TOKENS + 1,
    );

    expect(result).toHaveLength(1);
    expect(result[0].block_id).toBe("Small");
    expect(result[0].items).toEqual(["FS1", "FS2"]);
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
      droppedByCheckpoint: [],
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

  it("records review-gate declines as in-source declined_by_review entries (part of reconciliation)", () => {
    // On Path A the coverage source IS the original findings; a declined finding
    // is a filter-pass survivor the user disapproved, so it is an in-source
    // disposition (like dropped_by_checkpoint) and counts toward the source total.
    const sourceFindings = [
      mkFinding("NODE-1", "Planned", { files: ["a.ts"] }),
      mkFinding("ARC-001", "Declined one", { files: ["b.ts"] }),
      mkFinding("ARC-002", "Declined two", { files: ["c.ts"] }),
    ];
    const ledger = buildCoverageLedger({
      planId: "PLAN-DECL",
      sourceFindings: sourceFindings as any,
      droppedNoEvidence: [],
      droppedByCheckpoint: [],
      declinedByReview: [
        { finding_id: "ARC-001", reason: "Disapproved by the user at the review gate." },
        { finding_id: "ARC-002", reason: "Disapproved by the user at the review gate." },
      ],
      mergeMap: new Map(),
      items: { "NODE-1": { finding_id: "NODE-1", status: "pending", block_id: "B-001" } },
    });

    expect(ledger.source_finding_count).toBe(3);
    expect(ledger.planned_count).toBe(1);
    expect(ledger.declined_review_count).toBe(2);
    // Every original finding gets exactly one disposition — declines included.
    const total =
      ledger.planned_count +
      ledger.folded_count +
      ledger.dropped_count +
      ledger.checkpoint_dropped_count +
      ledger.phantom_dropped_count +
      (ledger.declined_review_count ?? 0);
    expect(total).toBe(ledger.source_finding_count);
    const byId = Object.fromEntries(ledger.entries.map((e) => [e.finding_id, e]));
    expect(byId["ARC-001"].disposition).toBe("declined_by_review");
    expect(byId["ARC-001"].rationale).toMatch(/review gate/i);
    expect(byId["ARC-002"].disposition).toBe("declined_by_review");
    expect(ledger.entries).toHaveLength(3);
  });
});

// ── MNT-1905694f: applyPlanPipeline ──────────────────────────────────────────

describe("applyPlanPipeline (MNT-1905694f)", () => {
  const PIPELINE_TEST_DIR = scratchDir(".test-plan-pipeline");

  beforeEach(async () => {
    await rm(PIPELINE_TEST_DIR, { recursive: true, force: true });
    await mkdir(PIPELINE_TEST_DIR, { recursive: true });
    // Several cases write source files under src/ (e.g. src/big.ts); writeFile
    // does not create parent dirs, so ensure src/ exists up front.
    await mkdir(join(PIPELINE_TEST_DIR, "src"), { recursive: true });
  });

  afterEach(async () => {
    await rm(PIPELINE_TEST_DIR, { recursive: true, force: true });
  });

  it("normalizeExtractedPlan path: A3 keeps independent file-sharing blocks separate + parallel-safe (MNT-1905694f)", async () => {
    // Two independent findings that both touch shared.ts in separate blocks.
    const sharedFile = "src/shared.ts";
    const fA = mkFinding("F-A", "Finding A", { files: [sharedFile], evidence: ["evidence A"] });
    const fB = mkFinding("F-B", "Finding B", { files: [sharedFile], evidence: ["evidence B"] });

    const inputPlan = {
      plan_id: "PLAN-test",
      findings: [fA, fB] as any[],
      blocks: [
        { block_id: "B-001", items: ["F-A"], parallel_safe: true, dependencies: [] },
        { block_id: "B-002", items: ["F-B"], parallel_safe: true, dependencies: [] },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"] as any,
    };

    const result = await applyPlanPipeline(inputPlan, { root: PIPELINE_TEST_DIR });

    // A3: independent same-file blocks are NOT unioned — kept separate, each flagged.
    expect(result.blocks).toHaveLength(2);
    for (const b of result.blocks) expect(b.cofile_parallel_safe).toBe(true);
  });

  it("normalizeExtractedPlan path: dependency-ordered file-sharing blocks stay separate and non-parallel-safe", async () => {
    const sharedFile = "src/shared.ts";
    const fA = mkFinding("F-A", "Finding A", { files: [sharedFile], evidence: ["e"] });
    const fB = mkFinding("F-B", "Finding B", { files: [sharedFile], evidence: ["e"] });

    // B-002 depends on B-001. Even though both touch shared.ts, the existing
    // dependency already serializes them, so mergeBlocksSharingFiles must NOT
    // fuse them (the `!ordered` guard): the dependency edge prevents the parallel
    // file-clobber the merge exists to avoid. The dependent block stays
    // non-parallel-safe.
    const inputPlan = {
      plan_id: "PLAN-test",
      findings: [fA, fB] as any[],
      blocks: [
        { block_id: "B-001", items: ["F-A"], parallel_safe: true, dependencies: [] },
        { block_id: "B-002", items: ["F-B"], parallel_safe: false, dependencies: ["B-001"] },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"] as any,
    };

    const result = await applyPlanPipeline(inputPlan, { root: PIPELINE_TEST_DIR });

    // Already dependency-ordered → not merged; both blocks survive.
    expect(result.blocks).toHaveLength(2);
    const dependent = result.blocks.find((b) => b.block_id === "B-002");
    expect(dependent?.parallel_safe).toBe(false);
    expect(dependent?.dependencies).toContain("B-001");
  });

  it("normalizeExtractedPlan path: splitBlocksByContextBudget splits an oversized block (MNT-1905694f)", async () => {
    // Two large files, one per finding. The findings must touch DIFFERENT files
    // so groupFindingsByFileOverlap puts them in separate file-overlap groups —
    // the splitter only divides a block at group boundaries, never within a group
    // of findings that share a file (those must stay together to avoid clobbering).
    const bigFileA = "src/big-a.ts";
    const bigFileB = "src/big-b.ts";
    const bigContent = "x".repeat(200_000); // ~200 KB each → well over any tiny budget
    await writeFile(join(PIPELINE_TEST_DIR, bigFileA), bigContent, "utf8");
    await writeFile(join(PIPELINE_TEST_DIR, bigFileB), bigContent, "utf8");

    // Write a small session-config.json to force a tiny context budget.
    const sessionConfig = {
      block_quota: { context_tokens: 100, reserved_output_tokens: 10 },
    };
    await writeFile(
      join(PIPELINE_TEST_DIR, "session-config.json"),
      JSON.stringify(sessionConfig),
      "utf8",
    );

    // Build a block with two independent findings pointing at the two big files.
    const fA = mkFinding("F-A", "Finding A", { files: [bigFileA], evidence: ["e"] });
    const fB = mkFinding("F-B", "Finding B", { files: [bigFileB], evidence: ["e"] });

    const inputPlan = {
      plan_id: "PLAN-test",
      findings: [fA, fB] as any[],
      blocks: [
        { block_id: "B-001", items: ["F-A", "F-B"], parallel_safe: true, dependencies: [] },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"] as any,
    };

    const result = await applyPlanPipeline(inputPlan, { root: PIPELINE_TEST_DIR });

    // With an absurdly tiny budget, the single block must be split into multiple.
    expect(result.blocks.length).toBeGreaterThan(1);
    // Sub-blocks should follow the '<original>-NN' suffix pattern.
    for (const block of result.blocks) {
      expect(block.block_id).toMatch(/^B-001-\d+$/);
    }
  });

  it("normalizeExtractedPlan path: snapshotAffectedFileHashes records baseline so integrity is clean (MNT-1905694f)", async () => {
    const trackedFile = "src/tracked.ts";
    await writeFile(join(PIPELINE_TEST_DIR, trackedFile), "original content", "utf8");

    const f = mkFinding("F-1", "Finding 1", { files: [trackedFile], evidence: ["e"] });
    const inputPlan = {
      plan_id: "PLAN-test",
      findings: [f] as any[],
      blocks: [
        { block_id: "B-001", items: ["F-1"], parallel_safe: true, dependencies: [] },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"] as any,
    };

    await applyPlanPipeline(inputPlan, { root: PIPELINE_TEST_DIR });

    // After applyPlanPipeline, the file snapshot should exist and the integrity
    // check should report clean (the file has not been modified since the snapshot).
    const integrity = await checkAffectedFileIntegrity(PIPELINE_TEST_DIR, [f] as any);
    expect(integrity.is_clean).toBe(true);
  });
});

// ── FINDING-014: directory path exclusion from overlap grouping ───────────────

describe("splitBlocksByContextBudget — directory path exclusion (FINDING-014)", () => {
  const DIR_TEST_DIR = scratchDir(".test-plan-dir-exclusion");

  beforeEach(async () => {
    await rm(DIR_TEST_DIR, { recursive: true, force: true });
    await mkdir(DIR_TEST_DIR, { recursive: true });
  }, 30_000);

  afterEach(async () => {
    await rm(DIR_TEST_DIR, { recursive: true, force: true });
  }, 30_000);

  it("does not lock all findings into one block when they share only a directory path", async () => {
    // Reproduce the mega-block bug: many findings reference a broad directory path;
    // without directory exclusion from union-find, all land in one group whose
    // estimate fits the budget → no split → 1 indivisible mega-block.
    await mkdir(join(DIR_TEST_DIR, "src"), { recursive: true });

    const findings = Array.from({ length: 22 }, (_, i) =>
      mkFinding(`FD${i + 1}`, `Finding ${i + 1}`, { files: ["src"], evidence: ["e"] }),
    );
    const blocks = [{ block_id: "B-001", items: findings.map((f) => f.id), parallel_safe: true }];
    // Budget = 20,000: without directory exclusion, 22 × 600 + 900 = 14,100 < 20,000 → 1 block.
    // With directory exclusion from union-find, 22 independent groups × 1,500 tokens → 2 blocks.
    const result = splitBlocksByContextBudget(blocks as any, findings as any, DIR_TEST_DIR, 20_000);

    expect(result.length).toBeGreaterThan(1);
    expect(result.flatMap((b) => b.items).sort()).toEqual(findings.map((f) => f.id).sort());
  });

  it("keeps findings sharing a concrete file grouped when they fit within budget", async () => {
    await mkdir(join(DIR_TEST_DIR, "src"), { recursive: true });
    await writeFile(join(DIR_TEST_DIR, "src", "shared.ts"), "// small", "utf8");

    const findings = [
      mkFinding("FA", "A", { files: ["src/shared.ts"], evidence: ["e"] }),
      mkFinding("FB", "B", { files: ["src/shared.ts"], evidence: ["e"] }),
    ];
    const blocks = [{ block_id: "B-001", items: ["FA", "FB"], parallel_safe: true }];

    const result = splitBlocksByContextBudget(blocks as any, findings as any, DIR_TEST_DIR, 1_000_000);

    expect(result).toHaveLength(1);
    expect(result[0].items.sort()).toEqual(["FA", "FB"].sort());
  });

  it("CE-008: same physical file under two spellings groups via canonical overlap", async () => {
    // FA cites `src/shared.ts`, FB cites `./src/shared.ts` — one physical file.
    // Canonical overlap keying unions them into ONE group so they never split
    // into parallel sub-blocks that clobber it. Raw-string keying would treat the
    // two spellings as distinct files (no overlap) and could split them apart.
    await mkdir(join(DIR_TEST_DIR, "src"), { recursive: true });
    await writeFile(join(DIR_TEST_DIR, "src", "shared.ts"), "// small", "utf8");

    const findings = [
      mkFinding("FA", "A", { files: ["src/shared.ts"], evidence: ["e"] }),
      mkFinding("FB", "B", { files: ["./src/shared.ts"], evidence: ["e"] }),
    ];
    const blocks = [{ block_id: "B-001", items: ["FA", "FB"], parallel_safe: true }];

    const result = splitBlocksByContextBudget(blocks as any, findings as any, DIR_TEST_DIR, 1_000_000);

    expect(result).toHaveLength(1);
    expect(result[0].items.sort()).toEqual(["FA", "FB"].sort());
  });

  it("uses directory walk to produce accurate byte estimates for directory paths", async () => {
    // walkDirBytes must return real content size, not stat().size which is ~0 on
    // Windows and 4096 on Linux — both far below the actual content bytes.
    const srcDir = join(DIR_TEST_DIR, "src");
    await mkdir(srcDir, { recursive: true });
    const fileContent = "x".repeat(5_000);
    for (let i = 0; i < 6; i++) {
      await writeFile(join(srcDir, `module-${i}.ts`), fileContent, "utf8");
    }
    // 6 findings, each referencing only the directory (no unique file).
    const findings = Array.from({ length: 6 }, (_, i) =>
      mkFinding(`FD${i + 1}`, `Finding ${i + 1}`, { files: ["src"], evidence: ["e"] }),
    );
    const blocks = [{ block_id: "B-001", items: findings.map((f) => f.id), parallel_safe: true }];
    // Each finding group: base(900) + walkDirBytes(~30 000 bytes)/4(~7 500) + overhead(600) = ~9 000.
    // Budget = 10 000: one fits (9 000 ≤ 10 000), two do not (18 000 > 10 000) → 6 blocks.
    const result = splitBlocksByContextBudget(blocks as any, findings as any, DIR_TEST_DIR, 10_000);

    expect(result.length).toBe(6);
    expect(result.flatMap((b) => b.items).sort()).toEqual(findings.map((f) => f.id).sort());
  });
});

// ── N-S04: estimateGroupTokens uses shared constants ─────────────────────────

describe("estimateGroupTokens uses shared constants (N-S04)", () => {
  function finding(id: string, files: string[]) {
    return {
      id,
      title: id,
      category: "correctness",
      severity: "low" as const,
      confidence: "high" as const,
      lens: "correctness" as const,
      summary: `summary ${id}`,
      affected_files: files.map((path) => ({ path })),
      evidence: ["Evidence."],
    };
  }

  it("empty findings returns ESTIMATED_PROMPT_OVERHEAD_TOKENS (900)", () => {
    const result = estimateGroupTokens([], [], new Map());
    // 900 base + estimateTokensFromBytes(0) + 0 items * 600 = 900
    expect(result).toBe(ESTIMATED_BLOCK_BASE_TOKENS);
    expect(result).toBe(900);
  });

  it("one finding with 400 bytes returns 900 + 100 + 600 = 1600", () => {
    const f = finding("F1", ["src/a.ts"]);
    const fileByteCounts = new Map([["src/a.ts", 400]]);
    const result = estimateGroupTokens(["F1"], [f as any], fileByteCounts);
    // 900 base + ceil(400/4)=100 file tokens + 1*600 item overhead = 1600
    expect(result).toBe(ESTIMATED_BLOCK_BASE_TOKENS + 100 + ESTIMATED_FINDING_OVERHEAD_TOKENS);
    expect(result).toBe(1600);
  });

  it("two findings returns base + file_bytes_tokens + 2 * ESTIMATED_FINDING_OVERHEAD_TOKENS", () => {
    const f1 = finding("F1", ["src/a.ts"]);
    const f2 = finding("F2", ["src/b.ts"]);
    // 200 bytes each → 50 tokens each → 100 total file tokens
    const fileByteCounts = new Map([["src/a.ts", 200], ["src/b.ts", 200]]);
    const result = estimateGroupTokens(["F1", "F2"], [f1 as any, f2 as any], fileByteCounts);
    // 900 + ceil(200/4)+ceil(200/4) + 2*600 = 900 + 50 + 50 + 1200 = 2200
    expect(result).toBe(ESTIMATED_BLOCK_BASE_TOKENS + 100 + 2 * ESTIMATED_FINDING_OVERHEAD_TOKENS);
    expect(result).toBe(2200);
  });
});

