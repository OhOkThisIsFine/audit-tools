/**
 * Host-session fixed-window QuotaSource.
 *
 * Models a host *account* usage cap (e.g. Claude Code's "You've hit your session
 * limit · resets 3:30pm") as a fixed window that opens again at a stated reset.
 * Unlike the sliding-window learned source, the host session limit is a hard
 * wall the operator account hits — there is no per-request budget to learn, only
 * a binary "open / paused-until-reset" state plus a throttle band as the window
 * fills.
 *
 * Design contract (CP-BLOCK-IMPL-host-session-quota):
 *
 *  - **Channel isolation (CE-003).** A session limit is recorded ONLY from the
 *    worker ERROR / STATUS channel via {@link detectRateLimitFromChannel}. The
 *    consumed AuditResult content is never inspected, so a healthy result that
 *    merely quotes a limit string cannot pause the run.
 *  - **Throttle before the wall.** The snapshot exposes `remaining_pct` so the
 *    scheduler's existing LOW / CRITICAL bands throttle the wave BEFORE the
 *    account is fully exhausted, rather than only reacting after a hard 429.
 *  - **Auto-pause / auto-resume.** Recording a limit sets `cooldown_until` to the
 *    parsed reset (next-future-occurrence for clock times; DEFAULT_COOLDOWN_MS
 *    when unparseable). Once an injected `now` passes the reset the source
 *    auto-resumes (snapshot reports the window open again).
 *  - **Bounded re-limit escalation (no livelock).** Re-queuing the same packet
 *    non-consumingly is fine, but an unresettable / clock-skewed limit that keeps
 *    re-tripping for the SAME packet must not loop forever. After
 *    `maxConsecutiveReLimits` cycles (or a cumulative wall) the source ESCALATES
 *    to a terminal hard failure surfaced to the operator (structured stderr +
 *    run-ledger), and the caller stops re-queuing that packet.
 *  - **Own-provider self-monitoring only.** The source keys off the
 *    provider/model it owns; it never reasons about other providers' quota and
 *    never overwrites learned (sliding-window) limits.
 *
 * This module owns only the host-session window + escalation bookkeeping; the
 * non-consuming re-queue itself is performed by the rolling engine
 * ({@link dropProvider}), which moves in-flight packets back to `pending_tokens`
 * without ever marking them consumed.
 */

