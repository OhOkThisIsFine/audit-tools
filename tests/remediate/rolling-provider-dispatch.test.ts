// Rolling-engine live-path wiring made FUNCTIONAL (A8 cutover, step 1). These cover
// the gaps that made the engine unrunnable end-to-end before the cutover work:
//  - G2: the TOOL commits a worker's worktree edits onto its branch, so the branch
//    diff (write-scope ground truth) and `mergeWorktree`'s cherry-pick operate on a
//    real commit rather than an empty diff against HEAD.
//  - G3: a fresh worktree has no node_modules (gitignored); the engine links the
//    main checkout's so per-node verify can run.
//  - G1: the provider-backed per-node dispatcher launches the resolved provider with
//    the node's worktree-rooted prompt and cwd = its worktree, then reads the result.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  createWorktree,
  removeWorktree,
  resetNodeWorktreeAndBranch,
  commitWorktree,
  mergeWorktree,
  ensureWorktreeNodeModules,
  gitEditedFilesForBranch,
  worktreeBranchForBlock,
} from "../../src/remediate/steps/dispatch.js";
import { makeProviderNodeDispatcher } from "../../src/remediate/steps/providerNodeDispatch.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
  ProviderSlot,
} from "audit-tools/shared";
import type { RemediationBlock } from "../../src/remediate/state/types.js";

const SLOT: ProviderSlot = { providerName: "stub", hostModel: null, poolId: "p/0" };

function block(id: string, items: string[]): RemediationBlock {
  return { block_id: id, items, parallel_safe: true, dependencies: [] };
}

function initRepo(): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "roll-pd-")));
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (git("init").status !== 0) return { repo, ok: false };
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "--allow-empty", "-m", "base");
  return { repo, ok: true };
}

// ===========================================================================
// rate_limited re-queue: worktree+branch reuse is idempotent
// ===========================================================================

describe("resetNodeWorktreeAndBranch: idempotent reuse across a re-queue", () => {
  it("lets a second createWorktree on the SAME branch succeed after a reset", () => {
    const { repo, ok } = initRepo();
    if (!ok) return; // git unavailable → skip

    const branch = worktreeBranchForBlock("B1", "RID");
    const wt = join(repo, ".wt-B1");

    // First dispatch attempt: worktree + branch created.
    createWorktree(repo, wt, branch);

    // Simulate the partial prior attempt: the worktree dir is gone but the branch
    // ref remains (what a rate_limited re-queue leaves behind).
    removeWorktree(repo, wt);

    // Without a reset, recreating on the same branch fails ("branch already exists").
    expect(() => createWorktree(repo, wt, branch)).toThrow(/git worktree add failed/);

    // The reset clears the leftover branch (+ prunes admin entries); recreation now
    // starts clean from HEAD.
    resetNodeWorktreeAndBranch(repo, wt, branch);
    expect(() => createWorktree(repo, wt, branch)).not.toThrow();
    expect(existsSync(wt)).toBe(true);
  });
});

// ===========================================================================
// G2: the tool commits the worktree → branch diff + cherry-pick are real
// ===========================================================================

describe("G2: commitWorktree lands the worker's edits", () => {
  it("commits a worktree's edits onto its branch so the branch diff and merge see them", () => {
    const { repo, ok } = initRepo();
    if (!ok) return; // git unavailable → skip

    const branch = worktreeBranchForBlock("B1", "RID");
    const wt = join(repo, ".wt-B1");
    createWorktree(repo, wt, branch);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "ok.ts"), "export const ok = 1;\n");

    const committed = commitWorktree(wt, "remediate B1 (RID)");
    expect(committed.committed).toBe(true);
    expect(committed.error).toBeUndefined();

    // The branch diff (write-scope ground truth) now sees the edit.
    const edited = gitEditedFilesForBranch(repo, branch);
    expect(edited.available).toBe(true);
    if (edited.available) expect(edited.files.has("src/ok.ts")).toBe(true);

    // …and the verified branch cherry-picks onto HEAD.
    const merge = mergeWorktree(repo, wt, branch);
    expect(merge.success).toBe(true);
    const show = spawnSync("git", ["show", "HEAD:src/ok.ts"], {
      cwd: repo,
      encoding: "utf8",
      shell: false,
    });
    expect(show.status).toBe(0);
    expect(show.stdout).toContain("export const ok");
  });

  it("reports committed:false (not an error) when the worker made no tracked edits", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const branch = worktreeBranchForBlock("B2", "RID");
    const wt = join(repo, ".wt-B2");
    createWorktree(repo, wt, branch);
    const committed = commitWorktree(wt, "remediate B2 (RID)");
    expect(committed.committed).toBe(false);
    expect(committed.error).toBeUndefined();
  });
});

