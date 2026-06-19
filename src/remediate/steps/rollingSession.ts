import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile, withFileLock } from "audit-tools/shared";
import { StateStore, type RemediationState } from "../state/store.js";
import {
  prepareImplementDispatch,
  createWorktree,
  resetNodeWorktreeAndBranch,
  ensureWorktreeNodeModules,
  worktreePath,
  worktreeBranchForBlock,
  acceptNodeWorktree,
  recordNodeAcceptOutcome,
  type DispatchOptions,
} from "./dispatch.js";
import type {
  DispatchPlanItem,
  RemediationDispatchQuota,
  ImplementWorkerResult,
} from "./types.js";

/**
 * Host-subagent rolling driver (A8). One shared rolling core
 * (`acceptNodeWorktree`) driven by host-spawned subagents via a per-completion
 * `accept-node` callback — the conversation-first co-equal of the in-process
 * provider engine (`driveRollingImplementDispatch`). The tool owns ALL the
 * rolling bookkeeping (eligibility, bounded JIT worktree creation, the
 * commit/verify/merge lifecycle, write-scope); the host only spawns a subagent
 * per node and relays `accept-node` on each completion.
 *
 * Scope: one eligible frontier per next-step cycle (every node here has its deps
 * already verified-complete, so they are mutually independent). Cross-level
 * progression rides the existing merge-implement-results -> next-step cadence
 * (the next frontier is planned after this one merges). Within the frontier this
 * is FULL rolling: ~`slots` worktrees live at once, and each completion JIT
 * dispatches the next undispatched node.
 *
 * Isolation is per-node-worktree (hard between nodes). Binding a host subagent to
 * its worktree is SOFT (the orchestrator cannot cwd-confine the host's subagent),
 * enforced by detection: a worktree-rooted prompt + the branch-diff write-scope
 * gate at merge ⇒ a strayed subagent's node simply fails to land, never silent
 * corruption of the main tree.
 */

export interface RollingFrontierNode {
  block_id: string;
  prompt_path: string;
  result_path: string;
}

export interface RollingSession {
  run_id: string;
  /** Concurrency target N (from the quota scheduler), not a wave cap. */
  slots: number;
  /** Every eligible node in this frontier. */
  frontier: RollingFrontierNode[];
  /** Block ids whose worktree was created + handed to the host. */
  dispatched: string[];
  /** Block ids whose `acceptNodeWorktree` lifecycle has run. */
  accepted: string[];
}

export type RollingDirective =
  | {
      kind: "dispatch";
      node: RollingFrontierNode;
      worktree_root: string;
      in_flight: number;
      accepted: number;
      total: number;
    }
  | { kind: "wait"; in_flight: number; accepted: number; total: number }
  | { kind: "done"; accepted: number; total: number };

function implementDir(artifactsDir: string, runId: string): string {
  return join(artifactsDir, "runs", runId, "implement");
}
function sessionPath(artifactsDir: string, runId: string): string {
  return join(implementDir(artifactsDir, runId), "rolling-session.json");
}
function sessionLockPath(artifactsDir: string, runId: string): string {
  return join(implementDir(artifactsDir, runId), "rolling-session.lock");
}

/** Remove any stale worktree, then create a fresh isolated one with node_modules linked. */
function createNodeWorktree(root: string, blockId: string, runId: string): void {
  const wt = worktreePath(root, blockId, runId);
  const branch = worktreeBranchForBlock(blockId, runId);
  // Fully reset (worktree dir + pruned admin entries + force-deleted branch) so a
  // re-dispatch after a prior blocked/triaged attempt starts clean from HEAD — a
  // bare removeWorktree leaves the branch behind and `git worktree add -b` then
  // fails "branch already exists" (parity with the in-process driver's reset).
  resetNodeWorktreeAndBranch(root, wt, branch);
  createWorktree(root, wt, branch);
  ensureWorktreeNodeModules(root, wt);
}

/** Targeted verify commands for a block (deduped), from its findings. */
function computeTargeted(state: RemediationState | null, blockId: string): string[] {
  const block = state?.plan?.blocks.find((b) => b.block_id === blockId);
  if (!block) return [];
  const cmds = block.items.flatMap((id) => {
    const finding = state?.plan?.findings.find((f) => f.id === id);
    return finding?.targeted_commands ?? [];
  });
  return [...new Set(cmds.filter((c) => typeof c === "string" && c.length > 0))];
}

/**
 * Map a finished subagent's result file to a worker transport outcome. A node
 * with no result, an unparseable result, or one that resolved nothing (all
 * blocked) is treated as "error" so `acceptNodeWorktree` drops its worktree
 * rather than landing speculative edits; the merge then routes it to triage.
 */
async function resultOutcome(resultPath: string): Promise<"success" | "error"> {
  const result = await readOptionalJsonFile<ImplementWorkerResult>(resultPath);
  if (!result || !Array.isArray(result.item_results)) return "error";
  return result.item_results.some((r) => r.status === "resolved") ? "success" : "error";
}

