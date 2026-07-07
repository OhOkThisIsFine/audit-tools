/**
 * CP-NODE-1 — dispatch worktree safety (HIGH bug). Pinning tests for the
 * finalized `dispatch-worktree-safety` module contract (INV-WTS-1..8 + the coupled
 * failure modes). Positive AND negative polarity for each invariant.
 *
 *  INV-WTS-1  isolation / no sibling clobber (path-scoped reset, no global prune)
 *  INV-WTS-2  verify FAILS LOUD when git-toplevel(cwd) != the node's worktree root
 *  INV-WTS-3  disposition reconciled by NODE-IDENTITY (captured commit ancestry),
 *             not a bare path-existence probe
 *  INV-WTS-4  stale-sweep never prunes in-flight / uncommitted work
 *  INV-WTS-5  every terminal state.json flip is git-ground-truth (via marshal)
 *  INV-WTS-6  distinct lock PATHS (per-node worktree lock != base lock)
 *  INV-WTS-7  resolved_no_change grounded in the captured commit OID (genuine only
 *             when NO captured OID + empty branch; captured OID + empty = clobber)
 *  INV-WTS-8  ONE total lock order — per-node worktree lock ALWAYS before base lock
 *
 * The lifecycle + accept assertions run against a genuine temp git repo (the
 * strongest ground truth); the marshal reconcile assertions drive
 * `mergeImplementResults` over a real repo + crafted accept-outcome sidecars.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorktree,
  removeWorktree,
  resetNodeWorktreeAndBranch,
  worktreePath,
  worktreeBranchForBlock,
  worktreeNodeLockPath,
  baseBranchLockPath,
  quarantineRef,
  quarantineCommitByOid,
  gitCommitIsAncestor,
  gitBranchExists,
  acceptNodeWorktree,
  recordNodeAcceptOutcome,
  mergeImplementResults,
} from "../../src/remediate/steps/dispatch.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding, RemediationBlock } from "../../src/remediate/state/types.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// These tests drive REAL git; do not mock node:child_process here.
const RM_DIRS: string[] = [];
const git = (repo: string, ...a: string[]) =>
  spawnSyncHidden("git", a, { cwd: repo, encoding: "utf8", shell: false, windowsHide: true });

function initRepo(prefix: string): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  RM_DIRS.push(repo);
  git(repo, "init");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fx", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
  );
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.audit-tools/\n");
  git(repo, "add", "package.json", ".gitignore");
  git(repo, "commit", "-m", "base");
  return repo;
}

const headOid = (repo: string): string =>
  git(repo, "rev-parse", "HEAD").stdout.trim();
const refExists = (repo: string, ref: string): boolean =>
  git(repo, "rev-parse", "--verify", "--quiet", ref).status === 0;

afterEach(() => {
  for (const d of RM_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

// ---------------------------------------------------------------------------
// INV-WTS-1 / INV-WTS-4 — path-scoped reset never clobbers a sibling / in-flight
// worktree (no global `git worktree prune`, no cross-node rmSync).
// ---------------------------------------------------------------------------

describe("INV-WTS-1/4 — reset is path-scoped, never clobbers a sibling", () => {
  it("resetting node A leaves sibling B's worktree dir + branch + uncommitted work intact", () => {
    const repo = initRepo("wts-sibling-");
    const wtA = worktreePath(repo, "A", "R");
    const wtB = worktreePath(repo, "B", "R");
    createWorktree(repo, wtA, worktreeBranchForBlock("A", "R"));
    createWorktree(repo, wtB, worktreeBranchForBlock("B", "R"));
    // Sibling B has IN-FLIGHT uncommitted work.
    writeFileSync(join(wtB, "wip.ts"), "export const wip = 1;\n");
    expect(existsSync(wtB)).toBe(true);
    expect(gitBranchExists(repo, worktreeBranchForBlock("B", "R"))).toBe(true);

    // Reset node A (the stale-sweep vector) while B is in flight.
    resetNodeWorktreeAndBranch(repo, wtA, worktreeBranchForBlock("A", "R"));

    // A is gone; B — dir, branch, AND its uncommitted edit — survives intact.
    expect(existsSync(wtA)).toBe(false);
    expect(gitBranchExists(repo, worktreeBranchForBlock("A", "R"))).toBe(false);
    expect(existsSync(wtB)).toBe(true);
    expect(existsSync(join(wtB, "wip.ts"))).toBe(true);
    expect(gitBranchExists(repo, worktreeBranchForBlock("B", "R"))).toBe(true);
    // B is still a registered worktree.
    const list = git(repo, "worktree", "list", "--porcelain").stdout;
    expect(list).toContain(wtB.replace(/\\/g, "/"));
  });

  it("clears a STALE registration whose dir vanished (node A) without touching sibling B", () => {
    const repo = initRepo("wts-stale-reg-");
    const wtA = worktreePath(repo, "A", "R");
    const wtB = worktreePath(repo, "B", "R");
    createWorktree(repo, wtA, worktreeBranchForBlock("A", "R"));
    createWorktree(repo, wtB, worktreeBranchForBlock("B", "R"));
    // Node A's dir vanishes out-of-band (registration is now stale).
    rmSync(wtA, { recursive: true, force: true });

    resetNodeWorktreeAndBranch(repo, wtA, worktreeBranchForBlock("A", "R"));

    // A's stale registration is cleared path-scoped; A's path can be re-added.
    createWorktree(repo, wtA, worktreeBranchForBlock("A", "R"));
    expect(existsSync(wtA)).toBe(true);
    // B untouched throughout — never pruned by a global sweep.
    expect(existsSync(wtB)).toBe(true);
    expect(gitBranchExists(repo, worktreeBranchForBlock("B", "R"))).toBe(true);
  });

  it("SOURCE: resetNodeWorktreeAndBranch performs no global `git worktree prune`", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "remediate", "steps", "dispatch", "worktreeLifecycle.ts"),
      "utf8",
    );
    // The reset body must not shell out to a bare, un-path-scoped worktree prune.
    expect(src).not.toMatch(/\[\s*"worktree"\s*,\s*"prune"\s*\]/);
  });
});

// ---------------------------------------------------------------------------
// INV-WTS-2 — build-free verify FAILS LOUD on git-toplevel escape (real git).
// ---------------------------------------------------------------------------

describe("INV-WTS-2 — verify fails loud when the worktree was deleted (toplevel escapes to MAIN)", () => {
  it("returns passed:false (not a false-green) when the verify cwd resolves up to MAIN", async () => {
    const { verifyNodeInWorktree } = await import("../../src/remediate/steps/dispatch.js");
    const repo = initRepo("wts-toplevel-");
    const wt = worktreePath(repo, "V", "R");
    createWorktree(repo, wt, worktreeBranchForBlock("V", "R"));
    // The worktree dir is deleted out from under the verify — a bare command with
    // cwd=wt would resolve UP to the enclosing MAIN checkout and false-green.
    rmSync(wt, { recursive: true, force: true });

    const res = verifyNodeInWorktree(wt, ["node --version"], true);
    expect(res.passed).toBe(false);
    expect(res.output).toMatch(/verify REFUSED|top-level|no longer exists/i);
  });

  it("POSITIVE: runs and passes when the cwd IS the node's own worktree root", async () => {
    const { verifyNodeInWorktree } = await import("../../src/remediate/steps/dispatch.js");
    const repo = initRepo("wts-toplevel-ok-");
    const wt = worktreePath(repo, "V2", "R");
    createWorktree(repo, wt, worktreeBranchForBlock("V2", "R"));
    const res = verifyNodeInWorktree(wt, ["node --version"], true);
    expect(res.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-WTS-6 / INV-WTS-8 — distinct lock paths; a fixed total order (per-node
// worktree lock path is derived per block; base lock is a single per-run path).
// ---------------------------------------------------------------------------

describe("INV-WTS-6/8 — lock paths are distinct and per-node", () => {
  it("the per-node worktree lock is DISTINCT from the base-branch lock", () => {
    const root = "/repo";
    expect(worktreeNodeLockPath(root, "R", "A")).not.toBe(baseBranchLockPath(root, "R"));
  });

  it("two different nodes hold DIFFERENT per-node worktree locks (never contend)", () => {
    const root = "/repo";
    expect(worktreeNodeLockPath(root, "R", "A")).not.toBe(worktreeNodeLockPath(root, "R", "B"));
  });

  it("SOURCE: acceptNodeWorktree acquires the per-node worktree lock before the base lock", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "src", "remediate", "steps", "dispatch", "acceptNode.ts"),
      "utf8",
    );
    const perNode = src.indexOf("worktreeNodeLockPath(params.root, params.runId, params.blockId)");
    const baseLock = src.indexOf("baseBranchLockPath(root, runId)");
    expect(perNode).toBeGreaterThanOrEqual(0);
    expect(baseLock).toBeGreaterThan(perNode); // per-node acquired first, base nested after
  });

  it("two concurrent accepts on different nodes both complete (no AB/BA deadlock, distinct locks)", async () => {
    const repo = initRepo("wts-concurrent-");
    const mk = (id: string, file: string) => {
      const wt = worktreePath(repo, id, "R");
      createWorktree(repo, wt, worktreeBranchForBlock(id, "R"));
      mkdirSync(join(wt, "src"), { recursive: true });
      writeFileSync(join(wt, "src", file), `export const ${file.replace(/\W/g, "")} = 1;\n`);
      return wt;
    };
    mk("LKA", "a.ts");
    mk("LKB", "b.ts");
    const accept = (id: string) =>
      acceptNodeWorktree({
        root: repo,
        runId: "R",
        blockId: id,
        worktreeRoot: worktreePath(repo, id, "R"),
        scope: { allBlockScopes: [] },
        branch: worktreeBranchForBlock(id, "R"),
        workerOutcome: "success",
        targetedCommands: [],
        writePaths: ["src/"],
        mergedBaseCheckCommand: ["node", "--version"],
      });
    const [a, b] = await Promise.all([accept("LKA"), accept("LKB")]);
    expect(a.merged).toBe(true);
    expect(b.merged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// INV-WTS-3 core — gitCommitIsAncestor is a node-IDENTITY probe (real git).
// ---------------------------------------------------------------------------

describe("INV-WTS-3 — gitCommitIsAncestor distinguishes a landed node from a rolled-back one", () => {
  it("TRUE for a commit reachable from HEAD; FALSE for a divergent (rolled-back) commit", () => {
    const repo = initRepo("wts-ancestor-");
    const landed = headOid(repo);
    // A commit ON HEAD's history is an ancestor (a commit is an ancestor of itself).
    expect(gitCommitIsAncestor(repo, landed)).toBe(true);
    // A divergent commit on a side branch is NOT reachable from HEAD.
    git(repo, "checkout", "-b", "side");
    git(repo, "commit", "--allow-empty", "-m", "divergent");
    const divergent = headOid(repo);
    git(repo, "checkout", "-");
    expect(gitCommitIsAncestor(repo, divergent)).toBe(false);
  });

  it("fail-closed FALSE on a bad / missing object", () => {
    const repo = initRepo("wts-ancestor-bad-");
    expect(gitCommitIsAncestor(repo, "0".repeat(40))).toBe(false);
    expect(gitCommitIsAncestor(repo, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-WTS-3 / INV-WTS-7 foundation — acceptNodeWorktree captures the node's OWN
// commit identity (committedOid) and the landed HEAD (landedHeadOid) as ground
// truth, and captures NO committedOid for a genuine no-change (real git).
// ---------------------------------------------------------------------------

describe("acceptNodeWorktree — captures commit identity (INV-WTS-3/7 ground truth)", () => {
  it("a changed node captures committedOid AND landedHeadOid on a successful merge", async () => {
    const repo = initRepo("wts-capture-");
    const wt = worktreePath(repo, "C1", "R");
    createWorktree(repo, wt, worktreeBranchForBlock("C1", "R"));
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "a.ts"), "export const a = 1;\n");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R",
      blockId: "C1",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("C1", "R"),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      mergedBaseCheckCommand: ["node", "--version"],
    });
    expect(res.merged).toBe(true);
    expect(res.committedOid).toMatch(/^[0-9a-f]{40}$/);
    expect(res.landedHeadOid).toBe(headOid(repo));
    // The landed commit is an ancestor of the new HEAD (identity check passes).
    expect(gitCommitIsAncestor(repo, res.landedHeadOid!)).toBe(true);
  });

  it("a genuine NO-CHANGE node (worker made no edits) captures NO committedOid", async () => {
    const repo = initRepo("wts-nochange-");
    const wt = worktreePath(repo, "NC1", "R");
    createWorktree(repo, wt, worktreeBranchForBlock("NC1", "R"));
    // No file written → nothing to commit.
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R",
      blockId: "NC1",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("NC1", "R"),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: [],
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(false);
    expect(res.committedOid).toBeUndefined();
  });

  it("round-trips committedOid + landedHeadOid through the accept-outcome sidecar", async () => {
    const repo = initRepo("wts-sidecar-");
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    await recordNodeAcceptOutcome(artifactsDir, "R", "CP-BLOCK-N-x", {
      outcome: "success",
      verifyPassed: true,
      merged: true,
      committedOid: "a".repeat(40),
      landedHeadOid: "b".repeat(40),
    });
    const { loadNodeAcceptOutcome } = await import("../../src/remediate/steps/dispatch.js");
    const loaded = await loadNodeAcceptOutcome(artifactsDir, "R", "CP-BLOCK-N-x");
    expect(loaded?.committedOid).toBe("a".repeat(40));
    expect(loaded?.landedHeadOid).toBe("b".repeat(40));
  });
});

// ---------------------------------------------------------------------------
// INV-WTS-3 / INV-WTS-5 / INV-WTS-7 — marshal disposition reconcile (real git).
// ---------------------------------------------------------------------------

const RUN = "PLAN-1";
const BLOCK = "CP-BLOCK-N-x";
const NODE_BRANCH = worktreeBranchForBlock(BLOCK, RUN);

function makeReconState(): RemediationState {
  const finding: Finding = {
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
  const block: RemediationBlock = { block_id: BLOCK, items: [finding.id], parallel_safe: true };
  return {
    status: "implementing",
    plan: {
      plan_id: RUN,
      findings: [finding],
      blocks: [block],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "N-x": {
        finding_id: "N-x",
        status: "pending",
        block_id: BLOCK,
        item_spec: {
          finding_id: "N-x",
          concrete_change: "do x",
          tests_to_write: [{ name: "t", assertions: ["passes"] }],
          not_applicable_steps: [],
        },
      },
    },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

/** Real-git repo + saved state + dispatch-plan + worker result + accept-outcome, then merge. */
async function mergeInRepo(
  repo: string,
  workerStatus: string,
  evidence: string[],
  accept: {
    outcome: "success" | "error" | "rate_limited" | "timeout";
    verifyPassed: boolean;
    merged: boolean;
    committedOid?: string;
    landedHeadOid?: string;
  } | null,
): Promise<RemediationState> {
  const artifactsDir = join(repo, ".audit-tools", "remediation");
  await new StateStore(artifactsDir).saveState(makeReconState());
  const resultDir = join(artifactsDir, "runs", RUN, "implement");
  await mkdir(resultDir, { recursive: true });
  const resultPath = join(resultDir, `implement-${BLOCK}.result.json`);
  await writeFile(
    join(resultDir, "dispatch-plan.json"),
    JSON.stringify({
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: RUN,
      repo_root: repo,
      artifacts_dir: artifactsDir,
      items: [
        {
          task_id: `implement-${BLOCK}`,
          block_id: BLOCK,
          prompt_path: join(resultDir, `implement-${BLOCK}.md`),
          result_path: resultPath,
          access: { read_paths: ["src/x.ts"], write_paths: ["src/x.ts", resultPath] },
        },
      ],
    }),
  );
  await writeFile(
    resultPath,
    JSON.stringify({
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: "N-x", status: workerStatus, evidence }],
    }),
  );
  if (accept) await recordNodeAcceptOutcome(artifactsDir, RUN, BLOCK, accept);
  return mergeImplementResults({ root: repo, artifactsDir }, RUN);
}

