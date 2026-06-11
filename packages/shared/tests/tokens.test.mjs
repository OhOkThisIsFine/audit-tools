import test from "node:test";
import assert from "node:assert/strict";

const {
  estimateTokensFromBytes,
  resolveContextBudget,
  lookupModelLimits,
  KNOWN_MODEL_LIMITS,
  BYTES_PER_TOKEN,
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  BLOCK_SAFETY_MARGIN,
// Note: We intentionally import from the TypeScript source in `../src` so that tests run directly against the
// uncompiled source. The `npm test` script builds before running tests, but this file imports src/ directly.
} = await import("../src/tokens.ts");

test("estimateTokensFromBytes is the single token-estimation primitive in shared", () => {
  // Zero and non-positive/non-finite inputs estimate to zero
  assert.equal(estimateTokensFromBytes(0), 0);
  assert.equal(estimateTokensFromBytes(-1), 0);
  assert.equal(estimateTokensFromBytes(Number.NaN), 0);
  assert.equal(estimateTokensFromBytes(Infinity), 0);
  // 400 bytes / 4 bytes-per-token = 100 tokens
  assert.equal(estimateTokensFromBytes(400), 100);
  // 1 byte → ceil(1/4) = 1
  assert.equal(estimateTokensFromBytes(1), 1);
  // ESTIMATED_TOKENS_PER_LINE × BYTES_PER_TOKEN consistency (value is 16)
  assert.equal(ESTIMATED_TOKENS_PER_LINE * BYTES_PER_TOKEN, BYTES_PER_TOKEN * ESTIMATED_TOKENS_PER_LINE);
  assert.equal(ESTIMATED_TOKENS_PER_LINE * BYTES_PER_TOKEN, 16);
  // Canonical overhead constants
  assert.equal(ESTIMATED_PROMPT_OVERHEAD_TOKENS, 900);
  assert.equal(ESTIMATED_ITEM_OVERHEAD_TOKENS, 600);
});

test("estimateTokensFromBytes is monotonic and zero for non-positive/non-finite", () => {
  assert.equal(estimateTokensFromBytes(0), 0);
  assert.equal(estimateTokensFromBytes(-5), 0);
  assert.equal(estimateTokensFromBytes(Number.NaN), 0);
  assert.equal(estimateTokensFromBytes(Infinity), 0);

  let prev = -1;
  for (const bytes of [1, 4, 100, 4096, 1_000_000]) {
    const tokens = estimateTokensFromBytes(bytes);
    assert.ok(tokens >= prev, `tokens should be non-decreasing at ${bytes}`);
    prev = tokens;
  }
  assert.equal(estimateTokensFromBytes(BYTES_PER_TOKEN), 1);
  assert.equal(estimateTokensFromBytes(BYTES_PER_TOKEN * 10), 10);
});

test("lookupModelLimits is case-insensitive and returns known limits", () => {
  const opus = lookupModelLimits("anthropic/claude-opus-4-7");
  assert.deepEqual(opus, { context_tokens: 200_000, output_tokens: 32_000 });
  assert.deepEqual(
    lookupModelLimits("  ANTHROPIC/CLAUDE-OPUS-4-7 "),
    KNOWN_MODEL_LIMITS["anthropic/claude-opus-4-7"],
  );
  assert.equal(lookupModelLimits("nonexistent/model"), undefined);
});

test("resolveContextBudget prefers explicit values, then model, then defaults", () => {
  const explicit = resolveContextBudget({
    contextTokens: 100_000,
    reservedOutputTokens: 4_000,
    safetyMargin: 0.5,
  });
  assert.equal(explicit, Math.floor((100_000 - 4_000) * 0.5));

  const byModel = resolveContextBudget({ hostModel: "anthropic/claude-opus-4-7" });
  assert.equal(byModel, Math.floor((200_000 - 32_000) * BLOCK_SAFETY_MARGIN));

  const defaults = resolveContextBudget({});
  assert.equal(
    defaults,
    Math.floor((DEFAULT_CONTEXT_TOKENS - DEFAULT_OUTPUT_TOKENS) * BLOCK_SAFETY_MARGIN),
  );
});
