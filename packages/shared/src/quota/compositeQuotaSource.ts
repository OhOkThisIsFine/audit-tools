import type { QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import { LearnedQuotaSource } from "./learnedQuotaSource.js";

export interface BuildQuotaSourceOptions {
  halfLifeHours?: number;
  additionalSources?: QuotaSource[];
}

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

/**
 * Builds the standard runtime quota snapshot cascade.
 *
 * Order: provider/additional sources first, then the learned reactive source.
 * CompositeQuotaSource skips throwing sources and returns the first snapshot.
 */
export function buildQuotaSource(options: BuildQuotaSourceOptions = {}): QuotaSource {
  return new CompositeQuotaSource([
    ...(options.additionalSources ?? []),
    new LearnedQuotaSource(options.halfLifeHours ?? 24),
  ]);
}