/**
 * Prepare the host-subagent rolling dispatch for the current eligible frontier:
 * write the worktree-rooted dispatch plan + quota, pre-create up to `slots`
 * worktrees, and persist the rolling session. Returns the initial nodes for the
 * host to spawn plus the artifact paths.
 */
export async function prepareHostRollingDispatch(
  options: DispatchOptions,
  runId: string,
  waveOptions: NonNullable<Parameters<typeof prepareImplementDispatch>[3]>,
): Promise<{
  session: RollingSession;
  initial: Array<RollingFrontierNode & { worktree_root: string }>;
  planPath: string;
  quotaPath: string;
}> {
  const plan = await prepareImplementDispatch(options, runId, undefined, {
    ...waveOptions,
    // Each node runs in its own worktree, so its prompt is rooted there.
    worktreeRootedPrompts: true,
  });
  const frontier: RollingFrontierNode[] = plan.items
    .filter((i): i is DispatchPlanItem & { block_id: string } => typeof i.block_id === "string")
    .map((i) => ({ block_id: i.block_id, prompt_path: i.prompt_path, result_path: i.result_path }));

  const dir = implementDir(options.artifactsDir, runId);
  const quotaPath = join(dir, "dispatch-quota.json");
  const quota = await readOptionalJsonFile<RemediationDispatchQuota>(quotaPath);
  const slots = Math.max(1, quota?.max_concurrent_agents ?? 1);

  // Pre-create worktrees only for the initial bounded batch (≤ slots); the rest
  // are JIT-created by `accept-node` as nodes complete — so ~slots worktrees
  // exist at any time, never the whole frontier at once.
  const initialNodes = frontier.slice(0, Math.min(slots, frontier.length));
  for (const node of initialNodes) {
    createNodeWorktree(options.root, node.block_id, runId);
  }

  const session: RollingSession = {
    run_id: runId,
    slots,
    frontier,
    dispatched: initialNodes.map((n) => n.block_id),
    accepted: [],
  };
  await writeJsonFile(sessionPath(options.artifactsDir, runId), session);

  return {
    session,
    initial: initialNodes.map((n) => ({
      ...n,
      worktree_root: worktreePath(options.root, n.block_id, runId),
    })),
    planPath: join(dir, "dispatch-plan.json"),
    quotaPath,
  };
}

/**
 * The `accept-node` per-completion callback. Runs the shared accept lifecycle for
 * the finished node, then JIT-dispatches the next undispatched frontier node (if
 * any). Lock-guarded so concurrent completions don't race the session's
 * read-modify-write (which would double-dispatch or lose an acceptance).
 * Idempotent on a re-run for the same node (skips the lifecycle if already accepted).
 */
export async function advanceHostRolling(opts: {
  root: string;
  artifactsDir: string;
  runId: string;
  blockId: string;
}): Promise<RollingDirective> {
  return withFileLock(sessionLockPath(opts.artifactsDir, opts.runId), async () => {
    const session = await readOptionalJsonFile<RollingSession>(
      sessionPath(opts.artifactsDir, opts.runId),
    );
    if (!session) {
      throw new Error(`No rolling session found for run ${opts.runId}`);
    }
    const node = session.frontier.find((n) => n.block_id === opts.blockId);
    if (!node) {
      throw new Error(
        `Block ${opts.blockId} is not in the rolling frontier for run ${opts.runId}`,
      );
    }

    if (!session.accepted.includes(opts.blockId)) {
      const state = await new StateStore(opts.artifactsDir).loadState();
      const accept = acceptNodeWorktree({
        root: opts.root,
        runId: opts.runId,
        blockId: opts.blockId,
        worktreeRoot: worktreePath(opts.root, opts.blockId, opts.runId),
        branch: worktreeBranchForBlock(opts.blockId, opts.runId),
        workerOutcome: await resultOutcome(node.result_path),
        targetedCommands: computeTargeted(state, opts.blockId),
      });
      // Persist the tool-owned verify/merge outcome so finalization (mergeImplementResults)
      // blocks a node that self-reported resolved but never actually landed (OBL-DS-06).
      await recordNodeAcceptOutcome(opts.artifactsDir, opts.runId, opts.blockId, accept);
      session.accepted.push(opts.blockId);
    }

    const next = session.frontier.find((n) => !session.dispatched.includes(n.block_id));
    if (next) {
      createNodeWorktree(opts.root, next.block_id, opts.runId);
      session.dispatched.push(next.block_id);
      await writeJsonFile(sessionPath(opts.artifactsDir, opts.runId), session);
      return {
        kind: "dispatch",
        node: next,
        worktree_root: worktreePath(opts.root, next.block_id, opts.runId),
        in_flight: session.dispatched.length - session.accepted.length,
        accepted: session.accepted.length,
        total: session.frontier.length,
      };
    }

    await writeJsonFile(sessionPath(opts.artifactsDir, opts.runId), session);
    if (session.accepted.length >= session.frontier.length) {
      return { kind: "done", accepted: session.accepted.length, total: session.frontier.length };
    }
    return {
      kind: "wait",
      in_flight: session.dispatched.length - session.accepted.length,
      accepted: session.accepted.length,
      total: session.frontier.length,
    };
  });
}
