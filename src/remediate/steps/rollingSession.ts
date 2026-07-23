import { join } from "node:path";
import { existsSync } from "node:fs";
import { readOptionalJsonFile, writeJsonFile, withFileLock, spawnSyncHidden, detectHostDispatchWall, type HostDispatchWall } from "audit-tools/shared";
// Direct module path (not the barrel) per the A-8/A-10 seam: the registry is the
// SAME mutual-exclusion primitive the in-process driver claims through, so a node
// dispatched by one driver can never be re-dispatched by the other.
import { ClaimRegistry } from "../../shared/quota/claimRegistry.js";
import { StateStore, type RemediationState } from "../state/store.js";
import {
  prepareImplementDispatch,
  createWorktree,
  resetNodeWorktreeAndBranch,
  seedUntrackedDeclaredPaths,
  declaredPathsFromPlan,
  worktreePath,
  worktreeBranchForBlock,
  acceptNodeWorktree,
  targetedCommandsForBlock,
  recordNodeAcceptOutcome,
  readDispatchPlan,
  blockScopesFromPlan,
  quarantineRef,
  mergeImplementResults,
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
 * Scope: one GRANTED SET per next-step cycle. The dispatch-quota admission block
 * (`admission.granted_packet_ids`) is the set the tool admitted against the live
 * budget this step; the host dispatches EXACTLY it (its size is the emergent
 * admission width — no computed concurrency number). Every node here has its deps
 * already verified-complete, so they are mutually independent. Worktrees are created
 * for the WHOLE granted set upfront (worktrees == granted set); when the set is
 * accepted, `merge-implement-results -> next-step` re-plans and RE-GRANTS the pending
 * remainder until the plan is exhausted. There is no per-completion JIT refill —
 * re-admission happens at the next-step boundary, gated by the live budget.
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
  /**
   * The GRANTED SET this step — the nodes the admission loop admitted against the live
   * budget (`admission.granted_packet_ids` ∩ eligible frontier). Worktrees are created
   * for the whole set upfront; the pending remainder is re-granted at the next next-step.
   */
  frontier: RollingFrontierNode[];
  /** Block ids whose worktree was created + handed to the host (the whole granted set). */
  dispatched: string[];
  /** Block ids whose `acceptNodeWorktree` lifecycle ran and LANDED (outcome success). */
  accepted: string[];
  /**
   * Block ids whose `acceptNodeWorktree` lifecycle ran and FAILED (outcome ≠ success).
   * Terminal for this session's counts but never latched into `accepted`: the node's
   * committed work is preserved under its quarantine ref and the designed recovery is
   * a `reverify-node` re-drive. A re-run `accept-node` for such a node reports the
   * recorded failure instead of re-running the lifecycle — and instead of silently
   * reading as accepted, which made retries idempotent no-ops and forced hand-landing
   * from the quarantine ref (dogfood 2026-07-23, accept-latch defect). Optional:
   * sessions persisted before this field default to empty.
   */
  accept_failed?: string[];
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
   * single-driver case, so `total` stays `frontier.length`. Invariant:
   * `dispatched ∩ contested = ∅` — a contested node is never dispatched by this
   * session (the completion math relies on this: `accepted`/`accept_failed` are
   * subsets of `dispatched`, so `in_flight` can never go negative).
   */
  contested?: string[];
}

export type RollingDirective =
  | { kind: "wait"; in_flight: number; accepted: number; accept_failed: string[]; total: number }
  | { kind: "done"; accepted: number; accept_failed: string[]; total: number };

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

/**
 * True when the node's existing worktree holds UN-LANDED work: uncommitted
 * edits, or commits on its branch that accept-node has not yet merged. A
 * re-prepare (retry, session rebuild, concurrent driver) must NEVER destroy
 * such a worktree — the 2026-07-22 dogfood resume lost a completed worker's
 * entire uncommitted output when a triage-retry re-prepare reset the worktree
 * it was documented to preserve.
 */
