import type { QuotaProbeResult, QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
import { resolveAccountIdSafe } from "./quotaSource.js";
import { LearnedQuotaSource } from "./learnedQuotaSource.js";
import { ClaudeOAuthQuotaSource } from "./claudeOAuthQuotaSource.js";
import { CodexQuotaSource } from "./codexQuotaSource.js";
import { CopilotQuotaSource } from "./copilotQuotaSource.js";
import { AntigravityQuotaSource } from "./antigravityQuotaSource.js";
import { OpenCodeQuotaSource } from "./openCodeQuotaSource.js";
import { RunLogger } from "../observability/runLog.js";

export interface BuildQuotaSourceOptions {
  additionalSources?: QuotaSource[];
  runLogger?: RunLogger;
  /**
   * The proactive Claude-subscription source, consulted ahead of all others.
   * Defaults to a fresh {@link ClaudeOAuthQuotaSource}; pass `false` to disable
   * it (e.g. tests) or a stub to inject one.
   */
  claudeOAuth?: QuotaSource | false;
  /**
   * The host-session fixed-window source ({@link HostSessionQuotaSource}),
   * PREPENDED ahead of every proactive source so it answers FIRST for the
   * provider/model key it owns (own-key precedence via its exact
   * `providerModelKey` gate — it returns `not_applicable`, passing through, for
   * any other key, and `not_applicable` for its own key while the window is open
   * with no limit known). This wires the operator's account-level session wall in
   * as a first-class PRE-WALL source: its graduated `remaining_pct` lets the
   * scheduler's LOW / CRITICAL bands throttle BEFORE a hard 429, and its paused
   * snapshot folds a cooldown in. Omit (default) to leave it unwired. [CE-001/CE-002]
   */
  hostSession?: QuotaSource;
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

  /**
   * Resolve the account id from the first source in the cascade that handles this
   * provider and yields one (each source returns null for a provider it doesn't
   * own). Never throws — a failing source is skipped so account resolution degrades
   * to null rather than aborting pool construction.
   */
  async resolveAccountId(providerModelKey: string): Promise<string | null> {
    for (const source of this.sources) {
      const account = await resolveAccountIdSafe(source, providerModelKey);
      if (account) return account;
    }
    return null;
  }

  /** Proactive coverage if ANY source in the cascade covers the provider. */
  coversProvider(provider: string): boolean {
    return this.sources.some((s) => s.coversProvider?.(provider) ?? false);
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
  // The host-session source is PREPENDED before every proactive source: it owns
  // its exact provider/model key (exact-key gate, not coversProvider), so it
  // answers first for that key and passes through for all others — never masking
  // the proactive/learned sources. [CE-001/CE-002]
  if (options.hostSession) {
    proactive.push(options.hostSession);
  }
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
    new LearnedQuotaSource(),
  ], options.runLogger);
}

/**
 * A quota source scoped to ONE dispatch source's own credential, for a source that
 * authenticates as a different account than the host (its `credentials_path`). The
 * returned source probes usage + resolves the account id from THAT file, so the
 * source forms a pool keyed on its own `(provider, account)` — a distinct budget
 * from the host's same-provider pool (docs/quota-dispatch-design.md §5b). Falls back
 * to the shared source when no per-source credential is declared, or the provider has
 * no per-account proactive endpoint (only Claude/Codex expose one).
 */
export function buildAccountScopedQuotaSource(
  source: { provider: string; credentials_path?: string },
  fallback: QuotaSource,
): QuotaSource {
  const credentialsPath = source.credentials_path;
  if (!credentialsPath) return fallback;
  switch (source.provider) {
    case "claude":
    case "claude-code":
      return new ClaudeOAuthQuotaSource({ credentialsPath });
    case "codex":
      return new CodexQuotaSource({ credentialsPath });
    default:
      return fallback;
  }
}
