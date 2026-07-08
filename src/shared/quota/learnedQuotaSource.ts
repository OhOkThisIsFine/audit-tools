import type { QuotaProbeResult, QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import type { QuotaState } from "./types.js";
import { readQuotaState } from "./state.js";

/**
 * The reactive quota source: it reports what the last 429 taught us about a pool —
 * whether it is in cooldown, and until when. It reports no `requests_remaining`:
 * concurrency is DECLARED by the provider or ABSENT, never inferred from an
 * outcome stream, so there is no learned concurrency to surface here.
 */
export class LearnedQuotaSource implements QuotaSource {
  readonly name = "learned";

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    return (await this.probeUsage(providerModelKey)).snapshot;
  }

  /**
   * No learned entry yet is `not_applicable`, never `degraded`: the learned
   * source is the reactive fallback, so the absence of history is the normal
   * cold-start state, not a lost signal. An UNUSABLE state file is the opposite
   * — evidence we had is now unreadable — so it reports `degraded`, never
   * `not_applicable`.
   */
  async probeUsage(providerModelKey: string): Promise<QuotaProbeResult> {
    let state: QuotaState;
    try {
      state = await readQuotaState();
    } catch {
      return { snapshot: null, status: "degraded" };
    }
    const entry = state.entries[providerModelKey];
    if (!entry) return { snapshot: null, status: "not_applicable" };

    const isInCooldown =
      entry.cooldown_until != null &&
      new Date(entry.cooldown_until).getTime() > Date.now();

    return {
      snapshot: {
        remaining_pct: isInCooldown ? 0 : null,
        reset_at: isInCooldown ? entry.cooldown_until : null,
        requests_remaining: null,
        tokens_remaining: null,
        captured_at: entry.updated_at,
        source: "learned",
      },
      status: "ok",
    };
  }
}