export function worktreeHoldsUnlandedWork(wt: string, root: string): boolean {
  if (!existsSync(wt)) return false;
  const status = spawnSyncHidden("git", ["status", "--porcelain"], {
    cwd: wt,
    encoding: "utf8",
    shell: false,
  });
  if (!status.error && status.status === 0 && (status.stdout ?? "").trim().length > 0) {
    return true;
  }
  // Commits ahead of the primary tree's HEAD: worker output that accept-node has
  // not merged. Landing cherry-picks (new shas), so a landed node's worktree can
  // still read as "ahead" — that over-match is the SAFE direction (a loud reuse
  // of a stale worktree is recoverable; resetting an un-landed one destroys
  // work). The deliberate post-quarantine reset path clears failed attempts.
  const rootHead = spawnSyncHidden("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  const base = (rootHead.stdout ?? "").trim();
  if (rootHead.error || rootHead.status !== 0 || base.length === 0) {
    // Cannot establish the base — fail SAFE (treat as un-landed; never reset).
    return true;
  }
  const ahead = spawnSyncHidden("git", ["rev-list", "--count", "HEAD", `^${base}`], {
    cwd: wt,
    encoding: "utf8",
    shell: false,
  });
  if (!ahead.error && ahead.status === 0) {
    const n = Number.parseInt((ahead.stdout ?? "0").trim(), 10);
    if (Number.isFinite(n) && n > 0) return true;
  }
  return false;
}

/**
 * Remove any stale worktree, then create a fresh isolated one with node_modules
 * linked — UNLESS the existing worktree holds un-landed work (uncommitted edits
 * or unaccepted commits), in which case it is REUSED as-is: resetting it would
 * silently destroy a completed worker's output on the retry / session-rebuild
 * path (the "preserved worktree" contract Piece D promises). Reuse also skips
 * untracked-target seeding — the seed copies main-tree versions over paths the
 * worker may have edited.
 */
function createNodeWorktree(
  root: string,
  blockId: string,
  runId: string,
  declaredPaths: string[],
): void {
  const wt = worktreePath(root, blockId, runId);
  const branch = worktreeBranchForBlock(blockId, runId);
  if (worktreeHoldsUnlandedWork(wt, root)) {
    process.stderr.write(
      `[remediate-code] rolling: reusing existing worktree for ${blockId} — it holds ` +
        `un-landed work (uncommitted edits or unaccepted commits); a reset here would destroy it.\n`,
    );
    return;
  }
  // Fully reset (worktree dir + pruned admin entries + force-deleted branch) so a
  // re-dispatch after a prior blocked/triaged attempt starts clean from HEAD — a
  // bare removeWorktree leaves the branch behind and `git worktree add -b` then
  // fails "branch already exists" (parity with the in-process driver's reset).
  resetNodeWorktreeAndBranch(root, wt, branch);
  createWorktree(root, wt, branch); // also links main node_modules (folded in)
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
 * rolling session), the gate still runs against an EMPTY registry rather than being
 * skipped: an empty registry owns nothing, so every edit is unowned-and-granted (no
 * false block from a guessed scope) while the git-probe fail-closed path still fires.
 * The gate is therefore unconditional — never skipped on host/state discretion (E1).
 */
async function computeAcceptScope(
  artifactsDir: string,
  runId: string,
): Promise<{ allBlockScopes: Array<{ block_id: string; write_paths: string[] }> }> {
  let allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
  try {
    allBlockScopes = blockScopesFromPlan(await readDispatchPlan(artifactsDir, runId, "implement"));
  } catch {
    allBlockScopes = [];
  }
  return { allBlockScopes };
}

/**
 * Map a finished subagent's result file to a worker transport outcome. A node
 * with no result, an unparseable result, or one that resolved nothing (all
 * blocked) is treated as "error" so `acceptNodeWorktree` drops its worktree
 * rather than landing speculative edits; the merge then routes it to triage.
 */
async function resultOutcome(
  resultPath: string,
): Promise<{ outcome: "success" | "error"; claimsEdit: boolean }> {
  const result = await readOptionalJsonFile<ImplementWorkerResult>(resultPath);
  if (!result || !Array.isArray(result.item_results)) {
    return { outcome: "error", claimsEdit: false };
  }
  // A `resolved_no_change` node legitimately resolved its finding without edits;
  // it flows to `acceptNodeWorktree`'s no-commit branch (the merge adjudicates the
  // no-change claim against its evidence). Only an all-blocked result is an error.
  const outcome = result.item_results.some(
    (r) => r.status === "resolved" || r.status === "resolved_no_change",
  )
    ? "success"
    : "error";
  // `claimsEdit`: the node's OWN result claims a REAL edit (status "resolved", never
  // "resolved_no_change") — the stray-worktree guard's trigger condition
  // (`acceptNodeWorktree`'s `nodeClaimsEdit` param).
  const claimsEdit = result.item_results.some((r) => r.status === "resolved");
  return { outcome, claimsEdit };
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
  /**
   * Set ONLY when admission hit the host-dispatch cooldown wall (Increment B residual
   * a): the granted set was over-granted during an active cooldown, so this driver
   * would otherwise fan the throttled set out. Returned BEFORE any node is claimed or
   * worktree'd (a claim held across the ensuing pause reads `contested` on resume). The
   * caller reconciles the reserved leases and records the resumable `quota_paused`
   * terminal; `session`/`initial` are empty in this case.
   */
  wall?: { detected: HostDispatchWall; strandedBlockIds: string[] };
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
  const dir = implementDir(options.artifactsDir, runId);
  const quotaPath = join(dir, "dispatch-quota.json");
  const quota = await readOptionalJsonFile<RemediationDispatchQuota>(quotaPath);
  // The admission block is the tool-owned budget gate: dispatch EXACTLY the granted
  // set this step. A missing/empty admission (older state, or a degrade) grants
  // nothing — the frontier folds to zero and the run re-grants on the next next-step.
  const grantedIds = new Set(quota?.admission?.granted_packet_ids ?? []);

  // Increment B residual (a): the host-subagent driver fans out the granted set
  // BLINDLY — unlike the in-process rolling engine it is NOT paced by `scheduleWave`,
  // so an F1 cooldown over-grant (admission maps a null budget → the whole frontier)
  // would fan the throttled set out. Detect the wall HERE — after admission, BEFORE any
  // node is claimed or worktree'd — because a claim held across the ensuing pause reads
  // `contested` on resume and strands the node. The caller turns `wall` into the
  // resumable `quota_paused` terminal.
  //
  // Gate on a NON-EMPTY granted host partition, not just the cooldown flag:
  // `detectHostDispatchWall` gives cooldown precedence over empty-grant, so a cooldown
  // pass whose eligible frontier is empty (nothing granted, or the whole grant went to
  // the in-process partition) has nothing to fan out — it must flow to the caller's
  // empty-frontier merge fold (parity with the reference `dispatch_implement` path,
  // whose merge fold precedes its wall), never pause a run whose real blocker is an
  // un-merged upstream until the cooldown reset.
  const cooldownWall = detectHostDispatchWall({
    grantedCount: grantedIds.size,
    cooldownUntil: quota?.cooldown_until ?? null,
    now: Date.now(),
  });
  const strandedBlockIds = plan.items
    .filter((i): i is DispatchPlanItem & { block_id: string } => typeof i.block_id === "string")
    .filter((i) => !partitionIds || partitionIds.has(i.block_id))
    .filter((i) => grantedIds.has(i.block_id))
    .map((i) => i.block_id);
  if (cooldownWall.atWall && cooldownWall.reason === "cooldown" && strandedBlockIds.length > 0) {
    return {
      session: { run_id: runId, frontier: [], dispatched: [], accepted: [], accept_failed: [], claims: {}, contested: [] },
      initial: [],
      planPath: join(dir, "dispatch-plan.json"),
      quotaPath,
      wall: { detected: cooldownWall, strandedBlockIds },
    };
  }

  const frontier: RollingFrontierNode[] = plan.items
    .filter((i): i is DispatchPlanItem & { block_id: string } => typeof i.block_id === "string")
    .filter((i) => !partitionIds || partitionIds.has(i.block_id))
    // Admission gate: only the granted subset of the eligible frontier runs this step.
    .filter((i) => grantedIds.has(i.block_id))
    .map((i) => ({ block_id: i.block_id, prompt_path: i.prompt_path, result_path: i.result_path }));

  // Create a worktree for the WHOLE granted set upfront (worktrees == granted set):
  // admission already bounded the set to what the live budget + any declared in-flight
  // cap allow, so there is no per-completion JIT refill — the pending remainder is
  // re-granted at the next next-step. Each node is CLAIMED through the shared registry
  // BEFORE its worktree is created, so a node the in-process driver (or a second host
  // loop) already holds is recorded `contested` (its owner runs + accepts it) rather
  // than double-dispatched (A-10 exactly-one-claimant). In hybrid mode the coordinator
  // already claimed each partition node, so its token is REUSED (never re-claimed —
  // that would self-collide and skip the node).
  const registry = nodeClaimRegistry(options.artifactsDir, runId);
  const initialNodes: RollingFrontierNode[] = [];
  const claims: Record<string, string> = {};
  const contested: string[] = [];
  for (const node of frontier) {
    let token = preClaimed?.get(node.block_id);
    if (!token) {
      const claim = await registry.claim(node.block_id, HOST_SUBAGENT_CLAIM_POOL);
      if (!claim.acquired) {
        contested.push(node.block_id); // held by another driver — its node to run + accept.
        continue;
      }
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
    frontier,
    dispatched: initialNodes.map((n) => n.block_id),
    accepted: [],
    accept_failed: [],
    claims,
    contested,
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
 * Idempotent on a re-run for the same node (skips the lifecycle if the node already
 * reached a terminal accept — accepted OR accept_failed; a failed node's re-run
 * surfaces the recorded failure in the directive rather than re-running or silently
 * reading as accepted).
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
    // Local const so the array stays narrowed across the awaits below.
    const acceptFailed = (session.accept_failed ??= []);
    const registry = nodeClaimRegistry(opts.artifactsDir, opts.runId);

    if (
      !session.accepted.includes(opts.blockId) &&
      !acceptFailed.includes(opts.blockId)
    ) {
      // Contested-node fail-closed guard (OD3 layer 2, D-66/67 slice-1 §5b):
      // `prepareHostRollingDispatch` never writes `session.claims[block_id]` for a
      // CONTESTED node (a peer driver already holds its live claim) — this session
      // was never handed a worktree/prompt for it. An accept-node call for such a
      // blockId (a stray/duplicate host request) must NEVER silently proceed without
      // an ownership param — that would ungate exactly the peer-owned case the gate
      // exists for. Refuse loudly ONLY on that genuinely-contested case. A merely
      // ABSENT token on a non-contested block is the legacy claims-less session
      // (persisted before claim-wiring — the `??= {}` above exists precisely so
      // those never throw): accept it UNGATED, the pre-slice behaviour.
      if (session.contested?.includes(opts.blockId)) {
        throw new Error(
          `Block ${opts.blockId} is contested in run ${opts.runId}'s rolling session ` +
            `(a peer driver holds its live claim; this session never dispatched it) — ` +
            `refusing to accept without a verifiable ownership lease.`,
        );
      }
      const ownerToken = session.claims[opts.blockId];
      // State supplies the node's own targeted_commands for the verify (task_7d35176d);
      // verify auto-passes when state is absent (parity with the in-process driver).
      const state = await new StateStore(opts.artifactsDir).loadState();
      const scope = await computeAcceptScope(opts.artifactsDir, opts.runId);
      const { outcome: workerOutcome, claimsEdit } = await resultOutcome(node.result_path);
      const accept = await acceptNodeWorktree({
        root: opts.root,
        runId: opts.runId,
        blockId: opts.blockId,
        worktreeRoot: worktreePath(opts.root, opts.blockId, opts.runId),
        branch: worktreeBranchForBlock(opts.blockId, opts.runId),
        workerOutcome,
        // targetedCommands omitted → acceptNodeWorktree DERIVES verify from the node's
        // actually-touched tests post-commit (correct paths/runner) AND runs the node's
        // own build-free targeted_commands in addition (task_7d35176d).
        additionalVerifyCommands: state ? targetedCommandsForBlock(state, opts.blockId) : [],
        scope,
        // The block's OWN declared write paths (INV-1 new-file inclusion). Note the
        // base-mutating section is now serialized INSIDE acceptNodeWorktree via the
        // DISTINCT base-branch lock; the outer session lock here still guards the
        // session-state read-modify-write (a different lock path — no double-acquire).
        writePaths: scope.allBlockScopes.find((b) => b.block_id === opts.blockId)?.write_paths ?? [],
        // Stray-worktree guard trigger (see acceptNode.ts): true only when the node's
        // OWN result claims a real ("resolved") edit.
        nodeClaimsEdit: claimsEdit,
        // Merge-time ownership gate (OD3 layer 2): heartbeat the SAME lease this
        // session claimed the node under, immediately before the cherry-pick.
        // Omitted for a legacy claims-less session (no token → no gate, pre-slice
        // behaviour); the genuinely-contested case already threw above.
        ...(ownerToken
          ? { ownership: { registry, nodeId: opts.blockId, ownerToken } }
          : {}),
      });
      // Persist the tool-owned verify/merge outcome so finalization (mergeImplementResults)
      // blocks a node that self-reported resolved but never actually landed (OBL-DS-06).
      // Persisted BEFORE the stray-worktree throw below so triage has the diagnostic on
      // disk even though this accept-node call itself rejects.
      await recordNodeAcceptOutcome(opts.artifactsDir, opts.runId, opts.blockId, accept);
      if (accept.strayWorktreeSuspected) {
        throw new Error(
          accept.diagnostic ??
            `node ${opts.blockId}: stray worktree suspected — its result claims a ` +
              `resolved edit but the designated worktree has no commits beyond base.`,
        );
      }
      if (accept.outcome === "success") {
        session.accepted.push(opts.blockId);
      } else {
        // A FAILED accept must never latch as accepted (dogfood 2026-07-23): the
        // node's committed work is quarantined and the designed recovery is a
        // `reverify-node` re-drive. Record it terminal-with-signal so the directive
        // surfaces it, while a re-run accept-node reports instead of re-running.
        acceptFailed.push(opts.blockId);
      }
      // Terminal accept outcome → release this node's claim through the SAME
      // registry the in-process driver shares (token-checked, so only the claim we
      // actually hold is dropped). The node is done; freeing its claim lets a stale
      // re-discovery never re-offer it and keeps the registry a true in-flight view.
      // A legacy claims-less session has no token → nothing to release.
      if (ownerToken) {
        await registry.release(opts.blockId, ownerToken);
        delete session.claims[opts.blockId];
      }
    }

    session.contested ??= [];

    // No per-completion JIT refill: the whole granted set already has worktrees
    // (worktrees == granted set — admission bounded it to the live budget at grant
    // time). The pending remainder is re-granted at the NEXT next-step. So each
    // `accept-node` only runs the finished node's lifecycle, then reports wait/done.
    // This session's completion target is the granted set minus the nodes a peer
    // driver owns. Empty `contested` (the common single-driver case) → the full
    // granted set, so the counts are unchanged.
    const ownTotal = session.frontier.length - session.contested.length;
    // Both accept outcomes are terminal for THIS session's completion math — a
    // failed node is no longer in flight (its recovery runs out-of-band via
    // `reverify-node`), so it must not hold the directive at `wait` forever.
    const terminal = session.accepted.length + acceptFailed.length;
    const inFlight = session.dispatched.length - terminal;

    await writeJsonFile(sessionPath(opts.artifactsDir, opts.runId), session);
    // Done when every node this session is responsible for has been accepted AND
    // nothing is still in flight — a contested node held by a peer driver does not
    // keep this session waiting forever (the peer accepts it; the run-level
    // `mergeImplementResults` is the finalizer over both drivers' outcomes, and it
    // reconciles the grant's reservation-ledger leases so budget frees for the next
    // grant).
    if (terminal >= ownTotal && inFlight <= 0) {
      return {
        kind: "done",
        accepted: session.accepted.length,
        accept_failed: [...acceptFailed],
        total: ownTotal,
      };
    }
    return {
      kind: "wait",
      in_flight: inFlight,
      accepted: session.accepted.length,
      accept_failed: [...acceptFailed],
      total: ownTotal,
    };
  });
}

/** Outcome of a {@link reverifyQuarantinedNode} re-drive. */
export type ReverifyNodeResult =
  | {
      /** No quarantine ref for this (run, block) — wrong id, or already cleared by a prior land. */
      status: "no_quarantine";
      block_id: string;
      ref: string;
    }
  | {
      /** The preserved commit no longer applies onto the current remediation HEAD (a sibling
       *  edited the same lines since quarantine) — nothing landed, ref preserved for retry. */
      status: "conflict";
      block_id: string;
      ref: string;
      diagnostic: string;
    }
  | {
      /** Replayed cleanly but added nothing on the current HEAD (already landed / empty diff). */
      status: "nothing_to_land";
      block_id: string;
      ref: string;
    }
  | {
      /** Re-ran the accept lifecycle but it still did not land (verify / scope / merged-base
       *  check RED, or a cherry-pick conflict) — work re-quarantined, retry after fixing. */
      status: "not_landed";
      block_id: string;
      ref: string;
      outcome: string;
      verify_passed: boolean;
      merged: boolean;
      diagnostic?: string;
    }
  | {
      /** Landed on green, quarantine ref cleared, run re-finalized. */
      status: "reverified";
      block_id: string;
      ref: string;
      outcome: string;
      verify_passed: boolean;
      merged: boolean;
      /** The block's finding items and their post-finalization status (blocked → resolved). */
      item_statuses: Array<{ finding_id: string; status: string }>;
      state_status: string;
    };

/**
 * Re-drive a QUARANTINED implement node after its verify-failure cause is fixed.
 *
 * When a node's accept-verify fails (a tool-verify false-negative, or an
 * environmental verify break like the .mjs/vitest-runner bug that false-failed
 * every real-change node), its committed work is preserved at
 * `refs/remediation-quarantine/<run>/<block>` but never landed, and the finalized
 * item stays `blocked`. Recovery until now was a manual `git cherry-pick -x` of the
 * quarantine ref + a hand-run whole-suite verify — leaving the gitignored run-state
 * permanently marked failed (auditor-agnostic-robustness gap: the fix only worked if
 * the host remembered the exact recovery dance).
 *
 * This re-runs the REAL accept lifecycle against the preserved commit, no host
 * bookkeeping: replay it onto the current remediation HEAD as fresh worktree edits
 * (equivalent to rebasing the single node commit onto the live base), then run the
 * identical tool-owned verify → write-scope → cherry-pick → merged-base gate the
 * host-subagent driver uses. On GREEN it lands the node, clears the quarantine ref,
 * and re-finalizes the run (`mergeImplementResults` is a pure finalizer over result
 * files + accept-outcome sidecars — it never re-does the cherry-pick), flipping the
 * node's item(s) blocked → resolved. On a still-RED verify, a scope/cross-package
 * failure, or a genuine seam conflict with a since-merged sibling, nothing lands and
 * the quarantine ref is preserved so it can be retried after the next fix.
 */
export async function reverifyQuarantinedNode(
  options: DispatchOptions,
  runId: string,
  blockId: string,
): Promise<ReverifyNodeResult> {
  const { root, artifactsDir } = options;
  const wt = worktreePath(root, blockId, runId);
  const branch = worktreeBranchForBlock(blockId, runId);
  const ref = quarantineRef(runId, blockId);

  // 1. Resolve the preserved commit. No ref → nothing to re-drive (wrong id, or a
  //    prior land already cleared it).
  const rev = spawnSyncHidden("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  const commit = (rev.stdout ?? "").trim();
  if (rev.status !== 0 || !commit) {
    return { status: "no_quarantine", block_id: blockId, ref };
  }

  // 2. Fresh worktree/branch at the current HEAD, seeded with the node's declared
  //    targets (same as a normal dispatch). resetNodeWorktreeAndBranch (folded into
  //    createNodeWorktree) clears any stale worktree/branch from the failed attempt.
  createNodeWorktree(
    root,
    blockId,
    runId,
    await declaredPathsForBlockSafe(artifactsDir, runId, blockId),
  );

  // 3. Replay the preserved commit's patch as UNCOMMITTED edits on the current HEAD.
  //    `commitWorktree` (inside acceptNodeWorktree) then commits them and the standard
  //    lifecycle runs. A conflict = a genuine seam with a sibling merged since the
  //    quarantine; discard the worktree and keep the ref for a later retry.
  const replay = spawnSyncHidden("git", ["cherry-pick", "--no-commit", commit], {
    cwd: wt,
    encoding: "utf8",
    shell: false,
  });
  if (replay.status !== 0) {
    const detail = [replay.stdout ?? "", replay.stderr ?? ""].filter(Boolean).join("\n").trim();
    // Clear any partial cherry-pick state, then drop the worktree — the ref is untouched.
    spawnSyncHidden("git", ["cherry-pick", "--quit"], { cwd: wt, shell: false });
    resetNodeWorktreeAndBranch(root, wt, branch);
    return {
      status: "conflict",
      block_id: blockId,
      ref,
      diagnostic:
        `replaying preserved commit ${commit.slice(0, 8)} onto the current remediation HEAD ` +
        `conflicted (a sibling likely edited the same lines since quarantine): ${detail}`,
    };
  }

  // 4. Run the real accept lifecycle — identical inputs to the host-subagent driver
  //    (advanceHostRolling), so correctness is the same. On success it clears the
  //    quarantine ref; on failure it re-quarantines the replayed commit.
  const state = await new StateStore(artifactsDir).loadState();
  const scope = await computeAcceptScope(artifactsDir, runId);
  const accept = await acceptNodeWorktree({
    root,
    runId,
    blockId,
    worktreeRoot: wt,
    branch,
    workerOutcome: "success",
    // Omitted targetedCommands → derive the verify from the replayed branch's touched
    // tests, plus the node's own build-free targeted_commands (task_7d35176d parity).
    additionalVerifyCommands: state ? targetedCommandsForBlock(state, blockId) : [],
    scope,
    writePaths: scope.allBlockScopes.find((b) => b.block_id === blockId)?.write_paths ?? [],
    // No `ownership` (D-66/67 slice-1 §4, deliberate): a quarantine re-drive takes NO
    // claim anywhere — it replays a preserved commit as a fresh operator-triggered
    // recovery, not a dispatch-loop node — so there is no lease to heartbeat here.
  });
  await recordNodeAcceptOutcome(artifactsDir, runId, blockId, accept);

  if (accept.outcome === "success" && !accept.merged && accept.diagnostic === undefined) {
    // acceptNodeWorktree's no-commit branch: the replay added nothing on the current
    // HEAD (already landed / empty diff). Not a failure, but nothing to finalize.
    return { status: "nothing_to_land", block_id: blockId, ref };
  }
  if (!(accept.outcome === "success" && accept.merged)) {
    // Still RED (verify / scope / merged-base check) or a cherry-pick conflict — the
    // replayed work is re-quarantined under the same ref; surface the captured cause.
    return {
      status: "not_landed",
      block_id: blockId,
      ref,
      outcome: accept.outcome,
      verify_passed: accept.verifyPassed,
      merged: accept.merged,
      ...(accept.diagnostic !== undefined ? { diagnostic: accept.diagnostic } : {}),
    };
  }

  // 5. Landed green → re-finalize the run so the node's item(s) flip blocked → resolved
  //    from the freshly-written accept-outcome sidecar. Pure finalizer: it never re-runs
  //    the cherry-pick, so the just-landed commit is not double-applied.
  const merged = await mergeImplementResults(options, runId);
  const findingIds = merged.plan?.blocks.find((b) => b.block_id === blockId)?.items ?? [];
  const itemStatuses = findingIds.map((finding_id) => ({
    finding_id,
    status: merged.items?.[finding_id]?.status ?? "unknown",
  }));
  return {
    status: "reverified",
    block_id: blockId,
    ref,
    outcome: accept.outcome,
    verify_passed: accept.verifyPassed,
    merged: accept.merged,
    item_statuses: itemStatuses,
    state_status: merged.status,
  };
}
