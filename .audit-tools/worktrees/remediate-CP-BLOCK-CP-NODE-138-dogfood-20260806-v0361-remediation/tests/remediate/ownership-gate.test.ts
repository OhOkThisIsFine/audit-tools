// D-66/67 slice-1 — remediate-side merge-time ownership gate (OD3 layer 2).
//
// `acceptNodeWorktree` heartbeats an optional `ownership` lease immediately before
// the cherry-pick — the last moment before the irreversible base mutation. A peer
// that reclaimed the lease since dispatch (claimMany's same-pool re-grant mints a
// NEW token on any such re-grant) fails the token-checked heartbeat, so the accept
// refuses rather than land ownership-contested work. Covers:
//   - ownership absent → unchanged (no gate);
//   - a live, un-reclaimed lease → merges normally;
//   - a peer-reclaimed lease → refuses before the cherry-pick, quarantines, the
//     error outcome carries the ownership diagnostic;
//   - `executeNodeInWorktree` forwards `ownership` into the shared lifecycle (the
//     plumbing both nextStep.ts in-process/hybrid call sites share);
//   - `advanceHostRolling`'s contested-node fail-closed guard;
//   - `advanceHostRolling` gated end-to-end against a peer reclaim;
//   - the quarantine-ref no-clobber fix (a second failed commit for the same
//     (run, block) writes a SUFFIXED ref instead of overwriting the first);
//   - the accept-outcome sidecar never regresses merged:true -> merged:false.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { ClaimRegistry } from "audit-tools/shared";
import {
  acceptNodeWorktree,
  createWorktree,
  worktreePath,
  worktreeBranchForBlock,
  executeNodeInWorktree,
  recordNodeAcceptOutcome,
  loadNodeAcceptOutcome,
  quarantineFailedNodeCommit,
  quarantineRef,
} from "../../src/remediate/steps/dispatch.js";
import {
  advanceHostRolling,
  nodeClaimRegistry,
  type RollingSession,
} from "../../src/remediate/steps/rollingSession.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import type { WorktreeNodeWorker } from "../../src/remediate/steps/dispatch.js";

function initRepo(prefix: string): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (git("init").status !== 0) return { repo, ok: false };
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // Trivial cross-platform `check` script: the derived per-node verify runs
  // `npm run check`; `node --version` exits 0 and needs no deps.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "og-fixture", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
  );
  git("add", "package.json");
  git("commit", "-m", "base");
  return { repo, ok: true };
}

function headHas(repo: string, path: string): boolean {
  return spawnSync("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "utf8", shell: false }).status === 0;
}

function refExists(repo: string, ref: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repo,
      encoding: "utf8",
      shell: false,
    }).status === 0
  );
}

function revParse(repo: string, rev: string): string {
  return spawnSync("git", ["rev-parse", rev], { cwd: repo, encoding: "utf8", shell: false }).stdout.trim();
}

function makeWorktreeWithEdit(repo: string, runId: string, blockId: string, file: string): string {
  const wt = worktreePath(repo, blockId, runId);
  createWorktree(repo, wt, worktreeBranchForBlock(blockId, runId));
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", file), `export const x = "${blockId}";\n`);
  return wt;
}

// ===========================================================================
// acceptNodeWorktree — the merge-time ownership gate
// ===========================================================================

