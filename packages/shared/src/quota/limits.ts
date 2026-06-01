import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { LimitConfidence, LimitSource, ResolvedLimits } from "./types.js";
import { lookupModelLimits } from "../tokens.js";

export type ProviderType = "hosted" | "local" | "unknown";

export function classifyProvider(providerName: ResolvedProviderName): ProviderType {
  switch (providerName) {
    case "claude-code":
      return "hosted";
    case "opencode":
    case "local-subprocess":
      return "local";
    case "subprocess-template":
    case "vscode-task":
    default:
      return "unknown";
  }
}

export function lookupKnownModel(
  modelKey: string,
): Pick<ResolvedLimits, "context_tokens" | "output_tokens"> | undefined {
  return lookupModelLimits(modelKey);
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
}

function defaultLimits(sessionConfig: SessionConfig): ResolvedLimits {
  const quota = sessionConfig.quota ?? {};
  return {
    context_tokens: quota.default_context_tokens ?? 32_000,
    output_tokens: quota.reserved_output_tokens ?? 4_096,
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
  // 2. Static known-model metadata
  // 3. Conservative provider-typed default
  // 4. Generic default fallback
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

  // 2. Static known-model database (context/output only; RPM/TPM from learning)
  if (hostModel) {
    const known = lookupKnownModel(hostModel);
    if (known) {
      return {
        limits: {
          context_tokens: known.context_tokens,
          output_tokens: known.output_tokens,
          requests_per_minute: null,
          input_tokens_per_minute: null,
          output_tokens_per_minute: null,
        },
        source: "known_metadata",
        confidence: "medium",
      };
    }
  }

  // 3. Conservative provider defaults. Concurrency caps remain in the scheduler;
  // this rung records that the provider was part of limit resolution.
  const providerType = classifyProvider(providerName);
  if (providerType !== "unknown") {
    return { limits: defaults, source: "provider_default", confidence: "low" };
  }

  // 4. Conservative defaults for all unknown provider types
  return { limits: defaults, source: "default", confidence: "low" };
}
