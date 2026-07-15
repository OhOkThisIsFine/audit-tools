import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  estimateTokensFromBytes,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  detectHostDispatchWall,
  emitBlindDispatchFrictionIfBlind,
  reconcileAdmissionLeasesFromQuotaFile,
} from "audit-tools/shared";
import type {
  SessionConfig,
  HostModelRosterEntry,
} from "audit-tools/shared";
import type { HostSessionEscalation } from "audit-tools/shared/quota/hostSessionQuotaSource";
import { buildDispatchPool, finalizeDispatchQuota } from "./quotaPool.js";

// Quota gate for the HOST fan-out steps (design-review perspectives + judge +
// contract; systemic-challenge adversary). These steps instruct the conversation
// host to dispatch its OWN Agent-tool subagents — a dispatch the tool must pace
// exactly like the packet path, or the fan-out dies raw at the host session wall
// with no friction and no resumable pause (backlog "Tool-prescribed host Agent
// fan-out is quota-INVISIBLE", HANDOFF item C).
//
// It reuses the SAME admission primitives as packet dispatch (`buildDispatchPool`
// → `finalizeDispatchQuota` → `detectHostDispatchWall`), so the two paths cannot
// drift on how a host pool grants + leases. The one deliberate divergence from the
// packet path: a fan-out panel is ATOMIC — the judge reads every perspective's
// findings within a single host step, so there is no next-step boundary to
// dispatch a granted subset and defer the rest. The gate therefore grants the
// WHOLE panel or pauses (`granted < required` ⇒ wall), never a partial panel.
//
// The dispatch-quota artifact is namespaced under `<artifactsDir>/fanout-quota/
// <family>/` — disjoint from the packet path's `runs/<runId>/dispatch-quota.json`,
// not a tracked artifact (zero staleness churn), one file per family so the
// results-ingest reconcile frees exactly this dispatch's leases.

/** One host subagent the fan-out step will dispatch. */
export interface HostFanoutUnit {
  /** Stable id for the admission packet / lease. */
  id: string;
  /**
   * Estimated input bytes for the subagent's rendered prompt. Perspective/adversary
   * prompts inline their bundle context, so this covers most of their real input; a
   * judge (which additionally reads sibling result files at run time) is slightly
   * under-counted — an optimistic estimate, so it never over-walls a panel.
   */
  estInputBytes: number;
}

/** The two host-fan-out families, each its own lease namespace. */
export type HostFanoutFamily = "design_review" | "systemic_challenge";

export interface HostFanoutGateOutcome {
  /** True when the host session cannot afford the whole panel this pass. */
  atWall: boolean;
  /** Advisory reset time to surface to the host; null when unknown. */
  earliestResetAt: string | null;
  reason: "empty_grant" | "cooldown" | "partial_grant" | null;
  grantedCount: number;
  requiredCount: number;
  /** The namespaced dispatch-quota path — reconciled at results ingest. */
  dispatchQuotaPath: string;
}

/** The namespaced dispatch-quota path for a fan-out family (also the ingest reconcile target). */
export function hostFanoutQuotaPath(artifactsDir: string, family: HostFanoutFamily): string {
  return join(artifactsDir, "fanout-quota", family, "dispatch-quota.json");
}

/**
 * Best-effort release of a fan-out family's outstanding leases once its results
 * have been ingested. Called from the design-review / systemic ingest chokepoints
 * so the leases free before the coverage packet dispatch that follows, rather than
 * lingering to the 20-min TTL and depressing its headroom. Tolerant of an absent
 * quota file (no fan-out dispatched this run, or already reconciled).
 */
export async function reconcileHostFanoutLeases(
  artifactsDir: string,
  family: HostFanoutFamily,
): Promise<void> {
  await reconcileAdmissionLeasesFromQuotaFile(
    hostFanoutQuotaPath(artifactsDir, family),
  ).catch(() => {});
}

/**
 * Register the host pool, estimate the panel's per-subagent token cost, and GRANT
 * + LEASE the whole panel against the shared reservation ledger. Returns an at-wall
 * outcome (leases already released) when the host session cannot afford the full
 * panel — the emitter then writes a resumable pause step instead of the fan-out.
 */
