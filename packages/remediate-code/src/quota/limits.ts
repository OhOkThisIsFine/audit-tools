import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { LimitConfidence, LimitSource, ResolvedLimits } from "./types.js";

const KNOWN_MODEL_LIMITS: Record<string, Pick<ResolvedLimits, "context_tokens" | "output_tokens">> = {
  "anthropic/claude-opus-4-7": { context_tokens: 200_000, output_tokens: 32_000 },
  "anthropic/claude-sonnet-4-6": { context_tokens: 200_000, output_tokens: 8_192 },
  "anthropic/claude-haiku-4-5": { context_tokens: 200_000, output_tokens: 8_192 },
  "anthropic/claude-opus-4-5": { context_tokens: 200_000, output_tokens: 8_192 },
  "anthropic/claude-sonnet-4-5": { context_tokens: 200_000, output_tokens: 8_192 },
  "openai/gpt-4o": { context_tokens: 128_000, output_tokens: 16_384 },
  "openai/gpt-4o-mini": { context_tokens: 128_000, output_tokens: 16_384 },
  "google/gemini-2.0-flash": { context_tokens: 1_048_576, output_tokens: 8_192 },
  "google/gemini-1.5-pro": { context_tokens: 2_097_152, output_tokens: 8_192 },
};

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
  return KNOWN_MODEL_LIMITS[modelKey.toLowerCase().trim()];
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
  const { providerName: _providerName, sessionConfig, hostModel } = options;
  const quota = sessionConfig.quota ?? {};
  const defaults = defaultLimits(sessionConfig);

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

  return { limits: defaults, source: "default", confidence: "low" };
}