import type { QuotaProbeResult, QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import {
  DEFAULT_COOLDOWN_MS,
  detectRateLimitFromChannel,
  type WorkerOutputChannel,
} from "./errorParsing.js";

export const HOST_SESSION_QUOTA_SOURCE_NAME = "host_session";

/** Default number of consecutive non-consuming re-limits of the SAME packet before escalating. */
export const DEFAULT_MAX_CONSECUTIVE_RE_LIMITS = 3;

/** `remaining_pct` reported while the window is open and no limit has been seen. */
const WINDOW_OPEN_REMAINING_PCT = 1;
/** `remaining_pct` reported while the window is paused (limit active, before reset). */
const WINDOW_PAUSED_REMAINING_PCT = 0;

/** Injected clock — defaults to the system clock, overridable in tests. */
export type NowFn = () => number;

export interface HostSessionEscalation {
  /** Packet whose repeated re-limit tripped the bound. */
  packet_id: string;
  /** How many consecutive non-consuming re-limits were observed for it. */
  consecutive_re_limits: number;
  /** Cumulative wall (ms) spent paused on this packet across those cycles. */
  cumulative_wall_ms: number;
  /** Human-readable reason surfaced to the operator. */
  reason: string;
  /** ISO timestamp of the escalation. */
  escalated_at: string;
}

export interface HostSessionLimitEvent {
  /** Whether a session limit was recorded (false → input was not a session limit on this channel). */
  recorded: boolean;
  /** ISO cooldown the window is paused until, when recorded. */
  cooldown_until: string | null;
  /**
   * Set when this re-limit of the same packet crossed the bound. When non-null
   * the caller MUST stop re-queuing the packet and surface the escalation to the
   * operator instead of re-dispatching into the wall.
   */
  escalation: HostSessionEscalation | null;
}

export interface HostSessionQuotaSourceOptions {
  /** Provider/model key this source self-monitors (own-provider only). */
  providerModelKey: string;
  /** Injected clock for deterministic tests. */
  now?: NowFn;
  /** Cycles of consecutive same-packet re-limits tolerated before escalation. */
  maxConsecutiveReLimits?: number;
  /** Cumulative paused wall (ms) tolerated for one packet before escalation. */
  maxCumulativeWallMs?: number;
  /** Fallback cooldown when the reset is unparseable. */
  defaultCooldownMs?: number;
  /**
   * Sink for the structured operator surface (stderr + run-ledger). Defaults to
   * a single JSON line on stderr; tests inject a capture. Never throws — an
   * observability failure must not abort a dispatch run.
   */
  onEscalation?: (escalation: HostSessionEscalation) => void;
}

interface SamePacketTracker {
  packet_id: string;
  consecutive_re_limits: number;
  cumulative_wall_ms: number;
  /** Reset (ms epoch) most recently parsed for this packet's limit. */
  last_reset_ms: number;
}

function emitEscalationToStderr(escalation: HostSessionEscalation): void {
  try {
    process.stderr.write(
      JSON.stringify({
        ts: escalation.escalated_at,
        kind: "host_session_quota_escalation",
        packet_id: escalation.packet_id,
        consecutive_re_limits: escalation.consecutive_re_limits,
        cumulative_wall_ms: escalation.cumulative_wall_ms,
        reason: escalation.reason,
      }) + "\n",
    );
  } catch {
    // Observability must never abort a run.
  }
}

/**
 * Fixed-window host-session QuotaSource. Stateful: it remembers the active
 * cooldown and the per-packet re-limit count so the bounded-escalation guard can
 * fire. Conforms to the shared {@link QuotaSource} contract.
 */
export class HostSessionQuotaSource implements QuotaSource {
  readonly name = HOST_SESSION_QUOTA_SOURCE_NAME;

  private readonly providerModelKey: string;
  private readonly now: NowFn;
  private readonly maxConsecutiveReLimits: number;
  private readonly maxCumulativeWallMs: number | null;
  private readonly defaultCooldownMs: number;
  private readonly onEscalation: (escalation: HostSessionEscalation) => void;

  /** Epoch ms the window is paused until, or null when open. */
  private cooldownUntilMs: number | null = null;
  /** ISO captured-at of the most recent state mutation. */
  private capturedAt: string;
  /** Per-packet re-limit tracker (only the currently-relimiting packet matters). */
  private tracker: SamePacketTracker | null = null;
  /** Packets already escalated — a non-consuming re-queue must never re-arm them. */
  private readonly escalated = new Set<string>();

  constructor(options: HostSessionQuotaSourceOptions) {
    this.providerModelKey = options.providerModelKey;
    this.now = options.now ?? Date.now;
    this.maxConsecutiveReLimits =
      options.maxConsecutiveReLimits ?? DEFAULT_MAX_CONSECUTIVE_RE_LIMITS;
    this.maxCumulativeWallMs = options.maxCumulativeWallMs ?? null;
    this.defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.onEscalation = options.onEscalation ?? emitEscalationToStderr;
    this.capturedAt = new Date(this.now()).toISOString();
  }

  /**
   * True once an injected `now` has passed the recorded reset: the fixed window
   * has reopened and the source auto-resumes.
   */
  private isPaused(): boolean {
    if (this.cooldownUntilMs == null) return false;
    if (this.now() >= this.cooldownUntilMs) {
      // Auto-resume: window reopened, clear the pause + the re-limit tracker so
      // the next limit (a genuinely new exhaustion) starts a fresh count.
      this.cooldownUntilMs = null;
      this.tracker = null;
      return false;
    }
    return true;
  }

  /** ISO cooldown the window is currently paused until, or null when open. */
  cooldownUntil(): string | null {
    return this.isPaused() && this.cooldownUntilMs != null
      ? new Date(this.cooldownUntilMs).toISOString()
      : null;
  }

  /** True when the given packet has already been escalated to a terminal failure. */
  isEscalated(packetId: string): boolean {
    return this.escalated.has(packetId);
  }

  /**
   * Record a worker-output line for a packet. CHANNEL-ISOLATED: a session limit
   * is only ever recorded from the ERROR / STATUS channel; `result` text is
   * ignored entirely (CE-003), so a healthy result quoting a limit string is a
   * no-op (`recorded: false`, no pause).
   *
   * On a real limit it sets `cooldown_until` to the parsed reset and, if this is
   * the same packet re-limiting against an unchanged window, increments the
   * bounded counter — escalating once the bound is crossed.
   */
  recordLimit(
    channel: WorkerOutputChannel,
    text: string,
    packetId: string,
  ): HostSessionLimitEvent {
    const nowMs = this.now();
    const detection = detectRateLimitFromChannel(channel, text, nowMs);
    if (!detection.isRateLimited) {
      return { recorded: false, cooldown_until: null, escalation: null };
    }

    const cooldownMs =
      detection.retryAfterMs != null && detection.retryAfterMs > 0
        ? detection.retryAfterMs
        : this.defaultCooldownMs;
    const resetMs = nowMs + cooldownMs;

    // Track consecutive re-limits of the SAME packet. A re-limit is "the same"
    // when the same packet trips again before the window it last set has
    // reopened — i.e. an unresettable / clock-skewed wall, not normal progress.
    if (this.tracker && this.tracker.packet_id === packetId) {
      this.tracker.consecutive_re_limits += 1;
      this.tracker.cumulative_wall_ms += cooldownMs;
      this.tracker.last_reset_ms = resetMs;
    } else {
      this.tracker = {
        packet_id: packetId,
        consecutive_re_limits: 1,
        cumulative_wall_ms: cooldownMs,
        last_reset_ms: resetMs,
      };
    }

    this.cooldownUntilMs = resetMs;
    this.capturedAt = new Date(nowMs).toISOString();

    const overCycleBound =
      this.tracker.consecutive_re_limits > this.maxConsecutiveReLimits;
    const overWallBound =
      this.maxCumulativeWallMs != null &&
      this.tracker.cumulative_wall_ms > this.maxCumulativeWallMs;

    if (overCycleBound || overWallBound) {
      const escalation: HostSessionEscalation = {
        packet_id: packetId,
        consecutive_re_limits: this.tracker.consecutive_re_limits,
        cumulative_wall_ms: this.tracker.cumulative_wall_ms,
        reason: overCycleBound
          ? `Host session limit re-tripped ${this.tracker.consecutive_re_limits} times for the same packet ` +
            `(bound ${this.maxConsecutiveReLimits}); the reset is not clearing — escalating to operator instead of livelocking.`
          : `Host session limit held the same packet paused for ${this.tracker.cumulative_wall_ms}ms cumulative ` +
            `(bound ${this.maxCumulativeWallMs}ms); escalating to operator instead of livelocking.`,
        escalated_at: new Date(nowMs).toISOString(),
      };
      this.escalated.add(packetId);
      this.tracker = null;
      this.onEscalation(escalation);
      return {
        recorded: true,
        cooldown_until: new Date(resetMs).toISOString(),
        escalation,
      };
    }

    return {
      recorded: true,
      cooldown_until: new Date(resetMs).toISOString(),
      escalation: null,
    };
  }

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    return (await this.probeUsage(providerModelKey)).snapshot;
  }

  /**
   * Own-provider self-monitoring: only answers for the key it owns. For any other
   * key it is `not_applicable` (no signal expected → never a degrade), so it
   * composes with the sliding-window / learned sources without overwriting them.
   */
  async probeUsage(providerModelKey: string): Promise<QuotaProbeResult> {
    if (providerModelKey !== this.providerModelKey) {
      return { snapshot: null, status: "not_applicable" };
    }

    const paused = this.isPaused();
    const snapshot: QuotaUsageSnapshot = {
      remaining_pct: paused ? WINDOW_PAUSED_REMAINING_PCT : WINDOW_OPEN_REMAINING_PCT,
      reset_at: paused && this.cooldownUntilMs != null
        ? new Date(this.cooldownUntilMs).toISOString()
        : null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: this.capturedAt,
      source: this.name,
    };
    return { snapshot, status: "ok" };
  }
}