describe("acceptNodeWorktree — merge-time ownership gate", () => {
  it("ownership omitted -> unchanged (no gate, merges normally)", async () => {
    const { repo, ok } = initRepo("og-absent-");
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "R1", "OG1", "a.ts");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R1",
      blockId: "OG1",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("OG1", "R1"),
      workerOutcome: "success",
      targetedCommands: [],
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(true);
    expect(headHas(repo, "src/a.ts")).toBe(true);
  });

  it("a live, un-reclaimed lease heartbeats true -> merges normally", async () => {
    const { repo, ok } = initRepo("og-live-");
    if (!ok) return;
    const registry = new ClaimRegistry(join(repo, "claims.json"));
    const claim = await registry.claim("OG2", "pool-a");
    expect(claim.acquired).toBe(true);
    const ownerToken = claim.acquired ? claim.ownerToken : "";
    const wt = makeWorktreeWithEdit(repo, "R1", "OG2", "a.ts");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R1",
      blockId: "OG2",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("OG2", "R1"),
      workerOutcome: "success",
      targetedCommands: [],
      ownership: { registry, nodeId: "OG2", ownerToken },
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(true);
    expect(headHas(repo, "src/a.ts")).toBe(true);
    // The gate refreshed (not released) the lease — still claimed under our token.
    expect(await registry.isClaimed("OG2")).toBe(true);
  });

  it("a peer-reclaimed lease (rotated token) refuses before the cherry-pick, quarantines, carries the ownership diagnostic", async () => {
    const { repo, ok } = initRepo("og-reclaim-");
    if (!ok) return;
    const registry = new ClaimRegistry(join(repo, "claims.json"));
    const first = await registry.claim("OG3", "pool-a");
    expect(first.acquired).toBe(true);
    const staleToken = first.acquired ? first.ownerToken : "";
    // Simulate a peer reclaim: `claimMany` on the SAME poolId RE-GRANTS a live claim,
    // minting a fresh token (claimRegistry.ts:148-172) — this is the exact mechanism
    // the design rests on (any peer re-partition rotates the token; supersession is
    // always detectable). The original token is now stale.
    const reclaim = await registry.claimMany(["OG3"], "pool-a");
    expect(reclaim.granted).toContain("OG3");
    expect(reclaim.ownerTokenByNode.OG3).not.toBe(staleToken);

    const wt = makeWorktreeWithEdit(repo, "R1", "OG3", "a.ts");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R1",
      blockId: "OG3",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("OG3", "R1"),
      workerOutcome: "success",
      targetedCommands: [],
      ownership: { registry, nodeId: "OG3", ownerToken: staleToken },
    });
    expect(res.outcome).toBe("error");
    expect(res.merged).toBe(false);
    // Verify DID pass — the gate fires AFTER verify, at the last moment before the
    // cherry-pick — so this is not conflated with a verify failure.
    expect(res.verifyPassed).toBe(true);
    expect(res.diagnostic).toMatch(/ownership gate/i);
    expect(res.diagnostic).toContain("OG3");
    // Nothing landed; the worktree is dropped.
    expect(headHas(repo, "src/a.ts")).toBe(false);
    expect(existsSync(wt)).toBe(false);
    // The committed work is preserved under a durable quarantine ref, never lost.
    expect(refExists(repo, quarantineRef("R1", "OG3"))).toBe(true);
    // The peer's live claim (the rotated token) is untouched.
    expect(await registry.isClaimed("OG3")).toBe(true);
  });
});

// ===========================================================================
// executeNodeInWorktree — forwards `ownership` into the shared accept lifecycle
// (the plumbing both nextStep.ts in-process and hybrid call sites share).
// ===========================================================================

describe("executeNodeInWorktree — ownership threading", () => {
  it("a peer-reclaimed lease refuses the node even though the worker + verify succeed", async () => {
    const { repo, ok } = initRepo("og-exec-");
    if (!ok) return;
    const registry = new ClaimRegistry(join(repo, "claims.json"));
    const first = await registry.claim("OG4", "pool-a");
    const staleToken = first.acquired ? first.ownerToken : "";
    await registry.claimMany(["OG4"], "pool-a"); // peer reclaim, rotates the token

    const worker: WorktreeNodeWorker = async ({ block, worktreeRoot, resultPath }) => {
      mkdirSync(join(worktreeRoot, "src"), { recursive: true });
      writeFileSync(join(worktreeRoot, "src", "x.ts"), `export const x = "${block.block_id}";\n`);
      writeFileSync(
        resultPath,
        JSON.stringify({
          contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
          phase: "implement",
          item_results: [{ finding_id: `${block.block_id}-f`, status: "resolved", evidence: ["e"] }],
        }),
      );
      return {
        packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
        outcome: "success",
      };
    };

    const artifactsDir = join(repo, ".audit-tools", "remediation");
    mkdirSync(artifactsDir, { recursive: true });
    const resultPath = join(artifactsDir, "OG4.result.json");
    const { accept } = await executeNodeInWorktree({
      block: { block_id: "OG4", items: [], parallel_safe: true } as never,
      slot: { providerName: "claude-code", hostModel: null, poolId: "pool-a" },
      root: repo,
      artifactsDir,
      runId: "R1",
      resultPath,
      seedPaths: [],
      allBlockScopes: [],
      dispatchNode: worker,
      ownership: { registry, nodeId: "OG4", ownerToken: staleToken },
    });
    expect(accept.outcome).toBe("error");
    expect(accept.merged).toBe(false);
    expect(accept.diagnostic).toMatch(/ownership gate/i);
    expect(headHas(repo, "src/x.ts")).toBe(false);
  });
});

// ===========================================================================
// advanceHostRolling — contested-node fail-closed guard (§5b) + gated end-to-end.
// ===========================================================================

