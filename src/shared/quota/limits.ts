import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { LimitConfidence, LimitSource, ResolvedLimits } from "./types.js";
import type { DiscoveredRateLimitsInput } from "./scheduler.js";
import { resolveModelStatics } from "./modelStatics.js";

export type ProviderType = "hosted" | "local" | "unknown";

/**
 * Map a provider to its relative host-class — the coarse capability tier used by
 * limit resolution and the broker's single classifier ({@link classifyProvider}
 * in `scheduler.ts`). This is the *bare* class mapping only; the resolved
 * cold-start / agent-host concurrency floor is NOT exposed here as a separable
 * constant — it lives solely on the `classifyProvider` struct's `concurrencyFloor`
 * (INV-BROKER-CLASSIFY-SINGLE-SOURCE / CE-005). Kept in this module (rather than
 * `scheduler.ts`) so `resolveLimits` can consult the class without importing the
 * scheduler, preserving the one-directional scheduler→limits dependency.
 */
export function hostClassFor(providerName: ResolvedProviderName): ProviderType {
  switch (providerName) {
    case "claude-code":
    case "codex":
    case "agy":
      // codex/agy are hosted model backends — engages hosted concurrency defaults +
      // learned-limits, same as claude-code.
      return "hosted";
    case "opencode":
    case "worker-command":
      return "local";
    case "subprocess-template":
    case "vscode-task":
    case "antigravity":
    default:
      // antigravity (like vscode-task/subprocess-template) is command-template-
      // driven and its underlying model is operator-chosen, so it classifies per
      // its configured model — unknown until a model is configured.
      return "unknown";
  }
}

export interface ResolveHostModelOptions {
  providerName: ResolvedProviderName;
  sessionConfig: SessionConfig;
  /** Explicit model (e.g. from a CLI flag); highest precedence. */
  explicitModel?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Env var consulted for a model hint (e.g. "AUDIT_CODE_HOST_MODEL"). */
  envVar?: string;
}

// Resolve the host model so per-model quota detection can engage. Precedence:
// explicit override → session-config (block_quota.host_model) → env hint →
// null (genuinely unknown — no hardcoded per-provider model). A null model is
// expected: quota learning keys on `provider/*` and the dispatch-time capability
// handshake supplies the real window.
export function resolveHostModel(options: ResolveHostModelOptions): string | null {
  const {
    sessionConfig,
    explicitModel,
    env = process.env,
    envVar,
  } = options;
  const clean = (value: string | null | undefined): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  return (
    clean(explicitModel) ??
    clean(sessionConfig.block_quota?.host_model) ??
    (envVar ? clean(env[envVar]) : null) ??
    null
  );
}

export interface LimitResolutionResult {
  limits: ResolvedLimits;
  source: LimitSource;
  confidence: LimitConfidence;
}

export interface ResolveLimitsOptions {
  providerName: ResolvedProviderName;
  sessionConfig: SessionConfig;
  hostModel?: string | null;
  /**
   * Capabilities discovered at the dispatch-time handshake. When this carries a
   * `context_tokens`, it is the dispatching model's real window and outranks the
   * static known-model table (but not an explicit per-model config override).
   */
  discoveredLimits?: DiscoveredRateLimitsInput | null;
}

function defaultLimits(sessionConfig: SessionConfig): ResolvedLimits {
  const quota = sessionConfig.quota ?? {};
  return {
    context_tokens: positiveIntegerOrNull(quota.default_context_tokens),
    output_tokens: positiveIntegerOrNull(quota.reserved_output_tokens),
    requests_per_minute: null,
    input_tokens_per_minute: null,
    output_tokens_per_minute: null,
  };
}

function positiveIntegerOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function outputLimitBelowContext(
  value: number | null | undefined,
  contextTokens: number,
): number | null {
  const outputTokens = positiveIntegerOrNull(value);
  return outputTokens !== null && outputTokens < contextTokens
    ? outputTokens
    : null;
}

