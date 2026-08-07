// reverify-node: re-drive a QUARANTINED implement node after its verify-failure
// cause is fixed. Real git worktrees + a full run fixture (dispatch-plan + worker
// result + state.json), so these exercise the whole path: resolve the preserved
// quarantine commit → replay it onto the current HEAD → run the real accept
// verify/scope/merge gate → on green, land + clear the ref + re-finalize the run so
// the node's item flips blocked → resolved. On a still-RED verify nothing lands and
// the ref is preserved for a retry.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import {
  acceptNodeWorktree,
  createWorktree,
  worktreePath,
  worktreeBranchForBlock,
  recordNodeAcceptOutcome,
  quarantineRef,
} from "../../src/remediate/steps/dispatch.js";
import { reverifyQuarantinedNode } from "../../src/remediate/steps/rollingSession.js";
import { StateStore, type RemediationState } from "../../src/remediate/state/store.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";

const RID = "RID-REVERIFY";

function initRepo(): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "reverify-")));
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (git("init").status !== 0) return { repo, ok: false };
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // Trivial cross-platform `check` (node --version, exit 0, no deps) — the derived
  // per-node verify + the merged-base check resolve this script.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "reverify-fixture", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
  );
  git("add", "package.json");
  git("commit", "-m", "base");
  return { repo, ok: true };
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