describe("INV-WTS-3 — marshal reconciles a resolved node by captured-commit ancestry", () => {
  it("POSITIVE: a merged node whose landed commit IS an ancestor of HEAD stays resolved", async () => {
    const repo = initRepo("wts-recon-ok-");
    const landed = headOid(repo); // reachable from HEAD → ancestor
    const merged = await mergeInRepo(
      repo,
      "resolved",
      ["landed: vitest run -> 3 pass"],
      { outcome: "success", verifyPassed: true, merged: true, committedOid: landed, landedHeadOid: landed },
    );
    expect(merged.items!["N-x"].status).toBe("resolved");
  });

  it("NEGATIVE: merged:true but the landed commit is NOT an ancestor (rolled back) → re-block + quarantine", async () => {
    const repo = initRepo("wts-recon-mismatch-");
    // A divergent commit that is NOT reachable from HEAD — the clobbered landing.
    // Create it, capture its OID, then reset HEAD back so it becomes unreachable
    // (branch-name-agnostic: never relies on the default branch name).
    git(repo, "commit", "--allow-empty", "-m", "divergent");
    const divergent = headOid(repo);
    git(repo, "reset", "--hard", "HEAD~1");
    expect(gitCommitIsAncestor(repo, divergent)).toBe(false); // sanity: truly rolled back
    const merged = await mergeInRepo(
      repo,
      "resolved",
      ["claimed landed"],
      { outcome: "success", verifyPassed: true, merged: true, committedOid: divergent, landedHeadOid: divergent },
    );
    expect(merged.items!["N-x"].status).toBe("blocked");
    expect(merged.items!["N-x"].failure_reason).toMatch(/ancestor|ancestry/i);
    // The clobbered work is preserved under the node's quarantine ref.
    expect(refExists(repo, quarantineRef(RUN, BLOCK))).toBe(true);
  });
});

