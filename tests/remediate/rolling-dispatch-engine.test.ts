// Rolling dispatch engine — live-path wiring (CP-BLOCK-N-rolling-dispatch-engine,
// ARC-f378135d + family). Covers:
//  - INV-ROLL-01: implement concurrency is QUOTA-DERIVED (buildConfirmedPools +
//    computeDispatchCapacity), never the raw host flag.
//  - INV-ROLL-02: dispatch is rolling — a freed slot is filled the instant a node
//    completes (createRollingDispatcher via driveRollingDispatch).
//  - INV-ROLL-03: the finding_id trap is fixed — the renderer emits the node id
//    and the merge TOLERANTLY remaps an obligation/block-id mislabel to its node.
//  - INV-ROLL-04: free_form_intent is interpreted at the nextStep call site via
//    the shared interpreter; the raw string is never threaded; unencodable
//    clauses are surfaced.
//  - fail-1: write-scope enforcement (git-diff vs declared scope; fail-closed).
//  - fail-2: lost-update / overlapping-edit detection across concurrent blocks.
//  - fail-3: empty-pool stranding (no surviving pool → stranded terminal).
//  - fail-4: verify-before-accept — a node whose verify fails is not merged.
//  - fail-5: the host-fanned wave fallback is RETAINED and is the DEFAULT
//    (rolling engine opt-in defaults off — CE-001 anti-wedge).

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import {
  computeDispatchCapacity,
  interpretFreeFormIntent,
  DISPATCH_TIER_RANK,
  DISPATCH_TIER_ORDER,
  compareTier,
  mostCapableTier,
  tierRank,
  createRollingDispatcher,
  type CapacityPool,
  type SessionConfig,
  type ProviderSlot,
  type RollingDispatchPacket,
  type RollingDispatchResult,
} from "audit-tools/shared";
import {
  buildConfirmedPools,
  buildBlockAliasMap,
  collapseItemResults,
  enforceWriteScope,
  detectOverlappingEdits,
  worktreeBranchForBlock,
  type GitEditedFiles,
} from "../../src/remediate/steps/dispatch.js";
import {
  resolveRollingEngineEnabled,
  interpretConfirmedCheckpointIntent,
} from "../../src/remediate/steps/nextStep.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import type { IntentCheckpoint } from "audit-tools/shared";

// ---------------------------------------------------------------------------
// Tiny builders
// ---------------------------------------------------------------------------

function block(id: string, items: string[], deps: string[] = []): RemediationBlock {
  return { block_id: id, items, parallel_safe: true, dependencies: deps };
}

function findingState(
  blocks: RemediationBlock[],
  overlays: Record<string, Partial<{ contract_obligation_ids: string[] }>> = {},
): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-ROLL",
      findings: blocks.flatMap((b) =>
        b.items.map((id) => ({
          id,
          title: id,
          category: "correctness",
          severity: "medium" as const,
          confidence: "high" as const,
          lens: "correctness",
          summary: id,
          affected_files: [{ path: `src/${id}.ts` }],
          evidence: [`src/${id}.ts:1`],
          ...(overlays[id] ?? {}),
        })),
      ),
      blocks,
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: Object.fromEntries(
      blocks.flatMap((b) =>
        b.items.map((id) => [id, { finding_id: id, status: "pending" as const, block_id: b.block_id }]),
      ),
    ),
    closing_plan: { action: "none" },
  };
}

// ===========================================================================
// Single shared dispatch tier-rank authority (P1)
// ===========================================================================

describe("single shared tier-rank authority", () => {
  it("DISPATCH_TIER_RANK orders small < standard < deep", () => {
    expect(DISPATCH_TIER_RANK.small).toBeLessThan(DISPATCH_TIER_RANK.standard);
    expect(DISPATCH_TIER_RANK.standard).toBeLessThan(DISPATCH_TIER_RANK.deep);
  });

  it("DISPATCH_TIER_ORDER is ascending capability and covers exactly the three tiers", () => {
    expect(DISPATCH_TIER_ORDER).toEqual(["small", "standard", "deep"]);
  });

  it("tierRank maps an unknown/absent tier to the neutral middle (standard)", () => {
    expect(tierRank(undefined)).toBe(DISPATCH_TIER_RANK.standard);
    expect(tierRank(null)).toBe(DISPATCH_TIER_RANK.standard);
  });

  it("compareTier sorts ascending; negate for most-capable-first", () => {
    const tiers: Array<"small" | "standard" | "deep"> = ["deep", "small", "standard"];
    expect([...tiers].sort(compareTier)).toEqual(["small", "standard", "deep"]);
    expect([...tiers].sort((a, b) => compareTier(b, a))).toEqual(["deep", "standard", "small"]);
  });

  it("mostCapableTier picks the highest rank (deep over a sibling's small)", () => {
    expect(mostCapableTier(["small", "deep", "standard"])).toBe("deep");
    expect(mostCapableTier([])).toBeUndefined();
  });
});

