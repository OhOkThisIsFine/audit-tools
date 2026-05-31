import test from "node:test";
import assert from "node:assert/strict";

const {
  estimateTokensFromBytes,
  resolveContextBudget,
  lookupModelLimits,
  KNOWN_MODEL_LIMITS,
  BYTES_PER_TOKEN,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  BLOCK_SAFETY_MARGIN,
// Note: We intentionally import from the compiled build in `../dist` to guarantee we test the final distributed artifacts.
// The `npm test` script automatically rebuilds before execution, ensuring tests are never run against stale builds.
} = await import("../dist/tokens.js");

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
