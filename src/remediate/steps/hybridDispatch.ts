/**
 * A-8 hybrid dispatch split (FINDING-020 capstone).
 *
 * The ONE proactive assignment step the remediate next-step runs before any
 * dispatch: given the eligible implement frontier and the confirmed CapacityPools
 * (the host-subagent pool + any in-process backend pools, from `buildConfirmedPools`),
 * it drives the shared {@link HybridSpillCoordinator} to split the frontier across
 * BOTH pool classes by available capacity — claiming each node to exactly one pool
 * BEFORE either driver sees it (CE-001, single claimant) — then partitions the
 * claimed assignments into the work each driver executes:
 *
 *  - `inProcess` — nodes assigned to a backend pool the orchestrator launches
 *    itself THIS cycle (`openai-compatible` / `codex` / `opencode` / subprocess), and
 *  - `host`      — nodes assigned to the conversation host's subagent pool, handed
 *    back in the dispatch step contract for the host to spawn a subagent per node.
 *
 * `acceptNodeWorktree` (already shared) merges both partitions identically. The
 * split is proactive + continuous: re-run each next-step cycle over the remaining
 * frontier, so as long as both pools have headroom, work flows to both concurrently
 * (spec `docs/remaining-specs.md` §A8). The coordinator + the shared `ClaimRegistry`
 * are the cross-driver mutual-exclusion guarantee, so the two structurally-different
 * drivers (turn-based host vs. in-process loop) can never double-claim a node.
 *
 * This module is the assignment LAYER only — pure logic over injected collaborators
 * (pools, registry, the settled-set hooks). It performs no dispatch, no worktree
 * work, and no disk I/O of its own beyond the registry claim, so it runs identically
 * on win32 / darwin / linux and is unit-testable without spawning a worker.
 */

import {
  HybridSpillCoordinator,
  type CapacityPool,
  type ClaimRegistry,
  type FrontierNode,
  type ResolvedProviderName,
  type SessionConfig,
  type SettledExclusionSet,
} from "audit-tools/shared";

/**
 * Backend providers the orchestrator can run IN-PROCESS as the per-node implement
 * worker this cycle (it resolves + launches the provider headless against each
 * node's worktree). A pool whose provider is NOT in this set is the conversation
 * host's subagent pool (`claude-code`) or an IDE-bound backend (`vscode-task` /
 * `antigravity`) with no headless launch — its nodes go to the host partition. The
 * single source of this classification across the remediate dispatch paths, so the
 * decision point and the in-process executor agree on who runs a pool's nodes.
 */
export const IN_PROCESS_DISPATCH_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "codex",
  "opencode",
  "subprocess-template",
  "local-subprocess",
]);

/** Whether a confirmed pool is one the orchestrator launches in-process this cycle. */
export function isInProcessPool(pool: { providerName: string }): boolean {
  return IN_PROCESS_DISPATCH_PROVIDERS.has(pool.providerName);
}

/**
 * One coordinator-claimed node, joined to the pool it was assigned to. Carries the
 * `ownerToken` so whichever driver executes the node releases the SAME claim it was
 * handed (token-checked) once its `acceptNodeWorktree` lifecycle finishes — the
 * claim never has to be re-taken downstream (which would self-collide).
 */
export interface HybridNodeAssignment {
  block_id: string;
  pool_id: string;
  providerName: ResolvedProviderName;
  hostModel: string | null;
  ownerToken: string;
}

/** The proactive split of one frontier across both driver classes. */
export interface HybridDispatchPartition {
  /** Nodes the orchestrator runs in-process this cycle (backend pools). */
  inProcess: HybridNodeAssignment[];
  /** Nodes handed to the conversation host to spawn a subagent per node. */
  host: HybridNodeAssignment[];
  /**
   * The live coordinator, so the caller can `release` claims on terminal accept,
   * `settlePool` an exhausted pool, and consult `terminalStatus` for the sole
   * pause authorization once both drivers' work for the cycle is reconciled.
   */
  coordinator: HybridSpillCoordinator;
}

/**
 * Split one eligible frontier across the confirmed pools via the shared coordinator,
 * claiming each node to exactly one pool, and partition the claimed assignments into
 * the in-process and host work sets.
 *
 * Behaviour falls out of the pool set with no special-casing:
 *  - host-only pool (`claude-code`, no backend configured) → every node lands in
 *    `host`; `inProcess` is empty.
 *  - backend-only pool (`openai-compatible` primary) → every node lands in
 *    `inProcess`; `host` is empty.
 *  - hybrid (`[host, nim]`) → the coordinator splits by capacity, so both partitions
 *    are non-empty whenever both pools have headroom (the proactive-spill criterion).
 *
 * Nodes beyond the current total capacity are left unclaimed (no assignment) and are
 * re-offered next cycle, which is what makes the distribution continuous.
 */
export async function planHybridDispatch(input: {
  frontier: FrontierNode[];
  pools: CapacityPool[];
  sessionConfig: SessionConfig;
  claimRegistry: ClaimRegistry;
  /** Current shared settled-exclusion set (pools that spilled-then-exhausted). */
  readSettled: () => SettledExclusionSet;
  /** Persist a newly-settled pool id into the shared set. */
  onSettle?: (poolId: string) => void | Promise<void>;
}): Promise<HybridDispatchPartition> {
  const coordinator = new HybridSpillCoordinator({
    pools: input.pools,
    sessionConfig: input.sessionConfig,
    claimRegistry: input.claimRegistry,
    readSettled: input.readSettled,
    onSettle: input.onSettle,
  });

  const assignments = await coordinator.planAssignments(input.frontier);

  const inProcess: HybridNodeAssignment[] = [];
  const host: HybridNodeAssignment[] = [];
  for (const a of assignments) {
    const entry: HybridNodeAssignment = {
      block_id: a.nodeId,
      pool_id: a.poolId,
      providerName: a.providerName,
      hostModel: a.hostModel,
      ownerToken: a.ownerToken,
    };
    (isInProcessPool(a) ? inProcess : host).push(entry);
  }

  return { inProcess, host, coordinator };
}