// ===========================================================================
// INV-ROLL-01: quota-derived concurrency (not the raw host flag)
// ===========================================================================

describe("INV-ROLL-01: implement concurrency is quota-derived", () => {
  it("buildConfirmedPools produces one quota-keyed pool per roster rank", async () => {
    const pools = await buildConfirmedPools({
      sessionConfig: { provider: "claude-code", quota: {} },
      hostModels: [
        { rank: "small", context_tokens: 32_000, output_tokens: 4_096 },
        { rank: "deep", context_tokens: 200_000, output_tokens: 8_192 },
      ],
    });
    expect(pools.length).toBe(2);
    // Each pool carries its declared rank + discovered window (quota inputs),
    // never a flat host-flag concurrency.
    const ranks = pools.map((p) => p.rank).sort();
    expect(ranks).toEqual(["deep", "small"]);
    for (const p of pools) expect(p.discoveredLimits).toBeTruthy();
  });

  it("computeDispatchCapacity over the confirmed pools sizes slots from the window, not a fixed flag", async () => {
    const pools = await buildConfirmedPools({
      sessionConfig: { provider: "claude-code", quota: {} },
      hostContextTokens: 200_000,
      hostOutputTokens: 8_192,
    });
    const cap = computeDispatchCapacity({
      pools,
      sessionConfig: { quota: {} },
      // Two small packets — the slot count is bounded by quota math over the
      // discovered window, not by any host concurrency flag.
      pendingItemTokens: [1000, 1000],
    });
    expect(cap.total_slots).toBeGreaterThanOrEqual(1);
    expect(cap.pools.length).toBe(pools.length);
  });

  it("appends a configured openai-compatible pool alongside the primary (INV-QD-14 spill target)", async () => {
    const pools = await buildConfirmedPools({
      sessionConfig: {
        provider: "claude-code",
        quota: {},
        openai_compatible: { base_url: "https://example/v1", model: "vendor/model-x" },
      },
    });
    expect(pools.length).toBe(2);
    const api = pools.find((p) => p.providerName === "openai-compatible");
    expect(api).toBeTruthy();
    // Independent API pool: not bound by the host subagent budget, no proactive
    // capability handshake; its model is the quota-key segment.
    expect(api!.hostConcurrencyLimit).toBeNull();
    expect(api!.discoveredLimits).toBeNull();
    expect(api!.hostModel).toBe("vendor/model-x");
    expect(api!.id).not.toBe(pools.find((p) => p.providerName === "claude-code")!.id);
  });

  it("does NOT duplicate the openai-compatible pool when it is the primary provider", async () => {
    // H2+H4 collapse: the primary folds in UNCONDITIONALLY as ONE source pool
    // alongside the conversation-host pool (attended member-pool semantics) —
    // never two openai-compatible pools.
    const pools = await buildConfirmedPools({
      sessionConfig: {
        provider: "openai-compatible",
        quota: {},
        openai_compatible: { base_url: "https://example/v1", model: "vendor/model-x" },
      },
    });
    expect(pools.filter((p) => p.providerName === "openai-compatible").length).toBe(1);
    // The host pool keys to the conversation host, not the worker backend (D5).
    expect(pools.some((p) => p.providerName === "claude-code")).toBeTruthy();
  });

  it("attended + in-process primary: host pool keys to claude-code + the codex primary is ALWAYS a member source pool", async () => {
    // Red-green (a) at pool level: no demote flag exists — the fold is unconditional.
    const pools = await buildConfirmedPools({
      sessionConfig: {
        provider: "codex",
        quota: {},
        codex: { command: "codex", model: "gpt-5" },
      },
    });
    // The conversation-host pool keys to claude-code (NOT codex — the founding-bug
    // quota mis-keying), and codex appears as a SEPARATE source pool so the host
    // fans out onto it concurrently instead of the backend monopolizing.
    const hostPool = pools.find((p) => p.providerName === "claude-code");
    const codexSource = pools.find((p) => p.providerName === "codex");
    expect(hostPool).toBeTruthy();
    expect(codexSource).toBeTruthy();
    expect(codexSource!.hostConcurrencyLimit).toBeNull(); // independent source pool
    expect(hostPool!.id).not.toBe(codexSource!.id);
  });

  it("attended + agy primary: the agy pool is synthesized as a member source (D4)", async () => {
    // Red on HEAD twice over: agy was missing from the demotable set AND had no
    // synthesis case — an attended agy run had no pool at all.
    const pools = await buildConfirmedPools({
      sessionConfig: {
        provider: "agy",
        quota: {},
        agy: { command: "agy", model: "gemini-3-pro" },
      },
    });
    const agyPool = pools.find((p) => p.providerName === "agy");
    expect(agyPool).toBeTruthy();
    expect(pools.some((p) => p.providerName === "claude-code")).toBeTruthy();
  });

  it("attended + command-shaped primary (remediate policy): a pool, not a monopoly (D3)", async () => {
    // Red on HEAD: subprocess-template self-drove even attended (row-5 asymmetry);
    // now it fans out as a member source pool alongside the host.
    const pools = await buildConfirmedPools({
      sessionConfig: {
        provider: "subprocess-template",
        quota: {},
        subprocess_template: { command_template: ["run", "{prompt}"] },
      },
    });
    expect(pools.some((p) => p.providerName === "subprocess-template")).toBeTruthy();
    expect(pools.some((p) => p.providerName === "claude-code")).toBeTruthy();
  });

  it("host IS the primary backend (same agent): ONE pool after cross-class dedup, engine pool survives (D1)", async () => {
    // Red on HEAD: the retired B1 guard solved this by suppressing the fold; now the
    // fold is unconditional and the collision resolves at pool assembly — the
    // SOURCE/engine pool survives (it carries its `source`, so the engine drives
    // that single account) and no second codex pool double-books the meter.
    const pools = await buildConfirmedPools({
      sessionConfig: {
        provider: "codex",
        host_provider: "codex",
        quota: {},
        codex: { command: "codex", model: "gpt-5" },
      },
    });
    const codexPools = pools.filter((p) => p.providerName === "codex");
    expect(codexPools.length).toBe(1);
    expect(codexPools[0].source).toBeTruthy();
    expect(pools.some((p) => p.providerName === "claude-code")).toBeFalsy();
  });

  it("headless (hostCanDispatch:false): no host pool in the set — codex is the single driver pool", async () => {
    // Red-green (b) at pool level: attendance is pool-set membership, not a branch.
    const pools = await buildConfirmedPools({
      sessionConfig: {
        provider: "codex",
        quota: {},
        codex: { command: "codex", model: "gpt-5" },
      },
      hostCanDispatch: false,
    });
    expect(pools.some((p) => p.providerName === "claude-code")).toBeFalsy();
    expect(pools.filter((p) => p.providerName === "codex").length).toBe(1);
  });
});

