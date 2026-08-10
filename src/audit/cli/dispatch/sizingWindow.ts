import { resolveLimits } from "audit-tools/shared/quota/limits";
import type { DiscoveredRateLimitsInput } from "audit-tools/shared/quota/types";
import type { SessionConfig } from "audit-tools/shared/types/sessionConfig";

/**
 * Inputs the packet-sizing window is a function of. Deliberately the scalar
 * fields `resolveLimits` reads — NOT a `CapacityPool`. A pool is a routing
 * concept (a selectable backend with slots, cost, rank and an allowance); the
 * sizing window is task metadata (how much review content fits in one packet),
 * and the two must not be reachable from one another.
 *
 * There is deliberately NO `providerName` here. It was carried only to satisfy
 * `resolveLimits`, where it picks the `provider_default` vs `default` label and
 * nothing else — both branches return the same window pair, and this module
 * discards the label. Keeping it would have threaded a `PROVIDER_NAMES`-derived
 * type through the one sizing surface that survives the routing removal, for a
 * value that cannot move the number.
 */
export interface SizingWindowInput {
  sessionConfig: SessionConfig;
  /** Model whose window is being sized against; null when none resolved. */
  hostModel: string | null;
  /** Capabilities reported at the dispatch-time handshake, when the host gave any. */
  discoveredLimits?: DiscoveredRateLimitsInput | null;
}

/**
 * The usable per-packet content window, in tokens: the resolved context window
 * less the reserved output cap.
 *
 * Resolved DIRECTLY through {@link resolveLimits} — the same rung order every
 * other window consumer sees (explicit per-model override, then the discovered
 * handshake capability, then the models.dev snapshot, then operator defaults,
 * then unknown). It is deliberately NOT reached by folding a `CapacityPool`
 * through `computeDispatchCapacity`: that fold answers "how many concurrent
 * slots may this backend take right now", a routing question whose answer this
 * one never needed. The fold's `primary.schedule.resolved_limits` was only ever
 * `resolveLimits` called with a pool's own fields and then handed back, so
 * reading it directly is the same number by construction — pinned by
 * `tests/audit/dispatch-sizing-window.test.ts`.
 *
 * `null` means no window resolved anywhere, which is NOT a refusal here: the
 * single-window caller degrades to the one-task-per-packet partition (a minimum
 * unit that makes no fit claim), while a declared model roster keeps its loud
 * throw because a roster IS the handshake. Both behaviours live at the call
 * site, so this stays a pure resolution.
 */
export function resolveSizingWindowTokens(input: SizingWindowInput): number | null {
  const { limits } = resolveLimits({
    sessionConfig: input.sessionConfig,
    hostModel: input.hostModel,
    discoveredLimits: input.discoveredLimits ?? null,
  });
  if (limits.context_tokens == null || limits.output_tokens == null) return null;
  const budget = limits.context_tokens - limits.output_tokens;
  return budget > 0 ? budget : null;
}