export async function gateHostFanout(params: {
  artifactsDir: string;
  sessionConfig: SessionConfig;
  family: HostFanoutFamily;
  /** The subagents this fan-out step will dispatch (panel is granted all-or-nothing). */
  units: HostFanoutUnit[];
  hostModel?: string | null;
  hostActiveSubagentLimit?: number | null;
  hostContextTokens?: number | null;
  hostOutputTokens?: number | null;
  hostModelId?: string | null;
  onEscalation?: (escalation: HostSessionEscalation) => void;
}): Promise<HostFanoutGateOutcome> {
  const { artifactsDir, sessionConfig, family, units } = params;
  const runDir = join(artifactsDir, "fanout-quota", family);
  await mkdir(runDir, { recursive: true });

  // Idempotent re-grant: free any prior grant's leases for this family BEFORE minting
  // fresh ones. `finalizeDispatchQuota` overwrites the family quota file, so a host
  // that re-runs next-step after a grant but before its results are ingested (the
  // obligation still derives, so the gate runs again) would otherwise orphan the
  // previous lease ids out of the file → they leak to the 20-min TTL. Reconciling
  // first releases them; the fresh grant re-leases the same panel.
  await reconcileAdmissionLeasesFromQuotaFile(
    hostFanoutQuotaPath(artifactsDir, family),
  ).catch(() => {});

  // Host-only single window — fan-out subagents all run on the conversation host
  // session (no backend spill, no roster tiering). queryLimits is omitted: the
  // HostSessionQuotaSource (/usage percent probe) is constructed regardless and is
  // the pre-wall source that matters here; RPM/TPM enrichment is not needed to pace
  // a host-subagent panel.
  const pool = await buildDispatchPool({
    sessionConfig,
    hostModel: params.hostModel ?? null,
    queryLimits: undefined,
    hostActiveSubagentLimit: params.hostActiveSubagentLimit,
    hostContextTokens: params.hostContextTokens,
    hostOutputTokens: params.hostOutputTokens,
    hostModelRoster: null as HostModelRosterEntry[] | null,
    hostModelId: params.hostModelId,
    ...(params.onEscalation ? { onEscalation: params.onEscalation } : {}),
  });

  const packets = units.map((unit) => ({
    id: unit.id,
    inputTokens:
      ESTIMATED_PROMPT_OVERHEAD_TOKENS +
      estimateTokensFromBytes(Math.max(0, unit.estInputBytes)),
    complexity: 1,
  }));

  const { dispatchQuotaPath, waveSchedule, dispatchCapacity, admission } =
    await finalizeDispatchQuota({
      runId: family,
      runDir,
      sessionConfig,
      pools: pool.pools,
      hostModel: pool.hostModel,
      packets,
      grantLeases: true,
      fanoutMode: true,
    });

  // Fail loud when self-quota monitoring is blind — the panel would otherwise run
  // unpaced. Identical signal to the packet path (parity).
  await emitBlindDispatchFrictionIfBlind({
    artifactsDir,
    runId: family,
    schedule: waveSchedule,
    itemCount: units.length,
    waveKind: family,
    toolName: "audit-code",
  });

  const grantedCount = admission.granted_packet_ids.length;
  const wall = detectHostDispatchWall({
    grantedCount,
    cooldownUntil: dispatchCapacity.cooldown_until ?? null,
    now: Date.now(),
  });
  // Atomic panel: a partial grant cannot run (the judge needs every perspective),
  // so anything short of the full panel is a wall.
  const partial = grantedCount < units.length;
  const atWall = wall.atWall || partial;

  if (atWall) {
    // Release the leases the grant reserved — pausing skips the ingest reconcile
    // that would otherwise free them, so without this they leak until the TTL.
    await reconcileAdmissionLeasesFromQuotaFile(dispatchQuotaPath).catch(() => {});
  }

  return {
    atWall,
    earliestResetAt: wall.earliestResetAt,
    reason: wall.reason ?? (partial ? "partial_grant" : null),
    grantedCount,
    requiredCount: units.length,
    dispatchQuotaPath,
  };
}
