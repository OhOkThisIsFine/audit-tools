import test from "node:test";
import assert from "node:assert/strict";

const {
  estimateTokensFromBytes,
  resolveContextBudget,
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
  // Pin each operand individually — the earlier `a*b === b*a` check was a
  // commutativity tautology that could never fail. The byte→token ratio and the
  // legacy per-line estimate are both 4, so their product is 16.
  assert.equal(BYTES_PER_TOKEN, 4);
  assert.equal(ESTIMATED_TOKENS_PER_LINE, 4);
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

test("resolveContextBudget prefers explicit values, else the conservative floor", () => {
  const explicit = resolveContextBudget({
    contextTokens: 100_000,
    reservedOutputTokens: 4_000,
    safetyMargin: 0.5,
  });
  assert.equal(explicit, Math.floor((100_000 - 4_000) * 0.5));

  // No window configured/discovered → conservative floor, never a guessed
  // per-model window.
  const defaults = resolveContextBudget({});
  assert.equal(
    defaults,
    Math.floor((DEFAULT_CONTEXT_TOKENS - DEFAULT_OUTPUT_TOKENS) * BLOCK_SAFETY_MARGIN),
  );
});
