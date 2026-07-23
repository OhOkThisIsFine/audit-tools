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

import type { StampedEngineDecisionRecord } from "../dispatch/dispatchDecisionLog.js";

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
  outcome:
    | "success"
    | "rate_limited"
    | "timeout"
    | "error"
    | "credit_exhausted"
    | "model_unavailable"
    | "packet_too_large"
    | "quota_unclassified";
  actualTokens?: number;
  error?: unknown;
  /**
   * Worker ERROR/STATUS channel evidence that classified a `rate_limited`
   * outcome, carried so a consumer's `recordRateLimit` hook can feed a
   * channel-isolated host-session source (CE-003). Absent on non-rate_limited
   * outcomes.
   */
  rateLimit?: { channel: "error" | "status" | "result"; text: string };
  /**
   * Worker ERROR/STATUS channel evidence that classified a `credit_exhausted`
   * outcome (out of prepaid usage credits — no reset timer, unlike `rateLimit`
   * above). Absent on non-credit_exhausted outcomes.
   */
  creditExhaustion?: { channel: "error" | "status" | "result"; text: string; rawMatch: string | null };
  /**
   * Worker ERROR/STATUS channel evidence that classified a `model_unavailable`
   * outcome (HTTP 404, model not found — permanent pool exclusion). Absent on
   * non-model_unavailable outcomes.
   */
  modelUnavailable?: { channel: "error" | "status" | "result"; text: string; rawMatch: string | null };
  /**
   * Worker ERROR/STATUS channel evidence that classified a `packet_too_large`
   * outcome (HTTP 413, request/payload too large — per-packet sizing fault).
   * Absent on non-packet_too_large outcomes.
   */
  packetTooLarge?: { channel: "error" | "status" | "result"; text: string; rawMatch: string | null };
  /**
   * Worker ERROR/STATUS channel VERBATIM evidence that classified a
   * `quota_unclassified` outcome (Slice A2b, TIER 2): the broad
   * `detectQuotaSuspicious` pre-filter matched but neither `credit_exhausted`
   * nor `rate_limited` did. Carried so the consumer's `onQuotaUnclassified` hook
   * can harvest the verbatim (secret-scrubbed at the sink) text for pattern
   * improvement. Absent on other outcomes.
   */
  quotaUnclassified?: { channel: "error" | "status" | "result"; text: string };
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
  /**
   * Credit exhaustion (out-of-prepaid-usage-credits — no reset timer, unlike a
   * 429): invoked every time a `credit_exhausted` result lands, after the engine
   * has already permanently excluded the pool from this run's admissible set.
   * The consumer wires it to friction emission. Optional — omit to leave the
   * exclusion silent (no friction, exclusion still happens).
   */
  onCreditExhausted?: (info: { poolId: string; rawMatch: string | null }) => void;
  /**
   * Quota-unclassified harvest (Slice A2b, TIER 2): invoked every time a
   * `quota_unclassified` result lands — a worker death whose text was
   * quota-SUSPICIOUS (the broad pre-filter matched) but matched neither the
   * precise `credit_exhausted` nor `rate_limited` class. The engine has already
   * degraded CONSERVATIVELY by the time this fires (re-queued with a reversible
   * cooldown; the pool is NEVER permanently excluded on this guess — see
   * `rollingDispatch.ts`). The consumer wires it to friction emission carrying
   * the verbatim text, so an operator can classify it and improve the pattern
   * set. Optional — omit to leave the degrade silent (no friction, degrade still
   * happens).
   */
  onQuotaUnclassified?: (info: { poolId: string; text: string }) => void;
  /**
   * Model-unavailable exclusion (HTTP 404 class — the model is not served by
   * this provider; availability analog of cost drift): invoked once per pool
   * the first time a `model_unavailable` result lands, after the engine has
   * already permanently excluded the pool from this run's admissible set. The
   * consumer wires it to friction emission. Optional — omit to leave the
   * exclusion silent (no friction, exclusion still happens).
   */
  onModelUnavailable?: (info: { poolId: string; rawMatch: string | null }) => void;
  /**
   * Packet-too-large (HTTP 413 class — a per-packet sizing fault): invoked once
   * per (packet, pool) pair, after the engine has already recorded the
   * per-packet pool skip (the pool is NOT excluded and no cooldown applies).
   * The consumer wires it to friction emission. Optional — omit to leave the
   * skip silent (no friction, skip still happens).
   */
  onPacketTooLarge?: (info: { poolId: string; packetId: string; rawMatch: string | null }) => void;
  /**
   * Engine decision-record sink (legibility invariant, spec Resolved decision
   * 3): receives every stamped per-packet admission decision (admit / ledger
   * block / strand). The consumer wires it to the run dir's append-only
   * `dispatch-explains.jsonl` via `createDispatchDecisionLog`. Optional — omit
   * and the engine writes the records to stderr instead (emission, never
   * silence).
   */
  onAdmissionDecision?: (record: StampedEngineDecisionRecord) => void;
}
