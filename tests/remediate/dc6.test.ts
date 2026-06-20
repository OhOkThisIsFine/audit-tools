/**
 * DC-6: host-subagent rolling driver pulled through the SHARED a8/a10 claim
 * registry, so the host-subagent loop and the in-process provider engine are
 * mutually exclusive on a node (exactly-one-claimant across both drivers — no
 * double-dispatch), every completion routes through the IDENTICAL
 * acceptNodeWorktree → recordNodeAcceptOutcome lifecycle (lock-guarded, idempotent
 * re-accept), and the legacy host-fanned wave stays the conversation-first fallback
 * when the rolling engine is off.
 *
 * Real git worktrees; no state.json needed (loadState → null → empty verify
 * auto-passes), so these isolate the driver/registry wiring.
 *
 * Verifies:
 *   rolling next-node     each accept JIT-claims + dispatches the next undispatched
 *                         frontier node through the shared registry, and the node's
 *                         claim is held while in flight and released on accept.
 *   cross-driver accept   a node the SHARED registry already hands to a peer driver
 *                         is recorded `contested` and NOT re-dispatched by the host
 *                         loop — never both pick the same node.
 *   session-lock race     concurrent accept-node callbacks for distinct nodes are
 *                         serialized by the session lock (no lost acceptance / no
 *                         double-dispatch); a re-run for one node stays idempotent.
 *   legacy fallback       when the rolling engine is off, the implement step is the
 *                         host-fanned wave (`dispatch_implement`), not a rolling step.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { ClaimRegistry } from "../../src/shared/quota/claimRegistry.js";
import {
  createWorktree,
  worktreePath,
  worktreeBranchForBlock,
} from "../../src/remediate/steps/dispatch.js";
import {
  advanceHostRolling,
  nodeClaimRegistry,
  nodeClaimRegistryPath,
  type RollingSession,
} from "../../src/remediate/steps/rollingSession.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";

const RID = "RID";

function git(repo: string, ...args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
}

function initRepo(): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "dc6-roll-")));
  if (git(repo, "init").status !== 0) return { repo, ok: false };
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  // Trivial cross-platform `check` script: the per-node verify derives + runs
  // `npm run check`; `node --version` exits 0 and needs no deps.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify(
      { name: "dc6-roll-fixture", private: true, scripts: { check: "node --version" } },
      null,
      2,
    ) + "\n",
  );
  git(repo, "add", "package.json");
  git(repo, "commit", "-m", "base");
  return { repo, ok: true };
}

/** Seed a rolling session + the per-node result files; pre-create + CLAIM the initial batch. */
async function seedSession(
  repo: string,
  frontierIds: string[],
  slots: number,
): Promise<{ artifactsDir: string; registry: ClaimRegistry }> {
  const artifactsDir = join(repo, ".audit-tools", "remediation");
  const implDir = join(artifactsDir, "runs", RID, "implement");
  mkdirSync(implDir, { recursive: true });
  const frontier = frontierIds.map((id) => ({
    block_id: id,
    prompt_path: join(implDir, `${id}.md`),
    result_path: join(artifactsDir, `${id}.result.json`),
  }));
  // A resolved result per node → resultOutcome = "success".
  for (const node of frontier) {
    writeFileSync(
      node.result_path,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [{ finding_id: node.block_id, status: "resolved", evidence: ["ok"] }],
      }),
    );
  }
  const registry = nodeClaimRegistry(artifactsDir, RID);
  const initial = frontierIds.slice(0, Math.min(slots, frontierIds.length));
  const claims: Record<string, string> = {};
  for (const id of initial) {
    createWorktree(repo, worktreePath(repo, id, RID), worktreeBranchForBlock(id, RID));
    // Claim the initial batch through the shared registry (parity with
    // prepareHostRollingDispatch), so the persisted session carries owner tokens.
    const claim = await registry.claim(id, "host-subagent");
    if (claim.acquired) claims[id] = claim.ownerToken;
  }
  const session: RollingSession = {
    run_id: RID,
    slots,
    frontier,
    dispatched: initial,
    accepted: [],
    claims,
  };
  writeFileSync(join(implDir, "rolling-session.json"), JSON.stringify(session));
  return { artifactsDir, registry };
}

