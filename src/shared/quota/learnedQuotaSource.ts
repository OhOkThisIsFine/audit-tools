import type { QuotaProbeResult, QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import { readQuotaState, computeMaxSafeConcurrency } from "./state.js";

export class LearnedQuotaSource implements QuotaSource {
  readonly name = "learned";

  private halfLifeHours: number;

  constructor(halfLifeHours = 24) {
    this.halfLifeHours = halfLifeHours;
  }

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    return (await this.probeUsage(providerModelKey)).snapshot;
  }

  /**
   * No learned entry yet is `not_applicable`, never `degraded`: the learned
   * source is the reactive fallback, so the absence of history is the normal
   * cold-start state, not a lost signal.
   */
  async probeUsage(providerModelKey: string): Promise<QuotaProbeResult> {
    const state = await readQuotaState();
    const entry = state.entries[providerModelKey];
    if (!entry) return { snapshot: null, status: "not_applicable" };

    const maxSafe = computeMaxSafeConcurrency(entry, this.halfLifeHours);
    const isInCooldown =
      entry.cooldown_until != null &&
      new Date(entry.cooldown_until).getTime() > Date.now();

    return {
      snapshot: {
        remaining_pct: isInCooldown ? 0 : null,
        reset_at: isInCooldown ? entry.cooldown_until : null,
        requests_remaining: maxSafe,
        tokens_remaining: null,
        captured_at: entry.updated_at,
        source: "learned",
      },
      status: "ok",
    };
  }
}