// ===========================================================================
// G3: a fresh worktree gets the main checkout's node_modules
// ===========================================================================

describe("G3: ensureWorktreeNodeModules", () => {
  it("links the main checkout's node_modules into a worktree, idempotently", () => {
    const main = mkdtempSync(join(tmpdir(), "roll-nm-main-"));
    const wt = mkdtempSync(join(tmpdir(), "roll-nm-wt-"));
    mkdirSync(join(main, "node_modules"), { recursive: true });
    writeFileSync(join(main, "node_modules", "marker.txt"), "dep\n");

    ensureWorktreeNodeModules(main, wt);
    expect(existsSync(join(wt, "node_modules"))).toBe(true);
    // Resolves to the main checkout's installed deps.
    expect(existsSync(join(wt, "node_modules", "marker.txt"))).toBe(true);

    // Idempotent: a second call is a no-op (existing link is left in place).
    ensureWorktreeNodeModules(main, wt);
    expect(existsSync(join(wt, "node_modules", "marker.txt"))).toBe(true);
  });

  it("is a no-op when the main checkout has no node_modules (no throw)", () => {
    const main = mkdtempSync(join(tmpdir(), "roll-nm-main2-"));
    const wt = mkdtempSync(join(tmpdir(), "roll-nm-wt2-"));
    expect(() => ensureWorktreeNodeModules(main, wt)).not.toThrow();
    expect(existsSync(join(wt, "node_modules"))).toBe(false);
  });
});

// ===========================================================================
// G1: the provider-backed per-node dispatcher (provider IS the worker)
// ===========================================================================