function readSession(artifactsDir: string): RollingSession {
  return JSON.parse(
    readFileSync(join(artifactsDir, "runs", RID, "implement", "rolling-session.json"), "utf8"),
  );
}

// ===========================================================================
// Rolling next-node: each accept JIT-claims + dispatches the next frontier node
// through the shared registry; the claim is held in flight, released on accept.
// ===========================================================================

describe("DC-6 rolling next-node through the shared claim registry", () => {
  it("claims the JIT-dispatched node and releases each node's claim on accept", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // 3 nodes, slots=2: B1,B2 pre-dispatched+claimed; B3 is JIT-claimed on the first completion.
    const { artifactsDir, registry } = await seedSession(repo, ["B1", "B2", "B3"], 2);

    // Before any completion B1 + B2 hold live claims; B3 is unclaimed.
    expect(await registry.isClaimed("B1")).toBe(true);
    expect(await registry.isClaimed("B2")).toBe(true);
    expect(await registry.isClaimed("B3")).toBe(false);

    const d1 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(d1.kind).toBe("dispatch");
    if (d1.kind === "dispatch") expect(d1.node.block_id).toBe("B3");
    // B1's claim was released on accept; B3 was JIT-claimed before dispatch.
    expect(await registry.isClaimed("B1")).toBe(false);
    expect(await registry.isClaimed("B3")).toBe(true);
    // The session persisted B3's owner token and dropped B1's.
    const s1 = readSession(artifactsDir);
    expect(s1.claims.B3).toBeTruthy();
    expect(s1.claims.B1).toBeUndefined();

    // B2 finishes; B3 still in flight, nothing left to dispatch → wait.
    const d2 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B2" });
    expect(d2.kind).toBe("wait");
    expect(await registry.isClaimed("B2")).toBe(false);

    // B3 finishes; all accepted → done, and no claim is left dangling.
    const d3 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B3" });
    expect(d3.kind).toBe("done");
    if (d3.kind === "done") expect(d3.accepted).toBe(3);
    expect(await registry.isClaimed("B3")).toBe(false);
    expect(Object.keys(await registry.listClaims())).toEqual([]);
  });
});

// ===========================================================================
// Cross-driver single-accept: a node a PEER driver already holds in the SHARED
// registry is NOT re-dispatched by the host loop — exactly-one-claimant.
// ===========================================================================

describe("DC-6 cross-driver single-accept concurrency", () => {
  it("does not JIT-dispatch a node a peer driver already claimed (no double-dispatch)", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // 3 nodes, slots=1: only B1 is pre-dispatched. B2, B3 are JIT candidates.
    const { artifactsDir } = await seedSession(repo, ["B1", "B2", "B3"], 1);

    // A PEER driver (the in-process engine) claims B2 against the SAME registry path
    // BEFORE the host loop reaches it. The host loop must skip B2 (contested) and
    // JIT-dispatch B3 instead — the two drivers never both pick B2.
    const peer = new ClaimRegistry(nodeClaimRegistryPath(artifactsDir, RID));
    const peerClaim = await peer.claim("B2", "in-process");
    expect(peerClaim.acquired).toBe(true);

    const d1 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(d1.kind).toBe("dispatch");
    if (d1.kind === "dispatch") expect(d1.node.block_id).toBe("B3"); // skipped contested B2

    const s = readSession(artifactsDir);
    expect(s.contested).toContain("B2");
    expect(s.dispatched).not.toContain("B2"); // host never dispatched the peer's node
    expect(s.dispatched).toContain("B3");
    // This session owns 2 of the 3 nodes (B2 is the peer's); B3 still in flight.
    if (d1.kind === "dispatch") {
      expect(d1.total).toBe(2);
      expect(d1.accepted).toBe(1);
    }

    // B3 finishes. B2 is the peer's, so the host session is DONE on its own 2 nodes
    // rather than waiting forever on the contested node.
    const d2 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B3" });
    expect(d2.kind).toBe("done");
    if (d2.kind === "done") expect(d2.total).toBe(2);

    // The host loop never touched the peer's claim on B2.
    expect(await peer.isClaimed("B2")).toBe(true);
  });
});