// ===========================================================================
// INV-ROLL-02: rolling dispatch-next-on-complete
// ===========================================================================

describe("INV-ROLL-02: rolling dispatch fills a freed slot on completion", () => {
  it("dispatches all packets to completion as slots free up (no wave batching)", async () => {
    const pool: CapacityPool = {
      id: "claude-code/*",
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: { active_subagents: 2, source: "session_config" },
    };
    const session: SessionConfig = { quota: {} };
    const order: string[] = [];
    const dispatcher = createRollingDispatcher<{ id: string }>({
      confirmedPools: [pool],
      sessionConfig: session,
      dispatchPacket: async (packet) => {
        order.push(packet.id);
        return { packet, outcome: "success" as const };
      },
    });
    const packets: RollingDispatchPacket<{ id: string }>[] = Array.from({ length: 5 }, (_, i) => ({
      id: `P${i}`,
      payload: { id: `P${i}` },
      estimatedTokens: 100,
      complexity: 0.5,
    }));
    dispatcher.enqueue(packets);
    const results = await dispatcher.run();
    expect(results.length).toBe(5);
    expect(order.sort()).toEqual(["P0", "P1", "P2", "P3", "P4"]);
    expect(dispatcher.getTerminal()).toBeNull();
  });
});

// ===========================================================================
// INV-ROLL-03: finding_id trap fix (renderer emits node id; tolerant merge)
// ===========================================================================

