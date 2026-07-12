/**
 * A-8 hybrid dispatch split (FINDING-020 capstone) — the ONE split layer BOTH
 * orchestrators drive.
 *
 * Given an eligible frontier and the confirmed CapacityPools, it drives the shared
 * {@link HybridSpillCoordinator} to split the frontier across the pools by capacity —
 * claiming each node to exactly one pool BEFORE it is returned (CE-001, single
 * claimant) — then partitions the claimed assignments into the work each driver
 * executes:
 *
 *  - `inProcess` — nodes on a backend pool the orchestrator launches itself this cycle
 *    (NIM / codex / opencode / subprocess), and
 *  - `host`      — nodes on the conversation host's pool, handed to the host driver.
 *
 * The host-vs-backend classification is the only tool-specific input — audit's
 * in-process provider set is narrower than remediate's — so it is injected as
 * {@link HybridDispatchInput.isInProcess} rather than baked in here. Everything else
 * (the coordinator, the claim, the capacity split, the settled-exclusion handshake) is
 * identical across both drivers, so the spill topology cannot drift between the two
 * tools. Pure logic over injected collaborators — no dispatch, no disk beyond the
 * registry claim — so it runs identically on win32 / darwin / linux.
 */

import { HybridSpillCoordinator, type FrontierNode, type NodeAssignment } from "./coordinator.js";
import type { CapacityPool } from "../quota/capacity.js";
import type { ClaimRegistry } from "../quota/claimRegistry.js";
import type { SessionConfig } from "../types/sessionConfig.js";
import type { SettledExclusionSet } from "../rolling/pausedState.js";

/** The proactive split of one frontier into the two driver classes + the coordinator. */
export interface HybridDispatchPartition {
  /** Nodes the orchestrator runs in-process this cycle (backend pools). */
  inProcess: NodeAssignment[];
  /** Nodes handed to the conversation host's driver (its own pool). */
  host: NodeAssignment[];
  /**
   * The live coordinator, so the caller can `release` claims on terminal accept,
   * `settlePool` an exhausted pool, and consult `terminalStatus` for the sole
   * pause authorization once the cycle's work is reconciled.
   */
  coordinator: HybridSpillCoordinator;
}

export interface HybridDispatchInput {
  frontier: FrontierNode[];
  pools: CapacityPool[];
  sessionConfig: SessionConfig;
  claimRegistry: ClaimRegistry;
  /** Current shared settled-exclusion set (pools that spilled-then-exhausted). */
  readSettled: () => SettledExclusionSet;
  /** Persist a newly-settled pool id into the shared set. */
  onSettle?: (poolId: string) => void | Promise<void>;
  /**
   * Classify a pool as one the orchestrator launches IN-PROCESS this cycle (vs. the
   * conversation host / IDE pool). Tool-specific: audit's in-process set excludes
   * `worker-command` / `subprocess-template`; remediate's includes them.
   */
  isInProcess: (pool: { providerName: string }) => boolean;
}

/**
 * Split one eligible frontier across the confirmed pools via the shared coordinator,
 * claiming each node to exactly one pool, and partition the claimed assignments by the
 * caller's in-process classification.
 *
 * Behaviour falls out of the pool set with no special-casing:
 *  - host-only pools → every node lands in `host`; `inProcess` empty.
 *  - backend-only pools → every node lands in `inProcess`; `host` empty.
 *  - mixed (`[host, backend]`) → both partitions are non-empty whenever both pools have
 *    headroom (the proactive-spill criterion).
 *
 * Nodes beyond the current total capacity are left unclaimed and re-offered next cycle,
 * which is what makes the distribution continuous.
 */
export async function planHybridDispatch(input: HybridDispatchInput): Promise<HybridDispatchPartition> {
  // Stamp each pool with the caller's own in-process classification BEFORE the S4
  // capacity fold sizes it — this is what exempts a self-pacing backend pool from
  // the host-oriented cold-start PROBE clamp (`scheduleWave`'s `selfPacing`; see
  // `CapacityPool.selfPacing`). Single-sourced here so the exemption always tracks
  // the same classification `isInProcess` uses to bucket the resulting assignments,
  // and no caller has to remember to set it when building its pool list.
  const pools: CapacityPool[] = input.pools.map((pool) => ({
    ...pool,
    selfPacing: input.isInProcess(pool),
  }));
  const coordinator = new HybridSpillCoordinator({
    pools,
    sessionConfig: input.sessionConfig,
    claimRegistry: input.claimRegistry,
    readSettled: input.readSettled,
    onSettle: input.onSettle,
  });
  const assignments = await coordinator.planAssignments(input.frontier);
  const inProcess: NodeAssignment[] = [];
  const host: NodeAssignment[] = [];
  for (const a of assignments) {
    (input.isInProcess(a) ? inProcess : host).push(a);
  }
  return { inProcess, host, coordinator };
}
