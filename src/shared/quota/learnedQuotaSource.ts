import type { QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import { readQuotaState, computeMaxSafeConcurrency } from "./state.js";

export class LearnedQuotaSource implements QuotaSource {
  readonly name = "learned";

  private halfLifeHours: number;

  constructor(halfLifeHours = 24) {
    this.halfLifeHours = halfLifeHours;
  }

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    const state = await readQuotaState();
    const entry = state.entries[providerModelKey];
    if (!entry) return null;

    const maxSafe = computeMaxSafeConcurrency(entry, this.halfLifeHours);
    const isInCooldown =
      entry.cooldown_until != null &&
      new Date(entry.cooldown_until).getTime() > Date.now();

    return {
      remaining_pct: isInCooldown ? 0 : null,
      reset_at: isInCooldown ? entry.cooldown_until : null,
      requests_remaining: maxSafe,
      tokens_remaining: null,
      captured_at: entry.updated_at,
      source: "learned",
    };
  }
}