// ===========================================================================
// Session-lock race: concurrent accept-node callbacks for distinct nodes are
// serialized by the session lock — no lost acceptance, no double-dispatch — and a
// re-run for an already-accepted node stays idempotent.
// ===========================================================================

describe("DC-6 session-lock race", () => {
  it("serializes concurrent completions: every node accepted once, JIT-claims consistent", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // 4 nodes, slots=2: B1,B2 in flight; B3,B4 are JIT candidates.
    const { artifactsDir, registry } = await seedSession(repo, ["B1", "B2", "B3", "B4"], 2);

    // B1 and B2 complete CONCURRENTLY. The session lock must serialize the two
    // read-modify-writes so neither acceptance is lost and B3/B4 are each claimed +
    // dispatched by exactly one of the two callbacks (no double-claim, no skip).
    const [r1, r2] = await Promise.all([
      advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" }),
      advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B2" }),
    ]);

    const dispatchedNext = [r1, r2]
      .filter((d): d is Extract<typeof d, { kind: "dispatch" }> => d.kind === "dispatch")
      .map((d) => d.node.block_id)
      .sort();
    // Both completions had a next node to dispatch → B3 and B4, each exactly once.
    expect(dispatchedNext).toEqual(["B3", "B4"]);

    const s = readSession(artifactsDir);
    // Both B1 and B2 were accepted (neither acceptance lost to the race).
    expect(s.accepted.sort()).toEqual(["B1", "B2"]);
    // B3 and B4 are both claimed + dispatched exactly once (no duplicates).
    expect(s.dispatched.filter((id) => id === "B3")).toHaveLength(1);
    expect(s.dispatched.filter((id) => id === "B4")).toHaveLength(1);
    // The two finished nodes' claims were released; the two new ones are held.
    expect(await registry.isClaimed("B1")).toBe(false);
    expect(await registry.isClaimed("B2")).toBe(false);
    expect(await registry.isClaimed("B3")).toBe(true);
    expect(await registry.isClaimed("B4")).toBe(true);
  });

  it("is idempotent: a re-run for an already-accepted node does not double-accept or double-release", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const { artifactsDir, registry } = await seedSession(repo, ["B1"], 1);
    const first = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(first.kind).toBe("done");
    expect(await registry.isClaimed("B1")).toBe(false);

    // Re-run: no throw, still done, accepted count unchanged (1, not 2), and the
    // already-released claim is not touched again.
    const again = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(again.kind).toBe("done");
    if (again.kind === "done") expect(again.accepted).toBe(1);
    expect(Object.keys(await registry.listClaims())).toEqual([]);
  });
});

// ===========================================================================
// Legacy fallback: when the rolling engine is off, the implement step is the
// host-fanned wave, NOT a rolling step. (resolveRollingEngineEnabled is the gate.)
// ===========================================================================

describe("DC-6 legacy host-fanned wave fallback", () => {
  it("rolling engine off → host-fanned wave is selected over the rolling driver", async () => {
    // The selection gate the implement step consults: rolling driver only when the
    // engine is enabled; otherwise the legacy host-fanned wave (`dispatch_implement`).
    const { resolveRollingEngineEnabled } = await import(
      "../../src/remediate/steps/nextStep.js"
    );
    // Explicit off (session config) → disabled regardless of env/default.
    expect(
      resolveRollingEngineEnabled({
        sessionConfig: { dispatch: { rolling_engine: false } } as never,
        env: {},
      }),
    ).toBe(false);
    // Env off likewise disables.
    expect(
      resolveRollingEngineEnabled({ env: { REMEDIATE_ROLLING_ENGINE: "false" } as never }),
    ).toBe(false);
    // Default (no signal) → rolling enabled, so the legacy wave is the explicit opt-OUT.
    expect(resolveRollingEngineEnabled({ env: {} as never })).toBe(true);
  });
});
