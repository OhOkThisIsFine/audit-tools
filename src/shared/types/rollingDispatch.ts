/**
 * Versioned seam contract for the Rolling Dispatch Engine (N-X06).
 *
 * This file pins the public interface of the rolling dispatch engine so that
 * consumers (audit-code, remediate-code) and the shared implementation can be
 * validated against a single, version-stamped contract.
 *
 * The implementing class lives in src/dispatch/rollingDispatch.ts.
 * This file ONLY declares the contract types and the version constant.
 */

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

/**
 * Version string for the RollingDispatchEngine contract.
 * Increment when any breaking interface change lands.
 */
export const ROLLING_DISPATCH_ENGINE_VERSION = "1.0.0" as const;

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/** A dispatchable unit of work (packet-type-agnostic contract). */
export interface RollingDispatchEnginePacket<TPacket = unknown> {
  /** Stable, unique identifier for this packet within a run. */
  id: string;
  /** Consumer-defined payload — never inspected by the engine. */
  payload: TPacket;
  /**
   * Estimated token cost (input tokens) for this packet.
   * Used for quota headroom checks; over-estimates are safe.
   */
  estimatedTokens: number;
  /**
   * Complexity score in [0, 1].
   * 1 = highest complexity — routed to the most-capable pool first.
   */
  complexity: number;
}

/** Outcome returned after each packet completes. */
export interface RollingDispatchEngineResult<TPacket = unknown> {
  packet: RollingDispatchEnginePacket<TPacket>;
  outcome: "success" | "rate_limited" | "timeout" | "error";
  actualTokens?: number;
  error?: unknown;
  /**
   * Worker ERROR/STATUS channel evidence that classified a `rate_limited`
   * outcome, carried so a consumer's `recordRateLimit` hook can feed a
   * channel-isolated host-session source (CE-003). Absent on non-rate_limited
   * outcomes.
   */
  rateLimit?: { channel: "error" | "status" | "result"; text: string };
}

/**
 * Core interface for the rolling dispatch engine.
 *
 * Fields correspond to the key lifecycle hooks described in the redesign spec
 * (spec/audit-workflow-design.md §rolling_dispatch):
 *
 * - dispatchItems: enqueue packets for processing.
 * - onResult:      callback invoked synchronously after each result.
 * - livelockGuard: detects stalled dispatch (no net new capacity after N pauses).
 * - consumerTerminal: hook called when the engine stops (complete or partial).
 */
export interface RollingDispatchEngineContract<TPacket = unknown> {
  /** Enqueue packets; safe to call while the engine is running. */
  dispatchItems: (packets: RollingDispatchEnginePacket<TPacket>[]) => void;
  /** Per-result notification callback (synchronous). */
  onResult: ((result: RollingDispatchEngineResult<TPacket>) => void) | undefined;
  /** Livelock guard: max pauses with no net new capacity before the engine terminates. */
  livelockGuard: number;
  /** Terminal hook invoked with the final status when the engine stops. */
  consumerTerminal:
    | ((status: "complete" | "partial", results: RollingDispatchEngineResult<TPacket>[]) => void)
    | undefined;
  /**
   * Host-session escalation write side: invoked at the `rate_limited`
   * observation point so the consumer can feed its retained host-session
   * source's channel-isolated `recordLimit`. Optional — omit to leave the
   * source unfed (no escalation can ever fire, INV-QD-07 unchanged).
   */
  recordRateLimit?: (
    packet: RollingDispatchEnginePacket<TPacket>,
    result: RollingDispatchEngineResult<TPacket>,
  ) => void;
  /**
   * Host-session escalation read side: an already-ESCALATED packet is
   * stranded instead of re-queued. Optional — omit to leave INV-QD-07
   * behaviour unchanged.
   */
  isPacketEscalated?: (packetId: string) => boolean;
  /**
   * Reactive cost verification: invoked once per pool when a declared-free pool is
   * first observed charging (the engine has already demoted it out of free-first).
   * The consumer wires it to friction emission. Optional — omit to leave the
   * demotion silent (no friction).
   */
  onCostDrift?: (info: {
    poolId: string;
    observedCostUsd: number;
    declaredCostPerMtok: number;
  }) => void;
}
