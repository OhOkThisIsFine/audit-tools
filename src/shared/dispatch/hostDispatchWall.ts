/**
 * The single wall predicate the conversation-first HOST-dispatch path draws in BOTH
 * orchestrators. The host obeys `admission.granted_packet_ids` (grant size = pacing
 * width); at the wall it must emit its OWN resumable pause instead of a dispatch step.
 * Detection is identical for audit + remediate (one core); the pause PRODUCTION
 * diverges by orchestrator (audit `paused_state`, remediate
 * `partial_completion_terminal{quota_paused}`) — see each producer.
 *
 * Two wall shapes:
 *  - `empty_grant` — admission granted zero packets (budget exhausted, or the shared
 *    reservation ledger is fully held by a concurrent admitter). An exhausted window
 *    also sets `cooldown_until` (scheduler), so it usually carries a reset time; a bare
 *    ledger-full wall has none (`earliestResetAt` null → host best-effort re-runs).
 *  - `cooldown` — an active `cooldown_until`. This is the F1 hole: during cooldown the
 *    scheduler leaves `remaining_token_budget` null → admission maps null→+Infinity and
 *    over-grants the whole frontier (for pools with no declared `max_concurrent`),
 *    ignoring the cooldown throttle. The host must PAUSE, not fan the over-grant out.
 *    `cooldown_until` is the reset signal.
 */
export interface HostDispatchWall {
  atWall: boolean;
  /** Advisory reset time to surface to the host; null when unknown (bare empty grant). */
  earliestResetAt: string | null;
  reason: "empty_grant" | "cooldown" | null;
}

export function detectHostDispatchWall(params: {
  /** `admission.granted_packet_ids.length`. */
  grantedCount: number;
  /** The wave's `cooldown_until` (the value written to `dispatch-quota.json`). */
  cooldownUntil?: string | null;
  /** Injected wall-clock (ms) so the predicate is pure/testable. */
  now: number;
}): HostDispatchWall {
  const cooldownActive =
    params.cooldownUntil != null &&
    Number.isFinite(new Date(params.cooldownUntil).getTime()) &&
    new Date(params.cooldownUntil).getTime() > params.now;

  if (cooldownActive) {
    // Cooldown wins the reason even if the grant also happens to be empty, because it
    // carries the authoritative reset signal.
    return { atWall: true, earliestResetAt: params.cooldownUntil ?? null, reason: "cooldown" };
  }
  if (params.grantedCount === 0) {
    return { atWall: true, earliestResetAt: null, reason: "empty_grant" };
  }
  return { atWall: false, earliestResetAt: null, reason: null };
}
