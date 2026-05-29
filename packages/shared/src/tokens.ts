// Canonical token-budget arithmetic shared by both orchestrators.
//
// Before Phase 0 each package carried its own copy of the model-limits table
// and a per-line token estimator (auditor `reviewPackets.ts`, remediator
// `plan.ts`). This module is the single source of truth for:
//   - the known-model context/output limits,
//   - the byte- and line-based token estimators,
//   - the default budgets and safety margin used when sizing work blocks.

export interface ModelTokenLimits {
  context_tokens: number;
  output_tokens: number;
}

// Known-model context/output limits. RPM/TPM are tier-dependent and must come
// from learning, so they are intentionally omitted here (see quota/limits.ts).
export const KNOWN_MODEL_LIMITS: Record<string, ModelTokenLimits> = {
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

/** Case-insensitive lookup of a known model's context/output limits. */
export function lookupModelLimits(modelKey: string): ModelTokenLimits | undefined {
  return KNOWN_MODEL_LIMITS[modelKey.toLowerCase().trim()];
}

// Conservative default budgets when no model is configured or recognized.
export const DEFAULT_CONTEXT_TOKENS = 200_000;
export const DEFAULT_OUTPUT_TOKENS = 8_192;

// Fraction of the usable window (context − reserved output) a single work block
// or review packet is allowed to occupy. Leaves headroom for the host prompt.
export const BLOCK_SAFETY_MARGIN = 0.7;

// Heuristic byte→token ratio for source code and English prose. Roughly four
// bytes per token; deliberately coarse — callers size budgets, not bills.
export const BYTES_PER_TOKEN = 4;

// Legacy line-based estimate. Retained for callers that size by line count
// before Phase 2 switches them to byte-based sizing.
export const ESTIMATED_TOKENS_PER_LINE = 4;

/**
 * Estimate tokens from a raw byte count. Non-finite or non-positive inputs
 * estimate to zero so missing `size_bytes` never inflates a budget.
 */
export function estimateTokensFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/**
 * Usable context budget for a single work block: (context − reserved output)
 * scaled by the safety margin. Falls back to a known model's limits, then to
 * the conservative defaults.
 */
export function resolveContextBudget(input: {
  contextTokens?: number | null;
  reservedOutputTokens?: number | null;
  hostModel?: string | null;
  safetyMargin?: number;
}): number {
  const known = input.hostModel ? lookupModelLimits(input.hostModel) : undefined;
  const contextTokens =
    input.contextTokens ?? known?.context_tokens ?? DEFAULT_CONTEXT_TOKENS;
  const outputTokens =
    input.reservedOutputTokens ?? known?.output_tokens ?? DEFAULT_OUTPUT_TOKENS;
  const margin = input.safetyMargin ?? BLOCK_SAFETY_MARGIN;
  return Math.floor((contextTokens - outputTokens) * margin);
}
