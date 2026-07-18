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
import type { QuotaBindingWindow } from "../quota/types.js";

/**
 * WHY an `empty_grant` wall granted zero (unified-routing step E) — the honest-wall
 * discriminator. A zero grant is NOT always "the session limit is exhausted":
 *  - `budget_exhausted` — a real token-budget block; the reset/binding window applies.
 *  - `cap_reached`      — the in-flight cap/ledger is momentarily fully held (a
 *                         concurrent admitter or live wave); frees in seconds-to-minutes.
 *  - `no_capable_pool`  — EVERY blocked packet fit no pool (window/capability): a
 *                         structural mismatch, not a quota wall — waiting changes nothing.
 * Mislabeling all three "exhausted" is what rendered a ~56%-headroom host as walled
 * with empty explains in the 2026-07-17 dogfood (item C).
 */
export type EmptyGrantCause = "budget_exhausted" | "cap_reached" | "no_capable_pool";

/**
 * Classify a zero-grant's dominant cause from the admission explains, by
 * actionability: any budget block → `budget_exhausted` (wait for the reset); else any
 * transient ledger contention → `cap_reached` (re-run shortly); else — only when every
 * blocked packet had NO capable pool — `no_capable_pool`. Null when there are no
 * blocked explains to classify (degenerate empty wave).
 */
export function classifyEmptyGrantCause(
  explains: ReadonlyArray<{ reason?: string; admitted?: boolean }>,
): EmptyGrantCause | null {
  const blocked = explains.filter((e) => e.admitted !== true);
  if (blocked.length === 0) return null;
  if (blocked.some((e) => e.reason === "budget_exhausted")) return "budget_exhausted";
  if (blocked.some((e) => e.reason === "cap_reached")) return "cap_reached";
  if (blocked.every((e) => e.reason === "no_capable_pool")) return "no_capable_pool";
  return null;
}

export interface HostDispatchWall {
  atWall: boolean;
  /** Advisory reset time to surface to the host; null when unknown. */
  earliestResetAt: string | null;
  reason: "empty_grant" | "cooldown" | null;
  /**
   * The classified cause of an `empty_grant` wall (see {@link EmptyGrantCause});
   * null on a cooldown wall / no wall / unclassifiable explains. The renderer keys
   * its honesty on this — "exhausted" is claimed ONLY for `budget_exhausted`.
   */
  emptyGrantCause: EmptyGrantCause | null;
  /**
   * The window that bound the pool's token budget (the MIN-budget window), when the
   * wall is a budget wall rather than a cooldown. Lets the host step name WHY zero
   * packets fit — e.g. a low weekly window whose reset is days out while the session
   * window is fresh (D1). Null on a cooldown wall or when no budget signal was given.
   */
  bindingWindow: QuotaBindingWindow | null;
}

export function detectHostDispatchWall(params: {
  /** `admission.granted_packet_ids.length`. */
  grantedCount: number;
  /** The wave's `cooldown_until` (the value written to `dispatch-quota.json`). */
  cooldownUntil?: string | null;
  /**
   * The pool's binding token-budget window (the MIN-budget window; from the wave
   * schedule / capacity summary). On an `empty_grant` wall — where no cooldown carries
   * a reset — this supplies the advisory reset time and the window identity so the
   * host step can explain the wall instead of promising a reset it never derived.
   */
  bindingWindow?: QuotaBindingWindow | null;
  /**
   * The admission explains for this grant (unified-routing step E) — classifies WHY
   * an empty grant was empty ({@link classifyEmptyGrantCause}) so the wall renders
   * its honest cause instead of a blanket "exhausted". Omit ⇒ cause null (legacy
   * callers keep the generic rendering).
   */
  explains?: ReadonlyArray<{ reason?: string; admitted?: boolean }>;
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
    return {
      atWall: true,
      earliestResetAt: params.cooldownUntil ?? null,
      reason: "cooldown",
      bindingWindow: null,
      emptyGrantCause: null,
    };
  }
  if (params.grantedCount === 0) {
    // Budget wall: the binding window supplies the reset (may still be null if that
    // window declares no reset) and the identity for the host-facing explanation.
    return {
      atWall: true,
      earliestResetAt: params.bindingWindow?.reset_at ?? null,
      reason: "empty_grant",
      bindingWindow: params.bindingWindow ?? null,
      emptyGrantCause: params.explains ? classifyEmptyGrantCause(params.explains) : null,
    };
  }
  return { atWall: false, earliestResetAt: null, reason: null, bindingWindow: null, emptyGrantCause: null };
}

/**
 * True when admission blocked at least one packet on BUDGET (`budget_exhausted`)
 * rather than only a `cap_reached` ledger-contention wall. The single discriminator
 * both orchestrators draw to decide whether an `empty_grant` should attach the binding
 * window + its (possibly days-out) reset — a genuine budget wall — or keep the prior
 * best-effort null-reset behavior for a transient ledger-full grant (frees in seconds).
 */
export function admissionBlockedOnBudget(
  explains: ReadonlyArray<{ reason?: string }>,
): boolean {
  return explains.some((e) => e.reason === "budget_exhausted");
}

/**
 * Human-facing explanation of a budget (`empty_grant`) wall for the host pause step —
 * names the binding window, its remaining budget + reset, and (when known) the
 * smallest packet's cost so the operator sees WHY zero packets fit rather than a bare
 * "wait for the reset" with no time. Empty string when there is no binding window
 * (cooldown wall, or no live budget signal), so callers can append it unconditionally.
 * Deterministic formatting (no locale grouping) so it never churns across platforms.
 */
export function renderHostWallExplanation(
  bindingWindow: QuotaBindingWindow | null,
  perPacketCost?: number | null,
): string {
  if (!bindingWindow) return "";
  const reset = bindingWindow.reset_at
    ? `resets ${bindingWindow.reset_at}`
    : "no declared reset time";
  // Only claim "none fit" when the smallest packet genuinely exceeds the budget — the
  // caller passes a binding window only on a budget wall, but keep the phrasing honest
  // regardless (a healthy budget with a stated cost must never read "none fit").
  const cost =
    perPacketCost != null && Number.isFinite(perPacketCost)
      ? perPacketCost > bindingWindow.budget
        ? `; the smallest packet needs ~${Math.round(perPacketCost)} tokens, so none fit this pass`
        : `; the smallest packet needs ~${Math.round(perPacketCost)} tokens`
      : "";
  return ` Binding quota window '${bindingWindow.label}': ~${Math.round(bindingWindow.budget)} tokens remaining, ${reset}${cost}.`;
}