describe("advanceHostRolling — ownership gate integration", () => {
  it("refuses (fail-closed) an accept for a CONTESTED block id it never claimed", async () => {
    const { repo, ok } = initRepo("og-contested-");
    if (!ok) return;
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const implDir = join(artifactsDir, "runs", "R1", "implement");
    mkdirSync(implDir, { recursive: true });
    // A contested node is part of the frontier (so the "not in frontier" throw does
    // not fire first) but was NEVER claimed/dispatched by this session — exactly
    // `prepareHostRollingDispatch`'s real contested-node shape.
    const session: RollingSession = {
      run_id: "R1",
      frontier: [{ block_id: "OG5", prompt_path: join(implDir, "OG5.md"), result_path: join(artifactsDir, "OG5.result.json") }],
      dispatched: [],
      accepted: [],
      claims: {},
      contested: ["OG5"],
    };
    writeFileSync(join(implDir, "rolling-session.json"), JSON.stringify(session));

    await expect(
      advanceHostRolling({ root: repo, artifactsDir, runId: "R1", blockId: "OG5" }),
    ).rejects.toThrow(/contested/i);
  });

  it("a LEGACY claims-less session (persisted before claim-wiring) accepts a non-contested block UNGATED — never bricked", async () => {
    const { repo, ok } = initRepo("og-legacy-");
    if (!ok) return;
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const implDir = join(artifactsDir, "runs", "R1", "implement");
    mkdirSync(implDir, { recursive: true });
    const resultPath = join(artifactsDir, "OG7.result.json");
    writeFileSync(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [{ finding_id: "OG7", status: "resolved_no_change", evidence: ["ok"] }],
      }),
    );
    const wt = worktreePath(repo, "OG7", "R1");
    createWorktree(repo, wt, worktreeBranchForBlock("OG7", "R1"));
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "og7.ts"), 'export const x = "OG7";\n');
    // A session persisted BEFORE claim-wiring: no `claims` key at all, no
    // `contested` — the exact on-disk shape the `session.claims ??= {}` default
    // exists for. The guard must NOT throw; the accept runs ungated (pre-slice
    // behaviour) and the node lands.
    const legacySession = {
      run_id: "R1",
      frontier: [{ block_id: "OG7", prompt_path: join(implDir, "OG7.md"), result_path: resultPath }],
      dispatched: ["OG7"],
      accepted: [],
    };
    writeFileSync(join(implDir, "rolling-session.json"), JSON.stringify(legacySession));

    const directive = await advanceHostRolling({ root: repo, artifactsDir, runId: "R1", blockId: "OG7" });
    expect(directive.kind).toBe("done");
    expect(headHas(repo, "src/og7.ts")).toBe(true);
  });

  it("a peer reclaim between claim and accept refuses the node, quarantines, and records the ownership diagnostic on the sidecar", async () => {
    const { repo, ok } = initRepo("og-host-reclaim-");
    if (!ok) return;
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const implDir = join(artifactsDir, "runs", "R1", "implement");
    mkdirSync(implDir, { recursive: true });
    const resultPath = join(artifactsDir, "OG6.result.json");
    writeFileSync(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [{ finding_id: "OG6", status: "resolved_no_change", evidence: ["ok"] }],
      }),
    );
    const wt = worktreePath(repo, "OG6", "R1");
    createWorktree(repo, wt, worktreeBranchForBlock("OG6", "R1"));
    // A real edit so the node actually commits — the ownership gate lives in the
    // base-mutating section, which the genuine no-commit branch never reaches.
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "og6.ts"), 'export const x = "OG6";\n');

    const registry = nodeClaimRegistry(artifactsDir, "R1");
    const claim = await registry.claim("OG6", "host-subagent");
    const staleToken = claim.acquired ? claim.ownerToken : "";
    const session: RollingSession = {
      run_id: "R1",
      frontier: [{ block_id: "OG6", prompt_path: join(implDir, "OG6.md"), result_path: resultPath }],
      dispatched: ["OG6"],
      accepted: [],
      claims: { OG6: staleToken },
    };
    writeFileSync(join(implDir, "rolling-session.json"), JSON.stringify(session));

    // Peer reclaim (same pool id `advanceHostRolling`/`prepareHostRollingDispatch`
    // use) rotates the token AFTER this session recorded its claim.
    await registry.claimMany(["OG6"], "host-subagent");

    const directive = await advanceHostRolling({ root: repo, artifactsDir, runId: "R1", blockId: "OG6" });
    // Terminal (refused) accept still counts as "handled" for this session — same
    // terminal-on-any-outcome shape every other pre-merge refusal uses.
    expect(directive.kind).toBe("done");

    const sidecar = join(implDir, "accept-outcome-OG6.json");
    expect(existsSync(sidecar)).toBe(true);
    const rec = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(rec.outcome).toBe("error");
    expect(rec.merged).toBe(false);
    expect(rec.diagnostic).toMatch(/ownership gate/i);
    expect(headHas(repo, "src/og6.ts")).toBe(false);
    // The peer's rotated claim is untouched (our stale-token release was a no-op).
    expect(await registry.isClaimed("OG6")).toBe(true);
  });
});

