import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { LimitConfidence, LimitSource, ResolvedLimits } from "./types.js";
import type { DiscoveredRateLimitsInput } from "./scheduler.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_OUTPUT_TOKENS } from "../tokens.js";
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
      // codex is a hosted model backend — engages hosted concurrency defaults +
      // learned-limits, same as claude-code.
      return "hosted";
    case "opencode":
    case "local-subprocess":
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
    context_tokens: quota.default_context_tokens ?? DEFAULT_CONTEXT_TOKENS,
    output_tokens: quota.reserved_output_tokens ?? DEFAULT_OUTPUT_TOKENS,
    requests_per_minute: null,
    input_tokens_per_minute: null,
    output_tokens_per_minute: null,
  };
}

export function resolveLimits(options: ResolveLimitsOptions): LimitResolutionResult {
  const { providerName, sessionConfig, hostModel } = options;
  const quota = sessionConfig.quota ?? {};
  const defaults = defaultLimits(sessionConfig);

  // Resolution order:
  // 1. Explicit per-model config overrides
  // 2. Discovered capability from the dispatch-time handshake
  // 3. Static metadata from the vendored models.dev snapshot (dataset fallback)
  // 4. Conservative provider-typed default
  // 5. Generic default fallback
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

  // 1.5 Discovered capability: the host reported this model's real window at the
  // dispatch handshake. Outranks the static table — it is how dispatch sizes to
  // the real model (e.g. 200k) instead of the conservative default.
  const discoveredContext = options.discoveredLimits?.context_tokens;
  if (typeof discoveredContext === "number" && discoveredContext > 0) {
    return {
      limits: {
        context_tokens: discoveredContext,
        output_tokens: options.discoveredLimits?.output_tokens ?? defaults.output_tokens,
        requests_per_minute: options.discoveredLimits?.requests_per_minute ?? null,
        input_tokens_per_minute: options.discoveredLimits?.input_tokens_per_minute ?? null,
        output_tokens_per_minute: options.discoveredLimits?.output_tokens_per_minute ?? null,
      },
      source: "discovered_capability",
      confidence: "high",
    };
  }

  // 2.5 Static metadata: no real window was discovered, so consult the vendored
  // models.dev snapshot for this model's real context window instead of falling
  // straight to the flat conservative default. Degrades to empty (falls through)
  // on an unknown model id or an unavailable dataset.
  const staticStatics = hostModel ? resolveModelStatics(hostModel) : undefined;
  if (staticStatics && typeof staticStatics.context_tokens === "number" && staticStatics.context_tokens > 0) {
    return {
      limits: {
        context_tokens: staticStatics.context_tokens,
        output_tokens: staticStatics.output_tokens ?? defaults.output_tokens,
        requests_per_minute: null,
        input_tokens_per_minute: null,
        output_tokens_per_minute: null,
      },
      source: "static_metadata",
      confidence: "medium",
    };
  }

  // 3. Conservative provider defaults. Concurrency caps remain in the scheduler;
  // this rung records that the provider was part of limit resolution.
  const providerType = hostClassFor(providerName);
  if (providerType !== "unknown") {
    return { limits: defaults, source: "provider_default", confidence: "low" };
  }

  // 4. Conservative defaults for all unknown provider types
  return { limits: defaults, source: "default", confidence: "low" };
}