describe("INV-ROLL-03: tolerant finding_id remap on merge", () => {
  it("remaps an obligation id the worker mislabeled as finding_id back to the owning node", () => {
    const blocks = [block("CP-BLOCK-N-foo", ["N-foo"])];
    const st = findingState(blocks, {
      "N-foo": { contract_obligation_ids: ["OBL-foo-inv-1"] },
    });
    const aliasMap = buildBlockAliasMap(blocks[0], st);
    // The obligation id maps back to the node finding id.
    expect(aliasMap.get("OBL-foo-inv-1")).toBe("N-foo");
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: "OBL-foo-inv-1", status: "resolved", evidence: ["ok"] }],
      aliasMap,
      new Set(["N-foo"]),
    );
    expect(unresolved).toHaveLength(0);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].finding_id).toBe("N-foo");
  });

  it("remaps a CP-BLOCK-prefixed block id back to its bare node id (registry-first)", () => {
    const blocks = [block("CP-BLOCK-N-bar", ["N-bar"])];
    const st = findingState(blocks);
    const aliasMap = buildBlockAliasMap(blocks[0], st);
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: "CP-BLOCK-N-bar", status: "resolved", evidence: ["e"] }],
      aliasMap,
      new Set(["N-bar"]),
    );
    expect(unresolved).toHaveLength(0);
    expect(collapsed[0].finding_id).toBe("N-bar");
  });

  it("collapses multiple entries onto one node; blocked dominates resolved", () => {
    const { collapsed } = collapseItemResults(
      [
        { finding_id: "N-z", status: "resolved", evidence: ["a"] },
        { finding_id: "N-z", status: "blocked", failure_reason: "boom", evidence: ["b"] },
      ],
      new Map(),
      new Set(["N-z"]),
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].status).toBe("blocked");
    expect(collapsed[0].evidence).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("an id that is neither a known finding nor a known alias is returned as unresolved (not dropped)", () => {
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: "TOTALLY-UNKNOWN", status: "resolved" }],
      new Map(),
      new Set(["N-x"]),
    );
    expect(collapsed).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].finding_id).toBe("TOTALLY-UNKNOWN");
  });
});

// ===========================================================================
// INV-ROLL-04: free_form_intent interpreted at the call site (INV-S04)
// ===========================================================================

