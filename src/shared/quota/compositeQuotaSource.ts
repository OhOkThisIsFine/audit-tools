import type { QuotaProbeResult, QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import { LearnedQuotaSource } from "./learnedQuotaSource.js";
import { ClaudeOAuthQuotaSource } from "./claudeOAuthQuotaSource.js";
import { CodexQuotaSource } from "./codexQuotaSource.js";
import { CopilotQuotaSource } from "./copilotQuotaSource.js";
import { AntigravityQuotaSource } from "./antigravityQuotaSource.js";
import { OpenCodeQuotaSource } from "./openCodeQuotaSource.js";
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
    return (await this.probeUsage(providerModelKey)).snapshot;
  }

  /**
   * Probe the cascade with an aggregate status: the first source that returns a
   * snapshot wins (`ok`); otherwise the result is `degraded` when any source
   * that handles this provider was queried and silently degraded (or threw), and
   * `not_applicable` only when no source ever applied. This is what lets a pool
   * record that a live quota reading was expected but lost, instead of treating
   * every empty cascade as "no source configured".
   */
  async probeUsage(providerModelKey: string): Promise<QuotaProbeResult> {
    let sawDegraded = false;
    for (const source of this.sources) {
      try {
        // Invoke the source directly (not via the swallowing `probeQuotaSource`)
        // so a throw propagates to the catch below, where it is BOTH logged and
        // counted as a degrade — preserving the operator-visible failure event.
        let result: QuotaProbeResult;
        if (source.probeUsage) {
          result = await source.probeUsage(providerModelKey);
        } else {
          // A bare `queryCurrentUsage` source can't distinguish a silent degrade
          // from a non-match, so a null result is `not_applicable`; a throw falls
          // through to the catch and is recorded as a degrade there.
          const snapshot = await source.queryCurrentUsage(providerModelKey);
          result = { snapshot, status: snapshot ? "ok" : "not_applicable" };
        }
        if (result.snapshot) return result;
        if (result.status === "degraded") sawDegraded = true;
      } catch (err) {
        // A throw is a degrade for that source — surface it so operators can
        // detect a persistently failing quota source, then try the next one.
        sawDegraded = true;
        this.runLogger.event({
          kind: "error",
          phase: "quota",
          note: `quota source '${source.name}' threw querying ${providerModelKey}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return { snapshot: null, status: sawDegraded ? "degraded" : "not_applicable" };
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
  proactive.push(
    new CodexQuotaSource(),
    new CopilotQuotaSource(),
    new AntigravityQuotaSource(),
    new OpenCodeQuotaSource(),
  );
  return new CompositeQuotaSource([
    ...proactive,
    ...(options.additionalSources ?? []),
    new LearnedQuotaSource(options.halfLifeHours ?? 24),
  ], options.runLogger);
}
