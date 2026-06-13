import type { QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import { LearnedQuotaSource } from "./learnedQuotaSource.js";
import { RunLogger } from "../observability/runLog.js";

export interface BuildQuotaSourceOptions {
  halfLifeHours?: number;
  additionalSources?: QuotaSource[];
  runLogger?: RunLogger;
}

export class CompositeQuotaSource implements QuotaSource {
  readonly name = "composite";
  private sources: QuotaSource[];
  private runLogger: RunLogger;

  constructor(sources: QuotaSource[], runLogger?: RunLogger) {
    this.sources = sources;
    this.runLogger = runLogger ?? RunLogger.disabled();
  }

  async queryCurrentUsage(providerModelKey: string): Promise<QuotaUsageSnapshot | null> {
    for (const source of this.sources) {
      try {
        const snapshot = await source.queryCurrentUsage(providerModelKey);
        if (snapshot) return snapshot;
      } catch (err) {
        // Skip failing sources, try next — but surface the failure so operators
        // can detect a persistently failing quota source.
        this.runLogger.event({
          kind: "error",
          phase: "quota",
          note: `quota source '${source.name}' threw querying ${providerModelKey}: ${err instanceof Error ? err.message : String(err)}`,
        });
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
  ], options.runLogger);
}
