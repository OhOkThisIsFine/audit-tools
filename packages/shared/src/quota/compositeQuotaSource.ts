import type { QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import { LearnedQuotaSource } from "./learnedQuotaSource.js";
import { ClaudeOAuthQuotaSource } from "./claudeOAuthQuotaSource.js";
import { CodexQuotaSource } from "./codexQuotaSource.js";
import { RunLogger } from "../observability/runLog.js";

export interface BuildQuotaSourceOptions {
  halfLifeHours?: number;
  additionalSources?: QuotaSource[];
  runLogger?: RunLogger;
  /**
   * The proactive Claude-subscription source, consulted ahead of all others.
   * Defaults to a fresh {@link ClaudeOAuthQuotaSource}; pass `false` to disable
   * it (e.g. tests) or a stub to inject one.
   */
  claudeOAuth?: QuotaSource | false;
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
 * Order: proactive sources first (the Claude OAuth source, then any additional
 * provider sources), then the learned reactive source as the fallback.
 * CompositeQuotaSource skips throwing sources and returns the first snapshot.
 */
export function buildQuotaSource(options: BuildQuotaSourceOptions = {}): QuotaSource {
  const proactive: QuotaSource[] = [];
  if (options.claudeOAuth !== false) {
    proactive.push(options.claudeOAuth ?? new ClaudeOAuthQuotaSource());
  }
  // Each proactive source gates by provider name (returns null with no I/O for a
  // non-matching key), so registering all of them is safe: whichever provider's
  // pool is dispatched, the matching source answers, the rest pass through.
  proactive.push(new CodexQuotaSource());
  return new CompositeQuotaSource([
    ...proactive,
    ...(options.additionalSources ?? []),
    new LearnedQuotaSource(options.halfLifeHours ?? 24),
  ], options.runLogger);
}
