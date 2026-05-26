import type { QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";

export class CompositeQuotaSource implements QuotaSource {
  readonly name = "composite";
  private sources: QuotaSource[];

  constructor(sources: QuotaSource[]) {
    this.sources = sources;
  }

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    for (const source of this.sources) {
      try {
        const snapshot = await source.queryCurrentUsage(providerModelKey);
        if (snapshot) return snapshot;
      } catch {
        // Skip failing sources, try next
      }
    }
    return null;
  }
}