function headHas(repo: string, path: string): boolean {
  return (
    spawnSync("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "utf8", shell: false }).status === 0
  );
}

/** Write a full run fixture: dispatch-plan + a worker result (finding resolved) + a
 *  state.json whose item is blocked (the failed-to-land starting point). */
async function setupRun(
  repo: string,
  blockId: string,
  findingId: string,
  file: string,
  opts: {
    targetedCommands?: string[];
    /** Extra files in the node's write scope (multi-commit replay fixtures). */
    extraWriteFiles?: string[];
    /** A sibling block IN the dispatch plan that was never dispatched (no result file). */
    siblingNeverDispatched?: { blockId: string; findingId: string; file: string };
  } = {},
): Promise<string> {
  const artifactsDir = join(repo, ".audit-tools", "remediation");
  const resultDir = join(artifactsDir, "runs", RID, "implement");
  mkdirSync(resultDir, { recursive: true });
  const resultPath = join(resultDir, `implement-${blockId}.result.json`);
  const writeFiles = [file, ...(opts.extraWriteFiles ?? [])];
  const sib = opts.siblingNeverDispatched;
  writeFileSync(
    join(resultDir, "dispatch-plan.json"),
    JSON.stringify({
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: RID,
      repo_root: repo,
      artifacts_dir: artifactsDir,
      items: [
        {
          task_id: `implement-${blockId}`,
          block_id: blockId,
          prompt_path: join(resultDir, `implement-${blockId}.md`),
          result_path: resultPath,
          access: { read_paths: writeFiles, write_paths: writeFiles },
        },
        ...(sib
          ? [
              {
                task_id: `implement-${sib.blockId}`,
                block_id: sib.blockId,
                prompt_path: join(resultDir, `implement-${sib.blockId}.md`),
                // Never dispatched: this result file does NOT exist.
                result_path: join(resultDir, `implement-${sib.blockId}.result.json`),
                access: { read_paths: [sib.file], write_paths: [sib.file] },
              },
            ]
          : []),
      ],
    }),
  );
  writeFileSync(
    resultPath,
    JSON.stringify({
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: findingId, status: "resolved", summary: "did it", evidence: ["e"] }],
    }),
  );
  const findingOf = (id: string, path: string) => ({
    id,
    title: "t",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: "s",
    affected_files: [{ path }],
    evidence: ["e"],
  });
  const state = {
    status: "implementing",
    plan: {
      plan_id: RID,
      findings: [
        findingOf(findingId, file),
        ...(sib ? [findingOf(sib.findingId, sib.file)] : []),
      ],
      blocks: [
        {
          block_id: blockId,
          items: [findingId],
          parallel_safe: true,
          touched_files: writeFiles,
          ...(opts.targetedCommands ? { targeted_commands: opts.targetedCommands } : {}),
        },
        ...(sib
          ? [
              {
                block_id: sib.blockId,
                items: [sib.findingId],
                parallel_safe: true,
                touched_files: [sib.file],
              },
            ]
          : []),
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      [findingId]: {
        finding_id: findingId,
        status: "blocked",
        block_id: blockId,
        item_spec: {
          finding_id: findingId,
          concrete_change: "x",
          tests_to_write: [{ name: "t", assertions: ["a"] }],
          not_applicable_steps: [],
        },
      },
      ...(sib
        ? {
            [sib.findingId]: {
              finding_id: sib.findingId,
              status: "pending",
              block_id: sib.blockId,
              item_spec: {
                finding_id: sib.findingId,
                concrete_change: "x",
                tests_to_write: [{ name: "t", assertions: ["a"] }],
                not_applicable_steps: [],
              },
            },
          }
        : {}),
    },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
  await new StateStore(artifactsDir).saveState(state);
  return artifactsDir;
}

/** Drive a node through acceptNodeWorktree with a forced-failing verify so its
 *  committed edit is preserved under a quarantine ref (the not-landed start state). */
async function induceQuarantine(repo: string, artifactsDir: string, blockId: string, file: string): Promise<void> {
  const wt = worktreePath(repo, blockId, RID);
  const branch = worktreeBranchForBlock(blockId, RID);
  createWorktree(repo, wt, branch);
  writeFileSync(join(wt, file), `export const v = "${blockId}";\n`);
  const accept = await acceptNodeWorktree({
    root: repo,
    runId: RID,
    blockId,
    worktreeRoot: wt,
    branch,
    workerOutcome: "success",
    scope: { allBlockScopes: [{ block_id: blockId, write_paths: [file] }] },
    writePaths: [file],
    // A read-only command that always exits non-zero → verify fails → quarantine.
    targetedCommands: ["git rev-parse --verify refs/heads/__nope__"],
  });
  await recordNodeAcceptOutcome(artifactsDir, RID, blockId, accept);
  expect(accept.merged).toBe(false);
}

describe("reverifyQuarantinedNode", () => {
  it("lands a quarantined node once its verify passes, clears the ref, flips the item to resolved", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const blockId = "B-OK";
    const findingId = "F-OK";
    const file = "x.ts";
    const artifactsDir = await setupRun(repo, blockId, findingId, file);
    await induceQuarantine(repo, artifactsDir, blockId, file);

    // Precondition: preserved ref exists, work not on HEAD, item blocked.
    const ref = quarantineRef(RID, blockId);
    expect(refExists(repo, ref)).toBe(true);
    expect(headHas(repo, file)).toBe(false);

    const result = await reverifyQuarantinedNode({ root: repo, artifactsDir }, RID, blockId);

    expect(result.status).toBe("reverified");
    if (result.status !== "reverified") return; // narrow
    expect(result.merged).toBe(true);
    expect(result.verify_passed).toBe(true);
    // Work landed on HEAD; quarantine ref cleared.
    expect(headHas(repo, file)).toBe(true);
    expect(refExists(repo, ref)).toBe(false);
    // Item finalized to resolved (blocked → resolved).
    expect(result.item_statuses).toContainEqual({ finding_id: findingId, status: "resolved" });
    const persisted = await new StateStore(artifactsDir).loadState();
    expect(persisted?.items?.[findingId]?.status).toBe("resolved");
  });

  it("(defect 1) reverify finalizes ONLY its node — a never-dispatched sibling stays pending", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const blockId = "B-SCOPE";
    const findingId = "F-SCOPE";
    const file = "scope.ts";
    const artifactsDir = await setupRun(repo, blockId, findingId, file, {
      siblingNeverDispatched: { blockId: "B-SIB", findingId: "F-SIB", file: "sib.ts" },
    });
    await induceQuarantine(repo, artifactsDir, blockId, file);

    const result = await reverifyQuarantinedNode({ root: repo, artifactsDir }, RID, blockId);
    expect(result.status).toBe("reverified");

    const persisted = await new StateStore(artifactsDir).loadState();
    expect(persisted?.items?.[findingId]?.status).toBe("resolved");
    // Pre-fix, the whole-plan merge swept the never-dispatched sibling through
    // the missing-result branch to blocked (→ triage). It was never this
    // recovery's to touch.
    expect(persisted?.items?.["F-SIB"]?.status).toBe("pending");
  });

  it("(defect 2) replays the FULL multi-commit range, not just the preserved tip", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const blockId = "B-MULTI";
    const findingId = "F-MULTI";
    const artifactsDir = await setupRun(repo, blockId, findingId, "first.ts", {
      extraWriteFiles: ["second.ts"],
    });
    // A node branch with TWO commits; the quarantine ref lands on the tip, whose
    // ancestry carries the first commit.
    const wt = worktreePath(repo, blockId, RID);
    const branch = worktreeBranchForBlock(blockId, RID);
    createWorktree(repo, wt, branch);
    const gitWt = (...args: string[]) =>
      spawnSync("git", args, { cwd: wt, encoding: "utf8", shell: false });
    writeFileSync(join(wt, "first.ts"), `export const first = 1;\n`);
    gitWt("add", "first.ts");
    gitWt("commit", "-m", "commit 1 of 2");
    // Left UNCOMMITTED: acceptNodeWorktree's tool-commit creates commit 2 of 2
    // (the branch tip the quarantine ref preserves, with commit 1 as ancestor).
    writeFileSync(join(wt, "second.ts"), `export const second = 2;\n`);
    const accept = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId,
      worktreeRoot: wt,
      branch,
      workerOutcome: "success",
      scope: { allBlockScopes: [{ block_id: blockId, write_paths: ["first.ts", "second.ts"] }] },
      writePaths: ["first.ts", "second.ts"],
      // Force the verify RED so the two-commit branch is quarantined.
      targetedCommands: ["git rev-parse --verify refs/heads/__nope__"],
    });
    await recordNodeAcceptOutcome(artifactsDir, RID, blockId, accept);
    expect(accept.merged).toBe(false);
    expect(refExists(repo, quarantineRef(RID, blockId))).toBe(true);

    const result = await reverifyQuarantinedNode({ root: repo, artifactsDir }, RID, blockId);
    expect(result.status).toBe("reverified");
    // BOTH commits' changes land — pre-fix the single-tip cherry-pick silently
    // dropped first.ts.
    expect(headHas(repo, "second.ts")).toBe(true);
    expect(headHas(repo, "first.ts")).toBe(true);
  });

  it("returns no_quarantine for a block with no preserved ref", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = await setupRun(repo, "B-NONE", "F-NONE", "y.ts");
    const result = await reverifyQuarantinedNode({ root: repo, artifactsDir }, RID, "B-NONE");
    expect(result.status).toBe("no_quarantine");
  });

  it("preserves the quarantine ref and lands nothing when the re-verify still fails", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const blockId = "B-RED";
    const findingId = "F-RED";
    const file = "z.ts";
    // state carries a node targeted_command that always fails → reverify's verify RED.
    const artifactsDir = await setupRun(repo, blockId, findingId, file, {
      targetedCommands: ["node -e process.exit(1)"],
    });
    await induceQuarantine(repo, artifactsDir, blockId, file);
    const ref = quarantineRef(RID, blockId);

    const result = await reverifyQuarantinedNode({ root: repo, artifactsDir }, RID, blockId);

    expect(result.status).toBe("not_landed");
    if (result.status !== "not_landed") return; // narrow
    expect(result.merged).toBe(false);
    // Nothing landed; the work is re-quarantined under the same ref for a retry.
    expect(headHas(repo, file)).toBe(false);
    expect(refExists(repo, ref)).toBe(true);
  });
});
