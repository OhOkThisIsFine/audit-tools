import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  estimateTokensFromBytes,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  detectHostDispatchWall,
  admissionBlockedOnBudget,
  classifyEmptyGrantCause,
  emitBlindDispatchFrictionIfBlind,
  reconcileAdmissionLeasesFromQuotaFile,
  checkLivelockGuard,
  readJsonFile,
  writeJsonFile,
} from "audit-tools/shared";
import type {
  SessionConfig,
  HostModelRosterEntry,
  QuotaBindingWindow,
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
  /**
   * True when the wall has persisted past the livelock bound (LIVELOCK_PAUSE_LIMIT
   * consecutive walled passes). The enrichment must be SKIPPED — a design-review /
   * systemic panel is enrichment, so a permanent host wall must not stall the run;
   * the caller stamps the pass satisfied-by-skip and continues (parity with the
   * packet path's livelock → partial-synthesis give-up). Only ever true when atWall.
   */
  livelocked: boolean;
  /** Advisory reset time to surface to the host; null when unknown. */
  earliestResetAt: string | null;
  reason: "empty_grant" | "cooldown" | "partial_grant" | null;
  /**
   * WHY the grant fell short (step E, {@link classifyEmptyGrantCause}); null when not
   * at a wall / unclassifiable. `no_capable_pool` = structural fit failure — the
   * caller's message must say "the panel does not fit the available window", never
   * "quota wall", and the outcome arrives already `livelocked` (immediate skip).
   */
  emptyGrantCause: "budget_exhausted" | "cap_reached" | "no_capable_pool" | null;
  grantedCount: number;
  requiredCount: number;
  /** The namespaced dispatch-quota path — reconciled at results ingest. */
  dispatchQuotaPath: string;
  /** The binding budget window (D1), for the host-facing wall explanation. Null on cooldown / no signal. */
  bindingWindow: QuotaBindingWindow | null;
  /** The smallest panel unit's estimated cost, compared against the binding budget in the wall message. */
  perPacketCost: number | null;
}

/** Resumable pause-count state for a fan-out family (bounds the wall to a skip). */
interface FanoutPauseState {
  pause_count: number;
  paused_at: string;
}

/**
 * Advance the fan-out family's resumable pause counter from the fresh wall snapshot,
 * bounding an indefinite wall to a skip. Fan-out has no `active-dispatch.json` run to
 * hang `paused_state` on (it is not a packet-dispatch run), so it keeps its own tiny
 * counter in the family dir. Returns true when the livelock bound is reached — the
 * caller then skips the enrichment. Clears the counter on a cleared wall (resume) or
 * at the bound (so a later obligation starts fresh).
 *
 * All call sites of one family (e.g. design_review's parallel/contract/conceptual
 * emitters) share this single per-family counter. That is correct because the family's
 * obligations run sequentially and any granted (non-wall) pass clears the counter — so
 * a later obligation never inherits an earlier one's stale pause count.
 */
async function advanceFanoutPause(
  runDir: string,
  atWall: boolean,
  livelockLimit?: number,
): Promise<boolean> {
  const path = join(runDir, "pause.json");
  if (!atWall) {
    await rm(path, { force: true }).catch(() => {});
    return false;
  }
  const prior = await readJsonFile<FanoutPauseState>(path).catch(() => null);
  if (!prior) {
    await writeJsonFile(path, {
      pause_count: 0,
      paused_at: new Date().toISOString(),
    } satisfies FanoutPauseState);
    return false;
  }
  const nextCount = prior.pause_count + 1;
  // netNewCapacity is 0 — a fan-out wall is the SAME host session regaining capacity
  // after a reset, never a new provider, so the guard trips purely on pause count.
  if (checkLivelockGuard(nextCount, 0, livelockLimit)) {
    await rm(path, { force: true }).catch(() => {});
    return true;
  }
  await writeJsonFile(path, {
    pause_count: nextCount,
    paused_at: prior.paused_at,
  } satisfies FanoutPauseState);
  return false;
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
    // Deliberately null, not unwired: this gate paces a HOST-ONLY subagent panel in a
    // single window with no roster tiering and no backend spill (see above), so the
    // admission capability floor has nothing to band between — every unit runs on the
    // same conversation-host session. Reading the confirmation here would buy nothing
    // and would force a `root` param through five `gateHostFanoutOrPause` call sites.
    capabilityRanks: null,
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
  // Attribute the binding window only on a genuine BUDGET block — not a `cap_reached`
  // ledger-contention empty grant (frees in seconds; the window reset may be days out).
  const budgetBound = admissionBlockedOnBudget(admission.explains);
  const wall = detectHostDispatchWall({
    grantedCount,
    cooldownUntil: dispatchCapacity.cooldown_until ?? null,
    bindingWindow: budgetBound ? (waveSchedule.binding_window ?? null) : null,
    explains: admission.explains,
    now: Date.now(),
  });
  // The smallest panel unit's cost — if even that doesn't fit the binding budget, zero
  // grant, so it's the number the host step compares against the binding window.
  const perPacketCost = packets.length
    ? Math.min(...packets.map((p) => p.inputTokens))
    : null;
  // Atomic panel: a partial grant cannot run (the judge needs every perspective),
  // so anything short of the full panel is a wall.
  const partial = grantedCount < units.length;
  const atWall = wall.atWall || partial;

  if (atWall) {
    // Release the leases the grant reserved — pausing skips the ingest reconcile
    // that would otherwise free them, so without this they leak until the TTL.
    await reconcileAdmissionLeasesFromQuotaFile(dispatchQuotaPath).catch(() => {});
  }

  // Honest-wall discriminator (unified-routing step E): classify WHY the grant fell
  // short. A `no_capable_pool` block is STRUCTURAL — every blocked unit fit no pool
  // (window/capability), and the host window never grows — so waiting is provably
  // futile: no reset clears it. Walking the resumable pause counter would burn
  // LIVELOCK_PAUSE_LIMIT next-step passes rendering a fake "quota wall" before
  // skipping (B-review F1). Flip straight to the livelock/skip outcome instead.
  const emptyGrantCause = atWall ? classifyEmptyGrantCause(admission.explains) : null;
  const structuralFitBlock = atWall && emptyGrantCause === "no_capable_pool";
  const livelocked = structuralFitBlock
    ? true
    : await advanceFanoutPause(runDir, atWall);
  if (structuralFitBlock) {
    // Clear any carried pause state — the skip is immediate, not counted.
    await rm(join(runDir, "pause.json"), { force: true }).catch(() => {});
  }

  return {
    atWall,
    livelocked,
    earliestResetAt: wall.earliestResetAt,
    reason: wall.reason ?? (partial ? "partial_grant" : null),
    emptyGrantCause,
    grantedCount,
    requiredCount: units.length,
    dispatchQuotaPath,
    bindingWindow: wall.bindingWindow,
    perPacketCost,
  };
}
