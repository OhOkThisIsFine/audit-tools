import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { LimitConfidence, LimitSource, ResolvedLimits } from "./types.js";
import { lookupModelLimits } from "../tokens.js";

export type ProviderType = "hosted" | "local" | "unknown";

export function classifyProvider(providerName: ResolvedProviderName): ProviderType {
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

// Default parallel wave size for agent-host providers when nothing else
// constrains concurrency (no host-reported cap, no learned history, no RPM/TPM,
// no explicit config). These providers delegate to a host that runs fresh
// subagent sessions in parallel — each with its own context window — so
// collapsing to serial dispatch (the old default of 1) is pathological for the
// conversation-first flow. The host's own reported cap still binds at dispatch
// time, and an explicit quota.unknown_hosted_concurrency still overrides this.
export const DEFAULT_AGENT_HOST_CONCURRENCY = 8;

// claude-code / vscode-task fall through the hosted/unknown fallback branch but
// are parallel agent hosts, so they default to parallel dispatch rather than 1.
// (opencode also fans out but is classified "local" and uses the local path.)
export function agentHostFallbackConcurrency(
  providerName: ResolvedProviderName,
): number {
  return providerName === "claude-code" || providerName === "vscode-task"
    ? DEFAULT_AGENT_HOST_CONCURRENCY
    : 1;
}

// Per-provider default host model, used when no explicit model is configured or
// detected. Lets per-model quota detection engage with realistic limits (Claude
// models are 200k context) instead of the conservative unknown-model floor.
const PROVIDER_DEFAULT_HOST_MODEL: Partial<Record<ResolvedProviderName, string>> = {
  "claude-code": "anthropic/claude-opus-4-8",
};

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
// per-provider default for a known agent host → null (genuinely unknown).
export function resolveHostModel(options: ResolveHostModelOptions): string | null {
  const {
    providerName,
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
    PROVIDER_DEFAULT_HOST_MODEL[providerName] ??
    null
  );
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