describe("INV-WTS-7 — resolved_no_change grounded in the captured commit OID (real git)", () => {
  it("POSITIVE: NO captured OID + empty branch → accepted as resolved_no_change", async () => {
    const repo = initRepo("wts-nc-ok-");
    // Node branch exists at HEAD with no commits of its own (empty diff).
    git(repo, "branch", NODE_BRANCH, "HEAD");
    const merged = await mergeInRepo(
      repo,
      "resolved_no_change",
      ["npm run check -> ok (0 errors)"],
      { outcome: "success", verifyPassed: true, merged: false },
    );
    expect(merged.items!["N-x"].status).toBe("resolved_no_change");
  });

  it("NEGATIVE (clobber): captured OID + empty branch → re-block ancestry-mismatch + quarantine", async () => {
    const repo = initRepo("wts-nc-clobber-");
    git(repo, "branch", NODE_BRANCH, "HEAD"); // branch reads empty
    const captured = headOid(repo); // the node HAD committed (captured OID)
    const merged = await mergeInRepo(
      repo,
      "resolved_no_change",
      ["npm run check -> ok"],
      { outcome: "success", verifyPassed: true, merged: false, committedOid: captured },
    );
    expect(merged.items!["N-x"].status).toBe("blocked");
    expect(merged.items!["N-x"].failure_reason).toMatch(/clobber|ancestry|captured commit/i);
    expect(refExists(repo, quarantineRef(RUN, BLOCK))).toBe(true);
  });

  it("NEGATIVE (branch has edits): a worker-claimed no-change whose branch HAS edits → re-block", async () => {
    const repo = initRepo("wts-nc-hasedits-");
    // The node branch actually carries a real edit — the no-change claim is false.
    git(repo, "checkout", "-b", NODE_BRANCH);
    writeFileSync(join(repo, "src.ts"), "export const s = 1;\n");
    git(repo, "add", "src.ts");
    git(repo, "commit", "-m", "real edit");
    git(repo, "checkout", "-");
    const merged = await mergeInRepo(
      repo,
      "resolved_no_change",
      ["npm run check -> ok"],
      { outcome: "success", verifyPassed: true, merged: false },
    );
    expect(merged.items!["N-x"].status).toBe("blocked");
    expect(merged.items!["N-x"].failure_reason).toMatch(/has edits|ground truth/i);
  });
});

// ---------------------------------------------------------------------------
// quarantineCommitByOid — preserves a captured commit with no live branch (real git).
// ---------------------------------------------------------------------------

describe("quarantineCommitByOid — clobber recovery with no live branch", () => {
  it("points the durable quarantine ref straight at a captured OID", () => {
    const repo = initRepo("wts-qbyoid-");
    const oid = headOid(repo);
    const res = quarantineCommitByOid(repo, RUN, BLOCK, oid);
    expect(res?.commit).toBe(oid);
    expect(refExists(repo, quarantineRef(RUN, BLOCK))).toBe(true);
    expect(git(repo, "rev-parse", quarantineRef(RUN, BLOCK)).stdout.trim()).toBe(oid);
  });

  it("returns null for an empty OID (no-op)", () => {
    const repo = initRepo("wts-qbyoid-empty-");
    expect(quarantineCommitByOid(repo, RUN, BLOCK, "")).toBeNull();
  });
});
