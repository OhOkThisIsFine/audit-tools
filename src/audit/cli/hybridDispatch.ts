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
  ClaimRegistry,
  isInProcessWorkerProvider,
  buildSourcePools,
  type SourcePoolBuild,
  buildQuotaSource,
  dedupHostAndSourcePools,
  readQuotaStateOrDegrade,
  type CapacityPool,
  type DispatchExclusion,
  type QuotaStateEntry,
  type ResolvedProviderName,
  type SessionConfig,
} from "audit-tools/shared";

/**
 * Whether a confirmed pool is one audit launches in-process as a review worker —
 * the shared `isInProcessWorkerProvider` predicate (H3), audit policy: no
 * command-shaped workers (a read-only review packet carries no per-worker command,
 * and `worker-command` is audit's conventional host-dispatch default). The host
 * (`claude-code`) and IDE backends are the batch host-review path, never in-process.
 */
export function isInProcessAuditPool(pool: { providerName: string }): boolean {
  return isInProcessWorkerProvider(pool.providerName);
}

/**
 * Build the in-process backend source pool(s) audit can spill review packets onto,
 * alongside the conversation host — any configured non-IDE dispatchable source
 * (`sessionConfig.sources` + a legacy `openai_compatible` block). Uses the SAME shared
 * `buildSourcePools` remediate's `buildConfirmedPools` does, so the pool shapes are
 * identical across both drivers. Empty when no source is configured (→ no hybrid).
 */
export async function buildAuditSourcePools(
  sessionConfig: SessionConfig,
  options?: {
    /** Operator-excluded + locally-self-spawn-blocked backends (`resolveDispatchExclusion`). */
    excludedBackends?: DispatchExclusion;
    /**
     * The attended conversation host's identity (D1 cross-class dedup): audit's host
     * is never a member pool (plan D6 — it reviews the coverage-driven complement),
     * so the shared collision rule degenerates here to dropping a colliding
     * NON-in-process source; a colliding in-process source survives (the engine
     * drives that one account). Omit on a headless run (no host identity).
     */
    attendedHostProviderName?: ResolvedProviderName | null;
  },
): Promise<SourcePoolBuild> {
  const primaryProviderName =
    (sessionConfig as { provider?: string }).provider ?? "claude-code";
  const quotaEntries: Record<string, QuotaStateEntry> = (
    await readQuotaStateOrDegrade("audit source-pool build")
  ).entries;
  const quotaSource = buildQuotaSource();
  // H2+H4 collapse: the configured primary in-process backend is ALWAYS folded in as
  // a source pool (no demote flag) — audit's draw policy admits only the non-command
  // in-process workers (a read-only review packet carries no per-worker command).
  const { pools: sourcePools, zeroedByExclusion } = await buildSourcePools({
    sessionConfig,
    primaryProviderName,
    quotaSource,
    quotaEntries,
    excludedBackends: options?.excludedBackends,
  });
  return {
    pools: dedupHostAndSourcePools({
      hostPools: [],
      sourcePools,
      hostProviderName: options?.attendedHostProviderName ?? null,
    }).sourcePools,
    // Carried through UNCHANGED: the dedup below can only remove a colliding pool, it
    // can never cause the zeroing, so re-deriving the fact here would misattribute it.
    zeroedByExclusion,
  };
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
 * The audit run's cross-cycle settled-pool store path (DC-4) — keyed to the artifacts
 * dir, read each cycle by the coordinator's `readSettled` and appended to when a NIM
 * pool exhausts, so the stranded review tasks fall back to the batch host review.
 */
export function auditHybridSettledPath(artifactsDir: string): string {
  return join(artifactsDir, "runs", "hybrid-settled-pools.json");
}
