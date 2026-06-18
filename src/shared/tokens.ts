// Canonical token-budget arithmetic shared by both orchestrators.
//
// Before Phase 0 each package carried its own copy of a per-line token
// estimator (auditor `reviewPackets.ts`, remediator `plan.ts`). This module is
// the single source of truth for:
//   - the byte- and line-based token estimators,
//   - the default budgets and safety margin used when sizing work blocks.
//
// Model context/output windows are NOT hardcoded here — they are discovered at
// the dispatch-time capability handshake (see quota/limits.ts
// `discovered_capability`). When nothing is discovered, sizing falls to the
// conservative floor below, never to a guessed per-model window.

// Conservative default budgets when no window is configured or discovered. This
// matches the quota subsystem's conservative floor (quota/limits.ts
// `defaultLimits`): a headless run that cannot discover its window sizes small
// and honest rather than assuming a large model's context.
export const DEFAULT_CONTEXT_TOKENS = 32_000;
export const DEFAULT_OUTPUT_TOKENS = 4_096;

// Fraction of the usable window (context − reserved output) a single work block
// or review packet is allowed to occupy. Leaves headroom for the host prompt.
export const BLOCK_SAFETY_MARGIN = 0.7;

// Heuristic byte→token ratio for source code and English prose. Roughly four
// bytes per token; deliberately coarse — callers size budgets, not bills.
export const BYTES_PER_TOKEN = 4;

// Legacy line-based estimate. Retained for callers that size by line count
// before Phase 2 switches them to byte-based sizing.
export const ESTIMATED_TOKENS_PER_LINE = 4;

// Prompt/item overhead constants shared by both orchestrators. These replace
// per-package local copies (ESTIMATED_BLOCK_BASE_TOKENS / ESTIMATED_PACKET_PROMPT_TOKENS
// and ESTIMATED_FINDING_OVERHEAD_TOKENS) so the two orchestrators cannot drift apart.
export const ESTIMATED_PROMPT_OVERHEAD_TOKENS = 900;
export const ESTIMATED_ITEM_OVERHEAD_TOKENS = 600;

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
 * scaled by the safety margin. Callers pass the discovered/configured window;
 * absent that, sizing falls to the conservative floor (never a guessed
 * per-model window).
 */
export function resolveContextBudget(input: {
  contextTokens?: number | null;
  reservedOutputTokens?: number | null;
  safetyMargin?: number;
}): number {
  const contextTokens = input.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const outputTokens = input.reservedOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
  const margin = input.safetyMargin ?? BLOCK_SAFETY_MARGIN;
  return Math.floor((contextTokens - outputTokens) * margin);
}
