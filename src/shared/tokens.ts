// Canonical token-budget arithmetic shared by both orchestrators.
//
// Before Phase 0 each package carried its own copy of a per-line token
// estimator (auditor `reviewPackets.ts`, remediator `plan.ts`). This module is
// the single source of truth for:
//   - the byte- and line-based token estimators,
//   - the safety-margin policy used when sizing work blocks.
//
// Model context/output windows are never hardcoded here. They come from explicit
// operator policy, the current dispatch-time capability handshake, or the synced
// models.dev snapshot. Unknown stays unknown; callers must pause/fail closed.

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
 * absent either value, sizing is unresolved rather than guessed.
 */
export function resolveContextBudget(input: {
  contextTokens?: number | null;
  reservedOutputTokens?: number | null;
  safetyMargin?: number;
}): number | null {
  const contextTokens = input.contextTokens;
  const outputTokens = input.reservedOutputTokens;
  if (
    typeof contextTokens !== "number" ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0 ||
    typeof outputTokens !== "number" ||
    !Number.isFinite(outputTokens) ||
    outputTokens <= 0
  ) {
    return null;
  }
  const margin = input.safetyMargin ?? BLOCK_SAFETY_MARGIN;
  // Floor at 0: a window whose reserved output meets or exceeds its context
  // (a malformed operator quota, or a too-small endpoint) yields no usable input
  // budget — the pool then fails CLOSED (refuses slots) rather than propagating a
  // negative budget. Holds regardless of which orchestrator or validator ran.
  return Math.max(0, Math.floor((contextTokens - outputTokens) * margin));
}
