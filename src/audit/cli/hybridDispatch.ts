/**
 * A-8 hybrid dispatch split — audit driver (FINDING-020 capstone).
 *
 * The audit-side counterpart of remediate's hybrid split. The conversation host
 * reviews packets in a BATCH (the `semantic_review` / worker-run handoff), while the
 * in-process provider engine (`driveRollingAuditDispatch`) reviews packets itself.
 * Under the hybrid topology both run for ONE review obligation: the in-process driver
 * reviews the coordinator-assigned backend (NIM) partition this cycle, and — because
 * `mergeAndIngest` folds `task-results/` by `task_id` and `buildPendingAuditTasks` is
 * COVERAGE-driven — the host-review path then automatically covers only the complement
 * (the NIM tasks already have results, so they are no longer pending).
 *
 * So the audit split is simpler than remediate's: pass ONLY the NIM pool(s) to the
 * shared {@link HybridSpillCoordinator}. It bounds NIM to its capacity and CLAIMS each
 * assigned task BEFORE returning it (exactly-one-claimant — a second in-process loop
 * can never grab the same task); everything it does not assign is left pending for the
 * batch host review. The coordinator is the SAME shared assignment layer remediate
 * drives, so the spill topology cannot drift between the two tools.
 */

import { join } from "node:path";
import {
  HybridSpillCoordinator,
  ClaimRegistry,
  buildConfiguredApiPool,
  buildQuotaSource,
  readQuotaState,
  type CapacityPool,
  type FrontierNode,
  type QuotaStateEntry,
  type SessionConfig,
  type SettledExclusionSet,
} from "audit-tools/shared";

/**
 * Backends audit can drive IN-PROCESS as the per-packet review worker. Narrower than
 * remediate's set: `local-subprocess` / `subprocess-template` are excluded (a read-only
 * review packet carries no per-worker command, and `local-subprocess` is audit's
 * conventional host-dispatch default). The host (`claude-code`) and IDE backends are
 * the batch host-review path, never in-process.
 */
const IN_PROCESS_AUDIT_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "codex",
  "opencode",
]);

/** Whether a confirmed pool is one audit launches in-process as a review worker. */
export function isInProcessAuditPool(pool: { providerName: string }): boolean {
  return IN_PROCESS_AUDIT_PROVIDERS.has(pool.providerName);
}

/**
 * Build the in-process backend (NIM / openai-compatible) pool(s) audit can spill review
 * packets onto, alongside the conversation host. Uses the SAME shared
 * `buildConfiguredApiPool` remediate's `buildConfirmedPools` does, so the pool shape is
 * identical across both drivers. Empty when no endpoint is configured (→ no hybrid).
 */
export async function buildAuditNimPools(sessionConfig: SessionConfig): Promise<CapacityPool[]> {
  const primaryProviderName =
    (sessionConfig as { provider?: string }).provider ?? "claude-code";
  let quotaEntries: Record<string, QuotaStateEntry> = {};
  try {
    quotaEntries = (await readQuotaState()).entries;
  } catch {
    // Non-fatal: a missing/locked quota state degrades to no learned entry.
  }
  const quotaSource = buildQuotaSource({
    halfLifeHours: (sessionConfig as { quota?: { empirical_half_life_hours?: number } }).quota
      ?.empirical_half_life_hours,
  });
  const nim = await buildConfiguredApiPool({
    sessionConfig,
    primaryProviderName,
    quotaSource,
    quotaEntries,
  });
  return nim ? [nim] : [];
}

/** One coordinator-claimed review task, joined to the backend pool it was assigned to. */
export interface AuditHybridAssignment {
  task_id: string;
  pool_id: string;
  providerName: CapacityPool["providerName"];
  hostModel: string | null;
  ownerToken: string;
}

/** The in-process partition of one review frontier + the live coordinator. */
export interface AuditHybridPartition {
  /** Tasks the orchestrator reviews in-process this cycle (on a backend pool). */
  inProcess: AuditHybridAssignment[];
  /** The live coordinator, for `release` on terminal + `settlePool` / `terminalStatus`. */
  coordinator: HybridSpillCoordinator;
}

/**
 * The audit run's shared claim registry — keyed only to the artifacts dir, so a claim
 * the in-process driver takes is visible to any peer in-process loop driving the same
 * review (exactly-one-claimant). The batch host-review path is not claim-aware; it
 * reviews whatever remains pending after the in-process partition ingests.
 */
export function auditNodeClaimRegistry(artifactsDir: string): ClaimRegistry {
  return new ClaimRegistry(join(artifactsDir, "runs", "audit-node-claims.json"));
}

/**
 * Split a review frontier: claim up to the NIM pool(s)' capacity for in-process review;
 * leave the rest pending for the batch host review (coverage-driven complement). Pass
 * ONLY the NIM pool(s) — the host needs no bounded share (it batch-reviews whatever the
 * coordinator does not claim).
 */
export async function planAuditHybridDispatch(input: {
  frontier: FrontierNode[];
  nimPools: CapacityPool[];
  sessionConfig: SessionConfig;
  claimRegistry: ClaimRegistry;
  readSettled: () => SettledExclusionSet;
  onSettle?: (poolId: string) => void | Promise<void>;
}): Promise<AuditHybridPartition> {
  const coordinator = new HybridSpillCoordinator({
    pools: input.nimPools,
    sessionConfig: input.sessionConfig,
    claimRegistry: input.claimRegistry,
    readSettled: input.readSettled,
    onSettle: input.onSettle,
  });
  const assignments = await coordinator.planAssignments(input.frontier);
  const inProcess: AuditHybridAssignment[] = assignments.map((a) => ({
    task_id: a.nodeId,
    pool_id: a.poolId,
    providerName: a.providerName,
    hostModel: a.hostModel,
    ownerToken: a.ownerToken,
  }));
  return { inProcess, coordinator };
}
