/**
 * Implement-dispatch defect cluster (2026-07-22 dogfood wall) — regression tests.
 *
 *  - FIX-D-SEAM: decideNextStep folds + persists explicitly-supplied host
 *    capabilities at the loop-entry seam, on EVERY invocation — not only when the
 *    call lands on the implement-dispatch branch. (The dogfood re-drive passed the
 *    full handshake while the state sat in triage; the flags were dropped and
 *    dispatch stayed at the 32k floor.)
 *  - FIX-D-MARSHAL: prepareImplementDispatch falls back per-field to the
 *    persisted state.host_capabilities when waveOptions omits a field (the bare
 *    `prepare-implement-dispatch` CLI channel).
 *  - FIX-A-MERGE: a plan item with no result file whose block was never
 *    dispatched AND has an admission refusal on record carries the refusal
 *    (reason + packet cost) in its failure_reason, instead of misattributing an
 *    engine plan-vs-drive inconsistency.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding, RemediationBlock } from "../../src/remediate/state/types.js";
import {
  prepareImplementDispatch,
  mergeImplementResults,
} from "../../src/remediate/steps/dispatch.js";
import {
  decideNextStep,
  detectStructuralRefusalPause,
} from "../../src/remediate/steps/nextStep.js";
import { REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import {
  estimateImplementSlotTokens,
  PROMPT_OVERHEAD_TOKENS,
} from "../../src/remediate/steps/dispatch/common.js";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-implement-cluster");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

function makeNodeFinding(): Finding {
  return {
    id: "N-x",
    title: "Node X",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: "Do X.",
    affected_files: [{ path: "src/x.ts" }],
    evidence: ["e"],
  } as Finding;
}

function makeNodeState(): RemediationState {
  const finding = makeNodeFinding();
  const block: RemediationBlock = {
    block_id: "CP-BLOCK-N-x",
    items: [finding.id],
    parallel_safe: true,
  };
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-1",
      findings: [finding],
      blocks: [block],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      [finding.id]: {
        finding_id: finding.id,
        status: "pending",
        block_id: block.block_id,
      },
    },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  await writeFile(join(REPO_DIR, "package.json"), JSON.stringify({ name: "cluster-test" }));
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("FIX-D-SEAM — decideNextStep seam host-capabilities persistence", () => {
  it("handshake flags persist at the seam even when the call lands on a non-implement obligation", async () => {
    // Park the run in a NON-implement status so the implement-dispatch branch
    // (the only pre-fix persist site) never runs this invocation.
    const state: RemediationState = {
      status: "planning",
      plan: {
        plan_id: "PLAN-1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      },
      items: {},
      closing_plan: { action: "none" },
    } as unknown as RemediationState;
    await saveState(state);

    // The emitted step (or any downstream planning failure) is irrelevant here —
    // the invariant under test is that the handshake persisted at the seam.
    await decideNextStep({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      hostContextTokens: 200_000,
      hostMaxConcurrent: 4,
      hostOutputTokens: 16_000,
    }).catch(() => undefined);

    const reloaded = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(reloaded?.host_capabilities?.context_tokens).toBe(200_000);
    expect(reloaded?.host_capabilities?.max_concurrent).toBe(4);
    expect(reloaded?.host_capabilities?.output_tokens).toBe(16_000);
  });
});

describe("FIX-D-MARSHAL — prepareImplementDispatch host_capabilities fallback", () => {
  it("sizes the wave to persisted host_capabilities when waveOptions is omitted (bare CLI channel)", async () => {
    const state = makeNodeState();
    state.host_capabilities = {
      context_tokens: 200_000,
      output_tokens: 64_000,
      max_concurrent: 4,
    };
    await saveState(state);

    await prepareImplementDispatch({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, "PLAN-1");

    const quotaPath = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement", "dispatch-quota.json");
    expect(existsSync(quotaPath)).toBe(true);
    const quota = JSON.parse(await readFile(quotaPath, "utf8")) as {
      resolved_limits?: { context_tokens?: number };
    };
    // The persisted 200k window, not the 32k conservative floor.
    expect(quota.resolved_limits?.context_tokens).toBeGreaterThan(32_000);
  });
});

describe("FIX-B-PAUSE — empty rolling frontier discriminates structural refusal from done", () => {
  it("pauses when zero packets were granted and every refusal is no_capable_pool", () => {
    const { pause, refusedIds } = detectStructuralRefusalPause({
      admission: {
        granted_packet_ids: [],
        explains: [
          { packet_id: "CP-BLOCK-1", admitted: false, reason: "no_capable_pool" },
          { packet_id: "CP-BLOCK-2", admitted: false, reason: "no_capable_pool" },
        ],
      },
    });
    expect(pause).toBe(true);
    expect(refusedIds).toEqual(["CP-BLOCK-1", "CP-BLOCK-2"]);
  });

  it("does NOT pause when the frontier is empty because everything is done (no refusals)", () => {
    expect(
      detectStructuralRefusalPause({
        admission: { granted_packet_ids: [], explains: [] },
      }).pause,
    ).toBe(false);
    expect(detectStructuralRefusalPause(undefined).pause).toBe(false);
  });

  it("does NOT pause on a budget/transient zero-grant (that is the quota wall's case)", () => {
    expect(
      detectStructuralRefusalPause({
        admission: {
          granted_packet_ids: [],
          explains: [
            { packet_id: "CP-BLOCK-1", admitted: false, reason: "budget_exhausted" },
            { packet_id: "CP-BLOCK-2", admitted: false, reason: "no_capable_pool" },
          ],
        },
      }).pause,
    ).toBe(false);
  });

  it("does NOT pause when anything was granted (partial refusals merge normally)", () => {
    expect(
      detectStructuralRefusalPause({
        admission: {
          granted_packet_ids: ["CP-BLOCK-2"],
          explains: [
            { packet_id: "CP-BLOCK-1", admitted: false, reason: "no_capable_pool" },
            { packet_id: "CP-BLOCK-2", admitted: true },
          ],
        },
      }).pause,
    ).toBe(false);
  });
});

describe("FIX-A-MERGE — never-dispatched disposition carries the admission refusal", () => {
  async function mergeWithMissingResult(
    admissionExplains?: Array<{
      packet_id: string;
      admitted: boolean;
      reason: string;
      cost?: number;
    }>,
  ): Promise<RemediationState> {
    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });
    const resultPath = join(resultDir, "implement-CP-BLOCK-N-x.result.json");

    await writeFile(
      join(resultDir, "dispatch-plan.json"),
      JSON.stringify({
        contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
        phase: "implement",
        run_id: runId,
        repo_root: REPO_DIR,
        artifacts_dir: ARTIFACTS_DIR,
        items: [
          {
            task_id: "implement-CP-BLOCK-N-x",
            block_id: "CP-BLOCK-N-x",
            prompt_path: join(resultDir, "implement-CP-BLOCK-N-x.md"),
            result_path: resultPath,
            access: { read_paths: ["src/x.ts"], write_paths: ["src/x.ts", resultPath] },
          },
        ],
      }),
    );
    await writeFile(
      join(resultDir, "dispatch-quota.json"),
      JSON.stringify({
        resolved_limits: { context_tokens: 32_000 },
        ...(admissionExplains ? { admission: { explains: admissionExplains } } : {}),
      }),
    );
    // Deliberately no result file and no <block>.task.json (never dispatched).
    return mergeImplementResults({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, runId);
  }

  it("failure_reason names the admission refusal (reason + packet cost) when one is on record", async () => {
    await saveState(makeNodeState());
    const merged = await mergeWithMissingResult([
      { packet_id: "CP-BLOCK-N-x", admitted: false, reason: "no_capable_pool", cost: 150_000 },
    ]);

    const item = merged.items!["N-x"]!;
    expect(item.status).toBe("blocked");
    expect(item.failure_reason).toMatch(/admission refused the packet \(no_capable_pool/);
    expect(item.failure_reason).toContain("150000");
    expect(item.failure_reason).not.toMatch(/plan-vs-drive eligibility inconsistency/);
  });

  it("keeps the generic never-dispatched (plan-vs-drive) text when no refusal is on record", async () => {
    await saveState(makeNodeState());
    const merged = await mergeWithMissingResult();

    const item = merged.items!["N-x"]!;
    expect(item.status).toBe("blocked");
    expect(item.failure_reason).toMatch(/no worker was ever dispatched/);
    expect(item.failure_reason).toMatch(/plan-vs-drive eligibility inconsistency/);
    expect(item.failure_reason).not.toMatch(/admission refused/);
  });

  it("a TRANSIENT refusal (cap_reached) leaves the item PENDING with a bounded attempt counter", async () => {
    await saveState(makeNodeState());
    const merged = await mergeWithMissingResult([
      { packet_id: "CP-BLOCK-N-x", admitted: false, reason: "cap_reached" },
    ]);

    const item = merged.items!["N-x"]!;
    expect(item.status).toBe("pending");
    expect(item.undispatched_attempts).toBe(1);
    expect(item.failure_reason).toBeUndefined();
  });

  it("the transient retry budget is bounded: the item blocks with a named reason once exhausted", async () => {
    const state = makeNodeState();
    // Already refused 3 waves running; this merge is the 4th.
    state.items!["N-x"]!.undispatched_attempts = 3;
    await saveState(state);
    const merged = await mergeWithMissingResult([
      { packet_id: "CP-BLOCK-N-x", admitted: false, reason: "budget_exhausted" },
    ]);

    const item = merged.items!["N-x"]!;
    expect(item.status).toBe("blocked");
    expect(item.undispatched_attempts).toBe(4);
    expect(item.failure_reason).toMatch(/Transient non-dispatch retry budget exhausted/);
    expect(item.failure_reason).toContain("budget_exhausted");
  });
});

describe("FIX-C-SPLIT — oversized single-finding block splits by file partition (INV-RSM-SPLIT-01)", () => {
  async function writeSizedFiles(names: string[], bytes: number): Promise<void> {
    for (const name of names) {
      await mkdir(dirname(join(REPO_DIR, name)), { recursive: true });
      await writeFile(join(REPO_DIR, name), "x".repeat(bytes));
    }
  }

  function makeOversizedBlock(): { finding: Finding; block: RemediationBlock } {
    const finding = {
      ...makeNodeFinding(),
      id: "CP-NODE-7",
      affected_files: [{ path: "src/a.ts" }, { path: "src/b.ts" }, { path: "src/c.ts" }],
    } as Finding;
    const block: RemediationBlock = {
      block_id: "CP-BLOCK-CP-NODE-7",
      items: [finding.id],
      parallel_safe: true,
      touched_files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      targeted_commands: ["npx vitest run src/a.ts", "npm run check"],
      phase_ordinal: 2,
    };
    return { finding, block };
  }

  it("partitions the finding's files into budgeted sub-findings/sub-blocks, carrying metadata per field semantics", async () => {
    const { splitOversizedSingleFindingBlocks } = await import(
      "../../src/remediate/phases/plan.js"
    );
    // 3 files × 40k bytes ≈ 10k tokens each; budget 13k fits exactly one per group.
    await writeSizedFiles(["src/a.ts", "src/b.ts", "src/c.ts"], 40_000);
    const { finding, block } = makeOversizedBlock();
    const downstream: RemediationBlock = {
      block_id: "CP-BLOCK-DOWNSTREAM",
      items: ["D-1"],
      parallel_safe: false,
      touched_files: ["src/d.ts"],
      dependencies: ["CP-BLOCK-CP-NODE-7"],
    };

    const result = splitOversizedSingleFindingBlocks(
      [block, downstream],
      [finding, { ...makeNodeFinding(), id: "D-1" } as Finding],
      REPO_DIR,
      13_000,
    );

    const subBlocks = result.blocks.filter((b) =>
      b.block_id.startsWith("CP-BLOCK-CP-NODE-7-f"),
    );
    expect(subBlocks).toHaveLength(3);
    // The parent block and finding are replaced, not retained.
    expect(result.blocks.some((b) => b.block_id === "CP-BLOCK-CP-NODE-7")).toBe(false);
    expect(result.findings.some((f) => f.id === "CP-NODE-7")).toBe(false);
    // Sub-findings partition the parent's files: disjoint, union-complete.
    const subFindings = result.findings.filter((f) => f.id.startsWith("CP-NODE-7-f"));
    const allPaths = subFindings.flatMap((f) => f.affected_files.map((af) => af.path));
    expect([...allPaths].sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(new Set(allPaths).size).toBe(allPaths.length);
    // phase_ordinal is a barrier: carried UNCHANGED onto every sub-block.
    for (const sb of subBlocks) expect(sb.phase_ordinal).toBe(2);
    // Command relevance: the file-specific command rides only with src/a.ts's
    // sub-block; the generic command rides with every sub-block (no silent drop).
    const aSub = subBlocks.find((b) => b.touched_files.includes("src/a.ts"))!;
    expect(aSub.targeted_commands).toContain("npx vitest run src/a.ts");
    for (const sb of subBlocks) expect(sb.targeted_commands).toContain("npm run check");
    for (const sb of subBlocks.filter((b) => b !== aSub)) {
      expect(sb.targeted_commands).not.toContain("npx vitest run src/a.ts");
    }
    // Downstream dependency remapped to ALL sub-blocks.
    const remappedDownstream = result.blocks.find(
      (b) => b.block_id === "CP-BLOCK-DOWNSTREAM",
    )!;
    expect([...(remappedDownstream.dependencies ?? [])].sort()).toEqual(
      subBlocks.map((b) => b.block_id).sort(),
    );
  });

  it("leaves a fitting single-finding block untouched", async () => {
    const { splitOversizedSingleFindingBlocks } = await import(
      "../../src/remediate/phases/plan.js"
    );
    await writeSizedFiles(["src/a.ts", "src/b.ts", "src/c.ts"], 1_000);
    const { finding, block } = makeOversizedBlock();
    const result = splitOversizedSingleFindingBlocks([block], [finding], REPO_DIR, 13_000);
    expect(result.blocks).toEqual([block]);
    expect(result.findings).toEqual([finding]);
  });

  it("a single file larger than the whole budget still yields its own sub-block (partition floor)", async () => {
    const { splitOversizedSingleFindingBlocks } = await import(
      "../../src/remediate/phases/plan.js"
    );
    await writeSizedFiles(["src/a.ts", "src/b.ts"], 1_000);
    await writeSizedFiles(["src/huge.ts"], 200_000);
    const finding = {
      ...makeNodeFinding(),
      id: "CP-NODE-8",
      affected_files: [{ path: "src/a.ts" }, { path: "src/huge.ts" }, { path: "src/b.ts" }],
    } as Finding;
    const block: RemediationBlock = {
      block_id: "CP-BLOCK-CP-NODE-8",
      items: [finding.id],
      parallel_safe: true,
      touched_files: ["src/a.ts", "src/huge.ts", "src/b.ts"],
    };
    const result = splitOversizedSingleFindingBlocks([block], [finding], REPO_DIR, 13_000);
    const subBlocks = result.blocks.filter((b) =>
      b.block_id.startsWith("CP-BLOCK-CP-NODE-8-f"),
    );
    expect(subBlocks.length).toBeGreaterThanOrEqual(2);
    const hugeSub = subBlocks.find((b) => b.touched_files.includes("src/huge.ts"))!;
    expect(hugeSub.touched_files).toEqual(["src/huge.ts"]);
  });
});

describe("Worktree un-landed-work guard — a re-prepare never destroys worker output", () => {
  it("discriminates: nonexistent → false; clean-at-base → false; uncommitted edits → true", async () => {
    const { worktreeHoldsUnlandedWork } = await import(
      "../../src/remediate/steps/rollingSession.js"
    );
    const { execSync } = await import("node:child_process");
    const gitRepo = join(TEST_DIR, "wt-guard-repo");
    await mkdir(gitRepo, { recursive: true });
    execSync("git init -q -b main", { cwd: gitRepo });
    execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base', {
      cwd: gitRepo,
    });

    expect(worktreeHoldsUnlandedWork(join(TEST_DIR, "no-such-worktree"), gitRepo)).toBe(false);
    // Clean tree at the base: nothing un-landed (base = the repo's own HEAD).
    expect(worktreeHoldsUnlandedWork(gitRepo, gitRepo)).toBe(false);
    // Uncommitted edit: un-landed work — a reset here would destroy it.
    await writeFile(join(gitRepo, "wip.ts"), "edited");
    expect(worktreeHoldsUnlandedWork(gitRepo, gitRepo)).toBe(true);
    // Committed-but-not-landed: a linked node worktree whose branch is ahead of
    // the primary tree's HEAD (the real shape — shared object store).
    await rm(join(gitRepo, "wip.ts"), { force: true });
    const linked = join(TEST_DIR, "wt-guard-linked");
    execSync(`git worktree add -q -b node-branch "${linked}"`, { cwd: gitRepo });
    execSync(
      'git -c user.email=t@t -c user.name=t commit -q --allow-empty -m worker-output',
      { cwd: linked },
    );
    expect(worktreeHoldsUnlandedWork(linked, gitRepo)).toBe(true);
    execSync(`git worktree remove --force "${linked}"`, { cwd: gitRepo });
  });
});

describe("Agentic slot-cost model — access set is a manifest, not inlined content", () => {
  it("many referencing files inflate the estimate by listing overhead only, never by their byte-sum", async () => {
    // One large source file + many referencing tests. Under the content-inlining
    // byte-sum model this exploded (the dogfood's CP-NODE-1: 182 tests → 943k
    // tokens for a 14.5KB prompt); the agentic model bounds it by the LARGEST
    // single file + per-file listing overhead.
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await mkdir(join(REPO_DIR, "tests"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "big.ts"), "x".repeat(200_000));
    const files = ["src/big.ts"];
    for (let i = 0; i < 60; i++) {
      const name = `tests/ref-${i}.test.ts`;
      await writeFile(join(REPO_DIR, name), "y".repeat(40_000));
      files.push(name);
    }
    const estimate = estimateImplementSlotTokens(files, REPO_DIR);
    // Byte-sum would be ≈ (200k + 60×40k)/4 = 650k tokens. The agentic model:
    // overhead + largest file (~50k) + 61 listing lines — well under 100k.
    expect(estimate).toBeLessThan(100_000);
    expect(estimate).toBeGreaterThan(PROMPT_OVERHEAD_TOKENS + 50_000 - 1);
  });

  it("the rendered prompt's own bytes ride in the estimate", async () => {
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(join(REPO_DIR, "src", "a.ts"), "x".repeat(4_000));
    const promptPath = join(REPO_DIR, "prompt.md");
    await writeFile(promptPath, "p".repeat(40_000));
    const without = estimateImplementSlotTokens(["src/a.ts"], REPO_DIR);
    const withPrompt = estimateImplementSlotTokens(["src/a.ts"], REPO_DIR, { promptPath });
    expect(withPrompt - without).toBe(10_000); // 40k bytes ≈ 10k tokens
  });
});

describe("Empty-scope dispatch-boundary guard (anti-cascade spec)", () => {
  it("refuses an empty-scope block at the boundary: never enqueued, items blocked with a named reason", async () => {
    const state = makeNodeState();
    // No declared surface anywhere: block touched_files empty, finding cites no files.
    state.plan!.findings[0]!.affected_files = [];
    state.plan!.blocks[0]!.touched_files = [];
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-1",
    );

    expect(plan.items).toHaveLength(0);
    const reloaded = await new StateStore(ARTIFACTS_DIR).loadState();
    const item = reloaded!.items!["N-x"]!;
    expect(item.status).toBe("blocked");
    expect(item.failure_reason).toMatch(/Empty dispatch scope/);
    expect(item.failure_reason).toMatch(/dispatch boundary/);
  });

  it("a block with a declared surface but file-less findings still dispatches (not empty scope)", async () => {
    const state = makeNodeState();
    state.plan!.findings[0]!.affected_files = [];
    state.plan!.blocks[0]!.touched_files = ["src/x.ts"];
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-1",
    );

    expect(plan.items).toHaveLength(1);
    const reloaded = await new StateStore(ARTIFACTS_DIR).loadState();
    expect(reloaded!.items!["N-x"]!.status).toBe("pending");
  });
});
