/**
 * Reviewed unit contracts survive scheduling unchanged; dependency ordering is preserved
 * INV-remediate-phases-04: buildCoverageLedger — every source finding has exactly one disposition
 * INV-remediate-phases-05: runTriagePhase uses a unified auto-retry cap
 * INV-remediate-phases-06: runClosePhase preview gate blocks unconfirmed closing actions
 * INV-remediate-phases-07: collectStagingFiles excludes .audit-tools/ and .env* patterns
 * INV-remediate-phases-08: groundExtractedFindings repair hook is called exactly once for all-phantom findings
 * INV-remediate-phases-09: explicit action:"retry" in resolution overrides rationale heuristic
 * INV-remediate-phases-10: ClosingResult always carries contract_version field
 * TST-d1399aa3: groundAffectedFiles and evidenceCitesRealPath dedicated unit tests
 * TST-761e8471: buildCoverageLedger disposition precedence with overlapping sets
 * TST-cb981ad0: close.ts FINAL_STATUS_BY_OUTCOME via buildRemediationOutcomesReport
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import {
  buildCoverageLedger,
} from "../../src/remediate/phases/plan.js";
import { collectStagingFiles, executeClosingAction, runClosePhase, buildRemediationOutcomesReport } from "../../src/remediate/phases/close.js";
import { groundExtractedFindings, groundAffectedFiles, evidenceCitesRealPath } from "../../src/remediate/phases/grounding.js";
import { enumerateTrackedFilePaths } from "audit-tools/shared";
import { runTriagePhase } from "../../src/remediate/phases/triage.js";
import type { ExecutionUnit } from "../../src/remediate/state/types.js";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { hostDependencyLevels } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "../../src/remediate/state/store.js";
import { REMEDIATION_OUTCOMES_CONTRACT_VERSION } from "../../src/shared/types/remediationOutcome.js";
import type { ClosingPlan } from "../../src/remediate/state/types.js";
import { makeState } from "./test-helpers.js";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The reviewed executable plan replaces post-review block regrouping. These
// tests pin its live replacement: scheduling never rewrites unit contracts.
function planForUnits(units: ExecutionUnit[]) {
  return canonicalPlanFixture({ units, requirements: units.map(unit => ({
    id: unit.requirement_ids[0]!, description: unit.description, source_finding_ids: unit.source_finding_ids,
    change_kind: "structural", assertions: [], inapplicable_reason: "Scheduling fixture; no implementation runs",
  })) });
}
function runtimeForUnits(units: ExecutionUnit[]): RemediationState {
  return { contract_version: REMEDIATION_STATE_CONTRACT_VERSION, status: "implementing", plan: planForUnits(units),
    items: Object.fromEntries(units.map(unit => [unit.id, { unit_id: unit.id, status: "pending" }])),
  };
}
describe("reviewed execution-unit scheduling preserves authored boundaries", () => {
  it("does not regroup independent reviewed units sharing a file", () => {
    const units = [canonicalUnitFixture("U1"), canonicalUnitFixture("U2")];
    const state = runtimeForUnits(units);
    const before = JSON.stringify(state.plan);
    expect(hostDependencyLevels(state).flat().map(unit => unit.id)).toEqual(["U1", "U2"]);
    expect(JSON.stringify(state.plan)).toBe(before);
  });
  it("serialized units may share a file without merging their identity", () => {
    const state = runtimeForUnits([canonicalUnitFixture("U1"), canonicalUnitFixture("U2", { dependencies: ["U1"] })]);
    expect(hostDependencyLevels(state).map(level => level.map(unit => unit.id))).toEqual([["U1"], ["U2"]]);
    state.items!.U1.status = "resolved";
    expect(hostDependencyLevels(state).flat().map(unit => unit.id)).toEqual(["U2"]);
    expect(state.plan!.units.map(unit => unit.id)).toEqual(["U1", "U2"]);
  });
  it("a singleton remains exactly the reviewed unit", () => {
    const unit = canonicalUnitFixture("U1");
    expect(hostDependencyLevels(runtimeForUnits([unit]))).toEqual([[unit]]);
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

  it("accounts for all five disposition cases without overlap", async () => {
    const sourceFindings = [
      mkFinding("PLANNED"),
      mkFinding("FOLDED"),
      mkFinding("DROPPED-EV"),
      mkFinding("DROPPED-CP"),
      mkFinding("DROPPED-PH"),
    ] as any[];


    const ledger = buildCoverageLedger({
      planId: "P-INV04",
      sourceFindings,
      droppedNoEvidence: ["DROPPED-EV"],
      droppedByCheckpoint: ["DROPPED-CP"],
      droppedPhantomPaths: new Map([["DROPPED-PH", ["src/phantom.ts"]]]),
      phantomPathsRemoved: undefined,
      mergeMap: new Map([["FOLDED", "PLANNED"]]),
      units: [canonicalUnitFixture("U-planned", { source_finding_ids: ["PLANNED"] })],
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

  it("an empty source set produces a ledger with all counts zero", async () => {
    const ledger = buildCoverageLedger({
      planId: "P-EMPTY",
      sourceFindings: [],
      droppedNoEvidence: [],
      droppedByCheckpoint: [],
      mergeMap: new Map(),
      units: [],
    });
    expect(ledger.source_finding_count).toBe(0);
    expect(ledger.planned_count).toBe(0);
    expect(ledger.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-05: auto-retry cap is content-agnostic
// ---------------------------------------------------------------------------

describe("runTriagePhase — INV-remediate-phases-05: unified auto-retry cap", () => {
  const TEST_DIR = scratchDir(".test-phases-inv-05");
  const BASE_OPTIONS = { root: dirname(TEST_DIR), artifactsDir: TEST_DIR };

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("a failure at the unified cap routes to human triage", async () => {
    const state = makeState({
      status: "triage",
      plan: planForUnits([canonicalUnitFixture("F1")]),
      items: {
        F1: {
          unit_id: "F1",
          status: "blocked",
          failure_reason: "test assertion failed — wrong output",
          rework_count: 2,
        },
      },
    });
    const next = await runTriagePhase(state, BASE_OPTIONS);
    // Unified cap exhausted → wait for human.
    expect(next.status).toBe("waiting_for_triage");
    expect(state.items!.F1.status).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-06: runClosePhase preview gate
// ---------------------------------------------------------------------------

describe("runClosePhase — INV-remediate-phases-06: preview gate blocks unconfirmed actions", () => {
  const REPO_DIR = scratchDir(".test-phases-inv-06-repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");
  const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR };

  function makeClosingState(overrides: Record<string, unknown> = {}) {
    return makeState({
      status: "closing",
      plan: canonicalPlanFixture({ plan_id: "P1", candidate_closing_actions: ["none"] }),
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
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state, REPO_DIR);
    const next = await runClosePhase(state, BASE_OPTIONS);
    // Must stop at preview
    expect(next.status).toBe("closing");
    expect(next.closing_plan!.closing_action_preview).toBeDefined();
  });

  it("action=commit with pre_authorized:true bypasses preview and reaches complete", async () => {
    const state = makeClosingState({
      closing_plan: { action: "commit", pre_authorized: true },
    });
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state, REPO_DIR);
    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");
    expect(next.closing_plan!.closing_action_preview).toBeUndefined();
  });

  it("action=none never triggers a preview regardless of pre_authorized", async () => {
    const state = makeClosingState({ closing_plan: { action: "none" } });
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state, REPO_DIR);
    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");
    expect(next.closing_plan!.closing_action_preview).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-07: collectStagingFiles excludes .audit-tools/ and .env*
// ---------------------------------------------------------------------------

describe("collectStagingFiles — INV-remediate-phases-07: exclusion patterns", () => {
  const GIT_DIR = scratchDir(".test-phases-inv-07-git");

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

  it("excludes all .audit-tools/ subtree paths (both audit and remediation)", async () => {
    mkdirSync(join(GIT_DIR, ".audit-tools", "audit"), { recursive: true });
    mkdirSync(join(GIT_DIR, ".audit-tools", "remediation"), { recursive: true });
    writeFileSync(join(GIT_DIR, ".audit-tools", "audit", "audit-findings.json"), "{}");
    writeFileSync(join(GIT_DIR, ".audit-tools", "remediation", "state.json"), "{}");
    writeFileSync(join(GIT_DIR, "src.ts"), "code");

    // V2 signature: staging is manifest-scoped; declaring the .audit-tools
    // paths in the manifest must STILL not stage them (hard exclude wins).
    const { files } = await collectStagingFiles(GIT_DIR, [
      "src.ts",
      ".audit-tools/audit/audit-findings.json",
      ".audit-tools/remediation/state.json",
    ]);
    expect(files).toContain("src.ts");
    expect(files.some((f) => f.includes(".audit-tools"))).toBe(false);
  });

  it("excludes .env and .env.* credential files", async () => {
    writeFileSync(join(GIT_DIR, ".env"), "SECRET=x");
    writeFileSync(join(GIT_DIR, ".env.local"), "LOCAL_SECRET=y");
    writeFileSync(join(GIT_DIR, ".env.production"), "PROD=z");
    writeFileSync(join(GIT_DIR, "src.ts"), "code");

    // Declared in the manifest on purpose — the .env* hard exclude must win.
    const { files } = await collectStagingFiles(GIT_DIR, [
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

  it("returns empty when nothing is modified", async () => {
    const { files, leftover } = await collectStagingFiles(GIT_DIR, ["src.ts"]);
    expect(files).toEqual([]);
    expect(leftover).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// INV-remediate-phases-08: groundExtractedFindings repair called exactly once
// ---------------------------------------------------------------------------

describe("groundExtractedFindings — INV-remediate-phases-08: repair hook called exactly once", () => {
  const TEST_DIR = scratchDir(".test-phases-inv-08");

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
      repairZeroPathFindings: async (_requests) => {
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
  const TEST_DIR = scratchDir(".test-phases-inv-09");
  const BASE_OPTIONS = { root: dirname(TEST_DIR), artifactsDir: TEST_DIR };

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
      plan: planForUnits([canonicalUnitFixture("F1")]),
      items: {
        F1: {
          unit_id: "F1",
          status: "blocked",
          failure_reason: "failed",
        },
      },
    });
    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ unit_id: "F1", action: "retry", rationale: "not worth fixing" }],
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
      plan: planForUnits([canonicalUnitFixture("F1")]),
      items: {
        F1: {
          unit_id: "F1",
          status: "blocked",
          failure_reason: "failed",
        },
      },
    });
    await writeFile(
      join(TEST_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [{ unit_id: "F1", action: "ignore", rationale: "please retry this" }],
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
  const REPO_DIR = scratchDir(".test-phases-inv-10-repo");
  const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools", "remediation");
  const OUTPUT_DIR = join(REPO_DIR, ".audit-tools");
  const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR };

  function makeClosingState(actionOverride: ClosingPlan["action"]) {
    return makeState({
      status: "closing",
      plan: canonicalPlanFixture({ plan_id: "P-INV10", candidate_closing_actions: ["none"] }),
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

  it("ClosingResult always carries contract_version for action=none", async () => {
    // Use executeClosingAction directly — runClosePhase deletes the artifacts dir
    // on a clean (fully-green) close, so the written file would be gone before
    // we can read it. The invariant being tested is that every code path in
    // executeClosingAction sets contract_version.
    const state = makeClosingState("none");
    const result = await executeClosingAction(state, BASE_OPTIONS);
    expect(result.contract_version).toBe("remediate-code-closing-result/v1alpha1");
    expect(result.action).toBe("none");
  });

  it("ClosingResult always carries contract_version for action=commit (no staged files)", async () => {
    // executeClosingAction directly: repo has no staged/untracked files, so the
    // vacuous-success path runs. All paths must set contract_version.
    const state = makeClosingState("commit");
    const result = await executeClosingAction(state, BASE_OPTIONS);
    expect(result.contract_version).toBe("remediate-code-closing-result/v1alpha1");
    expect(result.action).toBe("commit");
  });

  it("remediation-outcomes.json always carries contract_version", async () => {
    const { readFile } = await import("node:fs/promises");
    const state = makeClosingState("none");
    await writeApprovedPlanFixture(ARTIFACTS_DIR, state, REPO_DIR);
    await runClosePhase(state, BASE_OPTIONS);
    const outcomes = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    expect(outcomes.contract_version).toBe(REMEDIATION_OUTCOMES_CONTRACT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// TST-d1399aa3: groundAffectedFiles and evidenceCitesRealPath dedicated unit tests
// ---------------------------------------------------------------------------

describe("groundAffectedFiles — TST-d1399aa3: dedicated unit tests for phantom-path stripping", () => {
  const TEST_DIR = scratchDir(".test-grounding-d1399aa3");

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "real.ts"), "const x = 1;\n");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("strips phantom paths and preserves real paths in place", async () => {
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

    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    const result = groundAffectedFiles(TEST_DIR, findings as any, corpus);

    expect(findings[0].affected_files).toHaveLength(1);
    expect(findings[0].affected_files[0].path).toBe("src/real.ts");
    expect(result.phantomPathsByFinding.get("F1")).toContain("phantom/does-not-exist.ts");
    expect(result.zeroRealPathFindingIds).not.toContain("F1");
  });

  it("records finding as zero-real-path when all paths are phantom", async () => {
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

    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    const result = groundAffectedFiles(TEST_DIR, findings as any, corpus);

    expect(findings[0].affected_files).toHaveLength(0);
    expect(result.zeroRealPathFindingIds).toContain("F2");
  });

  it("leaves findings with no affected_files untouched (empty-files is legitimate)", async () => {
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

    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    const result = groundAffectedFiles(TEST_DIR, findings as any, corpus);

    expect(result.phantomPathsByFinding.has("F3")).toBe(false);
    expect(result.zeroRealPathFindingIds).not.toContain("F3");
    expect(findings[0].affected_files).toHaveLength(0);
  });
});

describe("evidenceCitesRealPath — TST-d1399aa3: dedicated unit tests for evidence citation check", () => {
  const TEST_DIR = scratchDir(".test-evidence-d1399aa3");

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "auth.ts"), "line1\nline2\nline3\n");
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns true for evidence citing a real path without line number", async () => {
    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    expect(evidenceCitesRealPath(TEST_DIR, "See src/auth.ts for details", corpus)).toBe(true);
  });

  it("returns true for evidence citing a real path with an in-range line number", async () => {
    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    expect(evidenceCitesRealPath(TEST_DIR, "src/auth.ts:2 — some issue", corpus)).toBe(true);
  });

  it("returns false for evidence citing a real path with an out-of-range line number", async () => {
    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    expect(evidenceCitesRealPath(TEST_DIR, "src/auth.ts:9999 — out of range", corpus)).toBe(false);
  });

  it("returns false when the cited path does not exist in the repo", async () => {
    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    expect(evidenceCitesRealPath(TEST_DIR, "src/nonexistent.ts:1 — missing file", corpus)).toBe(false);
  });

  it("returns false for pure prose with no path-like tokens", async () => {
    const corpus = await enumerateTrackedFilePaths(TEST_DIR);
    expect(evidenceCitesRealPath(TEST_DIR, "This finding has no path reference", corpus)).toBe(false);
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
      units: [],
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
      units: [],
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
      units: [],
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
      units: [],
    });
    const ids = ledger.entries.map((e) => e.finding_id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ledger.source_finding_count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TST-cb981ad0: close.ts FINAL_STATUS_BY_OUTCOME via buildRemediationOutcomesReport
// ---------------------------------------------------------------------------

describe("buildRemediationOutcomesReport — TST-cb981ad0: final_status mappings", () => {
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

  it("FINAL_STATUS_BY_OUTCOME: resolved→fixed, blocked→failed, ignored→ignored, inappropriate→skipped", () => {
    const findings = ["F-resolved", "F-blocked", "F-ignored", "F-inappropriate"].map(mkPlanFinding);
    const state = makeState({
      status: "closing",
      plan: canonicalPlanFixture({ ...planForUnits(findings.map(finding => canonicalUnitFixture(finding.id, { source_finding_ids: [finding.id] }))), plan_id: "P-FSO", findings }),
      finding_dispositions: {
        "F-ignored": { status: "ignored", reason: "user chose to ignore" },
        "F-inappropriate": { status: "declined", reason: "not applicable" },
      },
      items: {
        "F-resolved":      { unit_id: "F-resolved",      status: "resolved" },
        "F-blocked":       { unit_id: "F-blocked",        status: "blocked", failure_reason: "failed" },
        "F-ignored":       { unit_id: "F-ignored",        status: "ignored", failure_reason: "user chose to ignore" },
        "F-inappropriate": { unit_id: "F-inappropriate",  status: "deemed_inappropriate", failure_reason: "not applicable" },
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
      plan: canonicalPlanFixture({ ...planForUnits([canonicalUnitFixture("F-vnc", { source_finding_ids: ["F-vnc"] })]), plan_id: "P-VNC", findings: [mkPlanFinding("F-vnc")] }),
      items: {
        "F-vnc": { unit_id: "F-vnc", status: "resolved_no_change" },
      },
    });

    const report = buildRemediationOutcomesReport(state as any, VACUOUS_CLOSING_RESULT);
    const outcome = report.outcomes.find((o) => o.finding_id === "F-vnc") as any;
    expect(outcome.outcome).toBe("verified_no_change");
    expect(outcome.final_status).toBe("fixed");
  });
});