export function resolveLimits(options: ResolveLimitsOptions): LimitResolutionResult {
  const { providerName, sessionConfig, hostModel } = options;
  const quota = sessionConfig.quota ?? {};
  const defaults = defaultLimits(sessionConfig);

  // Resolution order:
  // 1. Explicit per-model config overrides
  // 2. Discovered capability from the dispatch-time handshake
  // 3. Static metadata from the vendored models.dev snapshot (dataset fallback)
  // 4. Explicit operator-wide defaults, if declared
  // 5. Unknown (null), never a guessed window
  // (No hardcoded model table — the static rung is a community dataset consumed
  // with degrade-to-empty semantics, and it ALWAYS ranks below real discovery.)
  if (hostModel && quota.models?.[hostModel]) {
    const override = quota.models[hostModel];
    return {
      limits: {
        context_tokens: override.context_tokens ?? defaults.context_tokens,
        output_tokens: override.output_tokens ?? defaults.output_tokens,
        requests_per_minute: override.requests_per_minute ?? null,
        input_tokens_per_minute: override.input_tokens_per_minute ?? null,
        output_tokens_per_minute: override.output_tokens_per_minute ?? null,
      },
      source: "explicit_config",
      confidence: "high",
    };
  }

  const staticStatics = hostModel ? resolveModelStatics(hostModel) : undefined;

  // 1.5 Discovered capability: the host reported this model's real window at the
  // dispatch handshake. Outranks the static table — it is how dispatch sizes to
  // the real model (e.g. 200k) instead of an unknown window.
  const discoveredContext = options.discoveredLimits?.context_tokens;
  if (typeof discoveredContext === "number" && discoveredContext > 0) {
    // Respect the discovered context as the real ceiling. Fill a missing/invalid
    // output cap only from lower-priority authoritative metadata or an explicit
    // operator default that still fits below that ceiling; otherwise keep it
    // unknown. No rung fabricates a reservation.
    const discoveredOutput = options.discoveredLimits?.output_tokens;
    const usableOutput =
      outputLimitBelowContext(discoveredOutput, discoveredContext) ??
      outputLimitBelowContext(staticStatics?.output_tokens, discoveredContext) ??
      outputLimitBelowContext(defaults.output_tokens, discoveredContext);
    return {
      limits: {
        context_tokens: discoveredContext,
        output_tokens: usableOutput,
        requests_per_minute: options.discoveredLimits?.requests_per_minute ?? null,
        input_tokens_per_minute: options.discoveredLimits?.input_tokens_per_minute ?? null,
        output_tokens_per_minute: options.discoveredLimits?.output_tokens_per_minute ?? null,
      },
      source: "discovered_capability",
      confidence: "high",
    };
  }

  // 2.5 Static metadata: no real window was discovered, so consult the vendored
  // models.dev snapshot for this model's real context window instead of leaving
  // it unknown. Degrades to empty (falls through)
  // on an unknown model id or an unavailable dataset.
  if (staticStatics && typeof staticStatics.context_tokens === "number" && staticStatics.context_tokens > 0) {
    return {
      limits: {
        context_tokens: staticStatics.context_tokens,
        output_tokens:
          positiveIntegerOrNull(staticStatics.output_tokens) ?? defaults.output_tokens,
        requests_per_minute: null,
        input_tokens_per_minute: null,
        output_tokens_per_minute: null,
      },
      source: "static_metadata",
      confidence: "medium",
    };
  }

  // 3. Operator-wide defaults. Concurrency caps remain in the scheduler; this
  // rung records provider classification even when both window fields are null.
  const providerType = hostClassFor(providerName);
  if (providerType !== "unknown") {
    return { limits: defaults, source: "provider_default", confidence: "low" };
  }

  // 4. Operator-wide defaults for unknown provider types (possibly all null).
  return { limits: defaults, source: "default", confidence: "low" };
}
