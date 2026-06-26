import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile, withFileLock } from "audit-tools/shared";
// Direct module path (not the barrel) per the A-8/A-10 seam: the registry is the
// SAME mutual-exclusion primitive the in-process driver claims through, so a node
// dispatched by one driver can never be re-dispatched by the other.
import { ClaimRegistry } from "../../shared/quota/claimRegistry.js";
import { StateStore, type RemediationState } from "../state/store.js";
import {
  prepareImplementDispatch,
  createWorktree,
  resetNodeWorktreeAndBranch,
  ensureWorktreeNodeModules,
  seedUntrackedDeclaredPaths,
  declaredPathsFromPlan,
  worktreePath,
  worktreeBranchForBlock,
  acceptNodeWorktree,
  targetedCommandsForBlock,
  recordNodeAcceptOutcome,
  readDispatchPlan,
  blockScopesFromPlan,
  type DispatchOptions,
} from "./dispatch.js";
import type {
  DispatchPlanItem,
  RemediationDispatchPlan,
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
  /**
   * Owner token minted by the shared `ClaimRegistry` for each dispatched node,
   * keyed by block id. Persisted so a later `accept-node` invocation (a separate
   * process) can RELEASE the claim it holds once the node's lifecycle finishes —
   * token-checked, so a driver only ever releases a node it actually claimed.
   * A node a peer driver already holds is never added here (it was not dispatched
   * by this session).
   */
  claims: Record<string, string>;
  /**
   * Block ids a PEER driver (the in-process engine, or a second host loop) already
   * holds a live claim on — observed while JIT-walking the frontier. They are NOT
   * this session's to dispatch or accept; recorded so the walk does not re-probe
   * them every completion AND so they are excluded from this session's completion
   * target (the peer accepts them; `mergeImplementResults` is the run-level
   * finalizer over every driver's accept outcomes). Absent/empty in the common
   * single-driver case, so `total` stays `frontier.length`.
   */
  contested?: string[];
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
/**
 * The file-backed node-claim registry path for a run. Keyed ONLY to the run +
 * artifacts dir — both the host-subagent driver here and the in-process provider
 * driver (`driveRollingImplementDispatch`) derive the identical path, so a claim
 * one driver takes is visible to the other (exactly-one-claimant across both, the
 * cross-driver double-dispatch guard — A-10).
 */
export function nodeClaimRegistryPath(artifactsDir: string, runId: string): string {
  return join(implementDir(artifactsDir, runId), "node-claims.json");
}
/** Build the run's shared claim registry. Single-sourced so both drivers agree. */
export function nodeClaimRegistry(artifactsDir: string, runId: string): ClaimRegistry {
  return new ClaimRegistry(nodeClaimRegistryPath(artifactsDir, runId));
}
/**
 * The run's cross-cycle settled-pool store path (DC-4) — read each cycle by the A-8
 * coordinator's `readSettled` and appended to when a backend (NIM) pool exhausts, so
 * the next cycle excludes it and the work falls to the host-subagent pool.
 */
export function nodeSettledPoolsPath(artifactsDir: string, runId: string): string {
  return join(implementDir(artifactsDir, runId), "hybrid-settled-pools.json");
}
/**
 * The claim pool id for a host-subagent-driven node. The pool axis is diagnostic
 * only in the registry (it is not part of claim identity), so the host-subagent
 * driver records a single stable id; the in-process driver records its provider
 * pool id. Either way the NODE id is the exclusion key, which is what makes the
 * two drivers mutually exclusive on a node.
 */
const HOST_SUBAGENT_CLAIM_POOL = "host-subagent";

/** Remove any stale worktree, then create a fresh isolated one with node_modules linked. */
function createNodeWorktree(
  root: string,
  blockId: string,
  runId: string,
  declaredPaths: string[],
): void {
  const wt = worktreePath(root, blockId, runId);
  const branch = worktreeBranchForBlock(blockId, runId);
  // Fully reset (worktree dir + pruned admin entries + force-deleted branch) so a
  // re-dispatch after a prior blocked/triaged attempt starts clean from HEAD — a
  // bare removeWorktree leaves the branch behind and `git worktree add -b` then
  // fails "branch already exists" (parity with the in-process driver's reset).
  resetNodeWorktreeAndBranch(root, wt, branch);
  createWorktree(root, wt, branch);
  ensureWorktreeNodeModules(root, wt);
  // Bring in declared targets that are untracked/ignored in the main tree — a
  // committed-files-only worktree otherwise can't see them (BUG: a config node
  // couldn't reach its own untracked opencode.json / .gemini/*.toml targets).
  seedUntrackedDeclaredPaths(root, wt, declaredPaths);
}

/**
 * A block's declared target paths (write ∪ read) from the persisted dispatch plan,
 * for worktree seeding. Best-effort: worktree seeding is enrichment, never a
 * correctness gate, so a missing/unreadable plan degrades to no seeding rather than
 * aborting the JIT dispatch (mirrors `computeAcceptScope`).
 */
async function declaredPathsForBlockSafe(
  artifactsDir: string,
  runId: string,
  blockId: string,
): Promise<string[]> {
  try {
    return declaredPathsFromPlan(await readDispatchPlan(artifactsDir, runId, "implement"), blockId);
  } catch {
    return [];
  }
}


/**
 * Accept-time write-scope inputs for `acceptNodeWorktree`: every block's declared
 * scope (from the persisted dispatch plan). The gate adjudicates the node's ACTUAL
 * git edits (ground truth) against these scopes — it never reads a worker
 * self-report. If the plan can't be read (it should always exist for an active
 * rolling session), the gate is skipped rather than enforced against a guessed
 * scope that could falsely block a correct fix.
 */
async function computeAcceptScope(
  artifactsDir: string,
  runId: string,
): Promise<{ allBlockScopes: Array<{ block_id: string; write_paths: string[] }> } | undefined> {
  let allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
  try {
    allBlockScopes = blockScopesFromPlan(await readDispatchPlan(artifactsDir, runId, "implement"));
  } catch {
    return undefined;
  }
  return { allBlockScopes };
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
  // A `resolved_no_change` node legitimately resolved its finding without edits;
  // it flows to `acceptNodeWorktree`'s no-commit branch (the merge adjudicates the
  // no-change claim against its evidence). Only an all-blocked result is an error.
  return result.item_results.some(
    (r) => r.status === "resolved" || r.status === "resolved_no_change",
  )
    ? "success"
    : "error";
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
  hybrid?: {
    /**
     * The dispatch plan the decision point already prepared once for the A-8
     * coordinator split — reused here so the frontier + per-node prompts are not
     * re-derived (and cannot diverge from what the coordinator split over).
     */
    plan: RemediationDispatchPlan;
    /**
     * The coordinator's pre-claimed HOST partition (block_id + the ownerToken the
     * coordinator minted). In hybrid mode this driver runs ONLY these nodes — the
     * in-process partition is run by the orchestrator this cycle — and reuses the
     * coordinator's claims rather than self-claiming (re-claiming would self-collide).
     */
    partition: Array<{ block_id: string; ownerToken: string }>;
  },
): Promise<{
  session: RollingSession;
  initial: Array<RollingFrontierNode & { worktree_root: string }>;
  planPath: string;
  quotaPath: string;
}> {
  const plan =
    hybrid?.plan ??
    (await prepareImplementDispatch(options, runId, undefined, {
      ...waveOptions,
      // Each node runs in its own worktree, so its prompt is rooted there.
      worktreeRootedPrompts: true,
    }));
  // Hybrid: restrict the frontier to the coordinator's host partition + reuse its
  // claims. Standalone: the whole eligible frontier is this driver's to self-claim.
  const partitionIds = hybrid ? new Set(hybrid.partition.map((a) => a.block_id)) : null;
  const preClaimed = hybrid
    ? new Map(hybrid.partition.map((a) => [a.block_id, a.ownerToken]))
    : null;
  const frontier: RollingFrontierNode[] = plan.items
    .filter((i): i is DispatchPlanItem & { block_id: string } => typeof i.block_id === "string")
    .filter((i) => !partitionIds || partitionIds.has(i.block_id))
    .map((i) => ({ block_id: i.block_id, prompt_path: i.prompt_path, result_path: i.result_path }));

  const dir = implementDir(options.artifactsDir, runId);
  const quotaPath = join(dir, "dispatch-quota.json");
  const quota = await readOptionalJsonFile<RemediationDispatchQuota>(quotaPath);
  const slots = Math.max(1, quota?.max_concurrent_agents ?? 1);

  // Pre-create worktrees only for the initial bounded batch (≤ slots); the rest
  // are JIT-created by `accept-node` as nodes complete — so ~slots worktrees
  // exist at any time, never the whole frontier at once. Each node is CLAIMED
  // through the shared registry BEFORE its worktree is created, so a node the
  // in-process driver (or a second host loop) already holds is skipped here
  // rather than double-dispatched (A-10 exactly-one-claimant). The slot freed by
  // a skipped node is filled by walking further into the frontier. In hybrid mode
  // the coordinator already claimed each partition node, so its token is REUSED
  // (never re-claimed — that would self-collide and skip the node).
  const registry = nodeClaimRegistry(options.artifactsDir, runId);
  const initialNodes: RollingFrontierNode[] = [];
  const claims: Record<string, string> = {};
  for (const node of frontier) {
    if (initialNodes.length >= slots) break;
    let token = preClaimed?.get(node.block_id);
    if (!token) {
      const claim = await registry.claim(node.block_id, HOST_SUBAGENT_CLAIM_POOL);
      if (!claim.acquired) continue; // held by another driver — its node to run.
      token = claim.ownerToken;
    }
    // `plan` (above) is the single source of each block's declared scope (write ∪
    // read) — used to seed untracked declared targets into each worktree.
    createNodeWorktree(
      options.root,
      node.block_id,
      runId,
      declaredPathsFromPlan(plan, node.block_id),
    );
    initialNodes.push(node);
    claims[node.block_id] = token;
  }

  const session: RollingSession = {
    run_id: runId,
    slots,
    frontier,
    dispatched: initialNodes.map((n) => n.block_id),
    accepted: [],
    claims,
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

    // Sessions persisted before claim-wiring lack `claims` — default to empty so
    // the read-modify-write is forward-only (never throws on an older session).
    session.claims ??= {};
    const registry = nodeClaimRegistry(opts.artifactsDir, opts.runId);

    if (!session.accepted.includes(opts.blockId)) {
      // State supplies the node's own targeted_commands for the verify (task_7d35176d);
      // verify auto-passes when state is absent (parity with the in-process driver).
      const state = await new StateStore(opts.artifactsDir).loadState();
      const scope = await computeAcceptScope(opts.artifactsDir, opts.runId);
      const accept = await acceptNodeWorktree({
        root: opts.root,
        runId: opts.runId,
        blockId: opts.blockId,
        worktreeRoot: worktreePath(opts.root, opts.blockId, opts.runId),
        branch: worktreeBranchForBlock(opts.blockId, opts.runId),
        workerOutcome: await resultOutcome(node.result_path),
        // targetedCommands omitted → acceptNodeWorktree DERIVES verify from the node's
        // actually-touched tests post-commit (correct paths/runner) AND runs the node's
        // own build-free targeted_commands in addition (task_7d35176d).
        additionalVerifyCommands: state ? targetedCommandsForBlock(state, opts.blockId) : [],
        scope,
        // The block's OWN declared write paths (INV-1 new-file inclusion). Note the
        // base-mutating section is now serialized INSIDE acceptNodeWorktree via the
        // DISTINCT base-branch lock; the outer session lock here still guards the
        // session-state read-modify-write (a different lock path — no double-acquire).
        writePaths: scope?.allBlockScopes.find((b) => b.block_id === opts.blockId)?.write_paths ?? [],
      });
      // Persist the tool-owned verify/merge outcome so finalization (mergeImplementResults)
      // blocks a node that self-reported resolved but never actually landed (OBL-DS-06).
      await recordNodeAcceptOutcome(opts.artifactsDir, opts.runId, opts.blockId, accept);
      session.accepted.push(opts.blockId);
      // Terminal accept outcome → release this node's claim through the SAME
      // registry the in-process driver shares (token-checked, so only the claim we
      // actually hold is dropped). The node is done; freeing its claim lets a stale
      // re-discovery never re-offer it and keeps the registry a true in-flight view.
      const ownerToken = session.claims[opts.blockId];
      if (ownerToken) {
        await registry.release(opts.blockId, ownerToken);
        delete session.claims[opts.blockId];
      }
    }

    session.contested ??= [];

    // JIT-dispatch the next eligible node. Walk the frontier and CLAIM each
    // undispatched, non-contested node through the shared registry BEFORE creating
    // its worktree; a node a peer driver already holds is recorded `contested` (it
    // is theirs to run + accept) and the walk advances — so the two drivers never
    // both pick the same node and the freed slot is not wasted on a contested id
    // (A-10 exactly-one-claimant / coordinator parity).
    let next: RollingFrontierNode | undefined;
    let nextToken: string | undefined;
    for (const candidate of session.frontier) {
      if (
        session.dispatched.includes(candidate.block_id) ||
        session.contested.includes(candidate.block_id)
      ) {
        continue;
      }
      const claim = await registry.claim(candidate.block_id, HOST_SUBAGENT_CLAIM_POOL);
      if (!claim.acquired) {
        session.contested.push(candidate.block_id);
        continue;
      }
      next = candidate;
      nextToken = claim.ownerToken;
      break;
    }

    // This session's completion target is the frontier minus the nodes a peer
    // driver owns. Empty `contested` (the common single-driver case) → the full
    // frontier, so the directive counts are unchanged.
    const ownTotal = session.frontier.length - session.contested.length;
    const inFlight = session.dispatched.length - session.accepted.length;

    if (next && nextToken) {
      createNodeWorktree(
        opts.root,
        next.block_id,
        opts.runId,
        await declaredPathsForBlockSafe(opts.artifactsDir, opts.runId, next.block_id),
      );
      session.dispatched.push(next.block_id);
      session.claims[next.block_id] = nextToken;
      await writeJsonFile(sessionPath(opts.artifactsDir, opts.runId), session);
      return {
        kind: "dispatch",
        node: next,
        worktree_root: worktreePath(opts.root, next.block_id, opts.runId),
        in_flight: session.dispatched.length - session.accepted.length,
        accepted: session.accepted.length,
        total: ownTotal,
      };
    }

    await writeJsonFile(sessionPath(opts.artifactsDir, opts.runId), session);
    // Done when every node this session is responsible for has been accepted AND
    // nothing is still in flight — a contested node held by a peer driver does not
    // keep this session waiting forever (the peer accepts it; the run-level
    // `mergeImplementResults` is the finalizer over both drivers' outcomes).
    if (session.accepted.length >= ownTotal && inFlight <= 0) {
      return { kind: "done", accepted: session.accepted.length, total: ownTotal };
    }
    return {
      kind: "wait",
      in_flight: inFlight,
      accepted: session.accepted.length,
      total: ownTotal,
    };
  });
}