// ===========================================================================
// Quarantine ref no-clobber (§6): a second failed commit for the SAME (run, block)
// must not force-overwrite an already-preserved DIFFERENT commit.
// ===========================================================================

describe("quarantineFailedNodeCommit — no-clobber", () => {
  it("a second quarantine for the same (run, block) at a DIFFERENT commit writes a suffixed ref; the primary ref keeps the first commit", () => {
    const { repo, ok } = initRepo("og-noclobber-");
    if (!ok) return;
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
    // Capture the base branch name (main/master varies by git config) so branch-b
    // can be created from the SAME base as branch-a, not stacked on top of it.
    const baseBranch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim();

    // Two independent branches, each one commit, off the same base.
    git("checkout", "-b", "branch-a");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-m", "commit A");
    const commitA = revParse(repo, "branch-a");

    git("checkout", baseBranch);
    git("checkout", "-b", "branch-b");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-m", "commit B");
    const commitB = revParse(repo, "branch-b");
    expect(commitA).not.toBe(commitB);

    const first = quarantineFailedNodeCommit(repo, "branch-a", "R1", "SHARED");
    expect(first?.commit).toBe(commitA);
    expect(first?.ref).toBe(quarantineRef("R1", "SHARED"));

    const second = quarantineFailedNodeCommit(repo, "branch-b", "R1", "SHARED");
    expect(second?.commit).toBe(commitB);
    // A DISTINCT, content-derived suffixed ref — never the primary.
    expect(second?.ref).not.toBe(quarantineRef("R1", "SHARED"));
    expect(second?.ref).toBe(`${quarantineRef("R1", "SHARED")}-${commitB.slice(0, 8)}`);

    // Both are preserved: the primary ref still resolves to the FIRST commit (A's
    // work is never clobbered by B's later failure); the suffixed ref holds B's.
    expect(revParse(repo, quarantineRef("R1", "SHARED"))).toBe(commitA);
    expect(revParse(repo, second!.ref)).toBe(commitB);
  });

  it("re-quarantining the SAME commit is idempotent (writes the primary ref directly, no suffix)", () => {
    const { repo, ok } = initRepo("og-noclobber-same-");
    if (!ok) return;
    const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
    git("checkout", "-b", "branch-a");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-m", "commit A");
    const commitA = revParse(repo, "branch-a");

    const first = quarantineFailedNodeCommit(repo, "branch-a", "R1", "SAME");
    const second = quarantineFailedNodeCommit(repo, "branch-a", "R1", "SAME");
    expect(first?.ref).toBe(quarantineRef("R1", "SAME"));
    expect(second?.ref).toBe(quarantineRef("R1", "SAME"));
    expect(revParse(repo, quarantineRef("R1", "SAME"))).toBe(commitA);
  });
});

// ===========================================================================
// Sidecar regression guard (§8): a write must never regress merged:true -> false.
// ===========================================================================

describe("recordNodeAcceptOutcome — sidecar merged:true regression guard", () => {
  it("a later merged:false write does NOT clobber an already-recorded merged:true", async () => {
    const { repo, ok } = initRepo("og-sidecar-");
    if (!ok) return;
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    await recordNodeAcceptOutcome(artifactsDir, "R1", "SC1", {
      outcome: "success",
      verifyPassed: true,
      merged: true,
    });
    // A later, out-of-order write claims the node never landed — must be ignored.
    await recordNodeAcceptOutcome(artifactsDir, "R1", "SC1", {
      outcome: "error",
      verifyPassed: false,
      merged: false,
      diagnostic: "stale out-of-order write",
    });
    const loaded = await loadNodeAcceptOutcome(artifactsDir, "R1", "SC1");
    expect(loaded?.merged).toBe(true);
    expect(loaded?.outcome).toBe("success");
  });

  it("a merged:false -> merged:true progression is NOT blocked (only the regression is)", async () => {
    const { repo, ok } = initRepo("og-sidecar-fwd-");
    if (!ok) return;
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    await recordNodeAcceptOutcome(artifactsDir, "R1", "SC2", {
      outcome: "error",
      verifyPassed: false,
      merged: false,
    });
    await recordNodeAcceptOutcome(artifactsDir, "R1", "SC2", {
      outcome: "success",
      verifyPassed: true,
      merged: true,
    });
    const loaded = await loadNodeAcceptOutcome(artifactsDir, "R1", "SC2");
    expect(loaded?.merged).toBe(true);
  });
});