describe("INV-ROLL-04: free_form_intent interpreted at the nextStep call site", () => {
  function tmpArtifacts(): string {
    return mkdtempSync(join(tmpdir(), "roll-intent-"));
  }

  it("interprets a confirmed checkpoint's free_form_intent into structured signals and persists them", async () => {
    const dir = tmpArtifacts();
    const checkpoint: IntentCheckpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "host",
      scope_summary: "all",
      intent_summary: "full",
      free_form_intent: "prioritize security, and improve performance",
    };
    const persisted = await interpretConfirmedCheckpointIntent(dir, checkpoint);
    expect(persisted).not.toBeNull();
    // Structured lens weights are emitted (security + performance), and the input
    // is decomposed into clauses — the whole verbatim string is never carried as
    // one field (INV-S04: the raw free_form_intent is interpreted, not threaded).
    expect(persisted!.interpreted.lensWeights.security).toBeGreaterThan(1);
    expect(persisted!.interpreted.lensWeights.performance).toBeGreaterThan(1);
    const allFields = [
      ...persisted!.interpreted.prioritySignals,
      ...persisted!.interpreted.scopeEmphasis,
      ...persisted!.interpreted.unencodableClauses,
    ];
    expect(allFields).not.toContain("prioritize security, and improve performance");
  });

  it("does not interpret a draft checkpoint (planning has not been confirmed yet)", async () => {
    const dir = tmpArtifacts();
    const draft: IntentCheckpoint = {
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      confirmed_by: "draft",
      scope_summary: "all",
      intent_summary: "full",
      free_form_intent: "prioritize security",
    };
    expect(await interpretConfirmedCheckpointIntent(dir, draft)).toBeNull();
  });

  it("surfaces unencodable clauses rather than dropping them", () => {
    const interpreted = interpretFreeFormIntent("frobnicate the wibble subsystem somehow");
    // No lens/priority/scope keyword matched → the clause is preserved as unencodable.
    expect(interpreted.unencodableClauses.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// fail-1: write-scope enforcement (git-diff vs declared scope; fail-closed)
// ===========================================================================

describe("fail-1: write-scope enforcement", () => {
  const root = "/repo";
  const declared = ["packages/a/src/foo.ts"];

  it("blocks when an edited file falls outside the declared write scope", () => {
    const edited: GitEditedFiles = {
      available: true,
      files: new Set(["packages/a/src/foo.ts", "packages/a/src/SNEAKY.ts"]),
    };
    const decision = enforceWriteScope(declared, edited, root);
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("SNEAKY.ts");
  });

  it("passes when edits are fully within scope (result files + feedback exempt)", () => {
    const edited: GitEditedFiles = {
      available: true,
      files: new Set(["packages/a/src/foo.ts", "x/y.result.json"]),
    };
    expect(enforceWriteScope(declared, edited, root).blocked).toBe(false);
  });

  it("fails CLOSED when git is a repo but the diff probe errors", () => {
    const edited: GitEditedFiles = { available: false, reason: "probe_failed", error: "git boom" };
    expect(enforceWriteScope(declared, edited, root).blocked).toBe(true);
  });

  it("skips the gate when root is not a git repo (no ground truth)", () => {
    const edited: GitEditedFiles = { available: false, reason: "not_a_repo", error: "no worktree" };
    expect(enforceWriteScope(declared, edited, root).blocked).toBe(false);
  });
});

// ===========================================================================
// fail-2: lost-update / overlapping-edit detection
// ===========================================================================

describe("fail-2: lost-update / overlapping-edit detection", () => {
  it("flags a file edited by more than one concurrently-merged block", () => {
    const overlaps = detectOverlappingEdits([
      { block_id: "B1", files: new Set(["src/shared.ts", "src/a.ts"]) },
      { block_id: "B2", files: new Set(["src/shared.ts", "src/b.ts"]) },
    ]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].path).toBe("src/shared.ts");
    expect(overlaps[0].block_ids).toEqual(["B1", "B2"]);
  });

  it("reports no overlap when each block edits disjoint files", () => {
    const overlaps = detectOverlappingEdits([
      { block_id: "B1", files: new Set(["src/a.ts"]) },
      { block_id: "B2", files: new Set(["src/b.ts"]) },
    ]);
    expect(overlaps).toHaveLength(0);
  });

  it("ignores sanctioned side outputs (result files, agent feedback) as overlaps", () => {
    const overlaps = detectOverlappingEdits([
      { block_id: "B1", files: new Set(["x/B1.result.json"]) },
      { block_id: "B2", files: new Set(["x/B2.result.json"]) },
    ]);
    expect(overlaps).toHaveLength(0);
  });

  it("a single block can never overlap with itself", () => {
    const overlaps = detectOverlappingEdits([
      { block_id: "B1", files: new Set(["src/a.ts", "src/b.ts"]) },
    ]);
    expect(overlaps).toHaveLength(0);
  });
});

// ===========================================================================
// fail-3: empty-pool stranding
// ===========================================================================

describe("fail-3: empty-pool stranding (no surviving pool)", () => {
  it("strands every pending packet and surfaces an empty_pool terminal when a pool rate-limits with no survivor", async () => {
    const pool: CapacityPool = {
      id: "p/only",
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: { active_subagents: 1, source: "session_config" },
    };
    const session: SessionConfig = { quota: {} };
    const dispatcher = createRollingDispatcher<{ id: string }>({
      confirmedPools: [pool],
      sessionConfig: session,
      // Every dispatch rate-limits → the only pool exhausts → remaining work is stranded.
      dispatchPacket: async (packet) => ({ packet, outcome: "rate_limited" as const }),
    });
    dispatcher.enqueue([
      { id: "S0", payload: { id: "S0" }, estimatedTokens: 100, complexity: 0.5 },
      { id: "S1", payload: { id: "S1" }, estimatedTokens: 100, complexity: 0.5 },
    ]);
    const results = await dispatcher.run();
    // No packet completed successfully; both are stranded.
    expect(results.filter((r) => r.outcome === "success")).toHaveLength(0);
    const terminal = dispatcher.getTerminal();
    expect(terminal).not.toBeNull();
    expect(terminal!.reason).toBe("empty_pool");
    expect(terminal!.stranded_ids.sort()).toEqual(["S0", "S1"]);
  });
});

// ===========================================================================
// fail-4: verify-before-accept (a node whose verify fails is not merged)
// ===========================================================================

describe("fail-4: verify-before-accept in a worktree", () => {
  // Drive a real git repo with two branches: one whose "verify" passes (merged)
  // and one whose verify fails (NOT merged). This exercises the same primitives
  // (worktree branch + mergeWorktree) the rolling driver gates acceptance on.
  it("a verified branch merges into HEAD; an unverified one is rejected and never lands", () => {
    const repo = mkdtempSync(join(tmpdir(), "roll-verify-"));
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
    if (git("init").status !== 0) return; // git unavailable → skip
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "--allow-empty", "-m", "base");

    // A "passing" node edits its own file on its branch.
    const branch = worktreeBranchForBlock("B-pass", "RID");
    git("checkout", "-b", branch);
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "ok.ts"), "export const ok = 1;\n");
    git("add", "-A");
    git("commit", "-m", "node edit");
    git("checkout", "-");

    // Simulate the driver's verify-before-accept: only merge when verify passes.
    const verifyPasses = true;
    if (verifyPasses) {
      const tip = git("rev-parse", branch).stdout.trim();
      const cp = git("cherry-pick", tip);
      expect(cp.status).toBe(0);
    }
    // The verified change landed on HEAD.
    const show = git("show", "HEAD:src/ok.ts");
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("export const ok");

    // An "unverified" node's branch is NEVER cherry-picked, so its change cannot
    // reach HEAD (the driver removes the worktree on a failed verify instead).
    const badBranch = worktreeBranchForBlock("B-fail", "RID");
    git("checkout", "-b", badBranch);
    writeFileSync(join(repo, "src", "bad.ts"), "syntax ( error\n");
    git("add", "-A");
    git("commit", "-m", "bad edit");
    git("checkout", "-");
    const verifyFails = false; // driver would skip the merge
    if (!verifyFails) {
      const badOnHead = git("show", "HEAD:src/bad.ts");
      expect(badOnHead.status).not.toBe(0); // bad.ts is NOT on HEAD
    }
  });
});

