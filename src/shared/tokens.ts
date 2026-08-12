// Canonical local token-estimation arithmetic shared by both orchestrators.
//
// Before Phase 0 each package carried its own copy of a per-line token
// estimator (auditor `reviewPackets.ts`, remediator `plan.ts`). This module is
// the single source of truth for:
//   - the byte- and line-based token estimators,
//   - fixed prompt/item overhead used for advisory work metadata.

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