describe("G1: makeProviderNodeDispatcher", () => {
  function dummyResult(findingId: string): string {
    return JSON.stringify({
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: findingId, status: "resolved", evidence: ["ok"] }],
    });
  }

  it("launches the provider with the node's worktree-rooted prompt and cwd=worktree, then reads the result", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "roll-pd-art-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "roll-pd-wt-"));
    const promptPath = join(artifactsDir, "implement-B1.md");
    writeFileSync(promptPath, "# node prompt\n");
    const resultPath = join(artifactsDir, "implement-B1.result.json");

    let captured: LaunchFreshSessionInput | null = null;
    const stub: FreshSessionProvider = {
      name: "stub",
      async launch(input) {
        captured = input;
        await writeFile(input.resultPath, dummyResult("F1"), "utf8");
        return { accepted: true };
      },
    };

    const dispatch = makeProviderNodeDispatcher({
      root: artifactsDir,
      artifactsDir,
      runId: "RID",
      sessionConfig: null,
      promptPathByBlock: new Map([["B1", promptPath]]),
      createProvider: () => stub,
    });

    const res = await dispatch({
      block: block("B1", ["F1"]),
      slot: SLOT,
      worktreeRoot,
      resultPath,
    });

    expect(res.outcome).toBe("success");
    expect(captured).not.toBeNull();
    // The worker is confined to its worktree (cwd = repoRoot in spawnLoggedCommand).
    expect(captured!.repoRoot).toBe(worktreeRoot);
    expect(captured!.promptPath).toBe(promptPath);
    expect(captured!.resultPath).toBe(resultPath);
    // A task.json was written for the provider to read.
    expect(existsSync(join(artifactsDir, "B1.task.json"))).toBe(true);
  });

  it("resolves the provider the SLOT selected (per-pool spill routing), not a fixed config provider", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "roll-pd-slot-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "roll-pd-slot-wt-"));
    const promptPath = join(artifactsDir, "implement-B1.md");
    writeFileSync(promptPath, "# node prompt\n");
    const resultPath = join(artifactsDir, "implement-B1.result.json");

    const requestedNames: (string | undefined)[] = [];
    const dispatch = makeProviderNodeDispatcher({
      root: artifactsDir,
      artifactsDir,
      runId: "RID",
      // The configured provider is claude-code, but the slot selected an
      // openai-compatible pool — the dispatcher must honor the SLOT.
      sessionConfig: { provider: "claude-code" },
      promptPathByBlock: new Map([["B1", promptPath]]),
      createProvider: (name) => {
        requestedNames.push(name);
        return {
          name: name ?? "stub",
          async launch(input) {
            await writeFile(input.resultPath, dummyResult("F1"), "utf8");
            return { accepted: true };
          },
        };
      },
    });

    const res = await dispatch({
      block: block("B1", ["F1"]),
      slot: { providerName: "openai-compatible", hostModel: "vendor/model-x", poolId: "openai-compatible/vendor/model-x" },
      worktreeRoot,
      resultPath,
    });

    expect(res.outcome).toBe("success");
    expect(requestedNames).toEqual(["openai-compatible"]);
  });

  it("returns error when the provider rejects the launch", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "roll-pd-art2-"));
    const promptPath = join(artifactsDir, "p.md");
    writeFileSync(promptPath, "x");
    const stub: FreshSessionProvider = {
      name: "stub",
      async launch() {
        return { accepted: false, error: "provider said no" };
      },
    };
    const dispatch = makeProviderNodeDispatcher({
      root: artifactsDir,
      artifactsDir,
      runId: "RID",
      sessionConfig: null,
      promptPathByBlock: new Map([["B1", promptPath]]),
      createProvider: () => stub,
    });
    const res = await dispatch({
      block: block("B1", ["F1"]),
      slot: SLOT,
      worktreeRoot: artifactsDir,
      resultPath: join(artifactsDir, "r.json"),
    });
    expect(res.outcome).toBe("error");
  });

  it("returns error when the worker writes no result file", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "roll-pd-art3-"));
    const promptPath = join(artifactsDir, "p.md");
    writeFileSync(promptPath, "x");
    const stub: FreshSessionProvider = {
      name: "stub",
      async launch() {
        return { accepted: true }; // accepted but wrote nothing
      },
    };
    const dispatch = makeProviderNodeDispatcher({
      root: artifactsDir,
      artifactsDir,
      runId: "RID",
      sessionConfig: null,
      promptPathByBlock: new Map([["B1", promptPath]]),
      createProvider: () => stub,
    });
    const res = await dispatch({
      block: block("B1", ["F1"]),
      slot: SLOT,
      worktreeRoot: artifactsDir,
      resultPath: join(artifactsDir, "missing.json"),
    });
    expect(res.outcome).toBe("error");
  });

  it("returns error when the node has no dispatch prompt", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "roll-pd-art4-"));
    const stub: FreshSessionProvider = {
      name: "stub",
      async launch() {
        return { accepted: true };
      },
    };
    const dispatch = makeProviderNodeDispatcher({
      root: artifactsDir,
      artifactsDir,
      runId: "RID",
      sessionConfig: null,
      promptPathByBlock: new Map(), // B1 absent
      createProvider: () => stub,
    });
    const res = await dispatch({
      block: block("B1", ["F1"]),
      slot: SLOT,
      worktreeRoot: artifactsDir,
      resultPath: join(artifactsDir, "r.json"),
    });
    expect(res.outcome).toBe("error");
  });
});