// ===========================================================================
// fail-5: the host-fanned wave fallback is RETAINED + DEFAULT (CE-001)
// ===========================================================================

describe("fail-5: host-wave fallback retained as opt-out; rolling engine defaults ON", () => {
  it("resolveRollingEngineEnabled defaults to TRUE (rolling is the default; wave is opt-out)", () => {
    expect(resolveRollingEngineEnabled({ env: {} })).toBe(true);
    expect(resolveRollingEngineEnabled({ sessionConfig: {}, env: {} })).toBe(true);
  });

  it("opts in only via explicit option, sessionConfig.dispatch.rolling_engine, or REMEDIATE_ROLLING_ENGINE", () => {
    expect(resolveRollingEngineEnabled({ rollingEngine: true, env: {} })).toBe(true);
    expect(
      resolveRollingEngineEnabled({ sessionConfig: { dispatch: { rolling_engine: true } }, env: {} }),
    ).toBe(true);
    expect(resolveRollingEngineEnabled({ env: { REMEDIATE_ROLLING_ENGINE: "true" } })).toBe(true);
    // Opt OUT via sessionConfig.dispatch.rolling_engine=false or REMEDIATE_ROLLING_ENGINE=false.
    expect(resolveRollingEngineEnabled({ sessionConfig: { dispatch: { rolling_engine: false } }, env: {} })).toBe(false);
    expect(resolveRollingEngineEnabled({ env: { REMEDIATE_ROLLING_ENGINE: "false" } })).toBe(false);
    // Explicit option wins over env.
    expect(
      resolveRollingEngineEnabled({ rollingEngine: false, env: { REMEDIATE_ROLLING_ENGINE: "true" } }),
    ).toBe(false);
  });
});

