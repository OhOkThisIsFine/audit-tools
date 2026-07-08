import { test, expect } from "vitest";

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
} = await import("../../src/shared/tokens.ts");

test("estimateTokensFromBytes is the single token-estimation primitive in shared", () => {
  // Zero and non-positive/non-finite inputs estimate to zero
  expect(estimateTokensFromBytes(0)).toBe(0);
  expect(estimateTokensFromBytes(-1)).toBe(0);
  expect(estimateTokensFromBytes(Number.NaN)).toBe(0);
  expect(estimateTokensFromBytes(Infinity)).toBe(0);
  // 400 bytes / 4 bytes-per-token = 100 tokens
  expect(estimateTokensFromBytes(400)).toBe(100);
  // 1 byte → ceil(1/4) = 1
  expect(estimateTokensFromBytes(1)).toBe(1);
  // Pin each operand individually — the earlier `a*b === b*a` check was a
  // commutativity tautology that could never fail. The byte→token ratio and the
  // legacy per-line estimate are both 4, so their product is 16.
  expect(BYTES_PER_TOKEN).toBe(4);
  expect(ESTIMATED_TOKENS_PER_LINE).toBe(4);
  expect(ESTIMATED_TOKENS_PER_LINE * BYTES_PER_TOKEN).toBe(16);
  // Canonical overhead constants
  expect(ESTIMATED_PROMPT_OVERHEAD_TOKENS).toBe(900);
  expect(ESTIMATED_ITEM_OVERHEAD_TOKENS).toBe(600);
});

test("estimateTokensFromBytes is monotonic and zero for non-positive/non-finite", () => {
  expect(estimateTokensFromBytes(0)).toBe(0);
  expect(estimateTokensFromBytes(-5)).toBe(0);
  expect(estimateTokensFromBytes(Number.NaN)).toBe(0);
  expect(estimateTokensFromBytes(Infinity)).toBe(0);

  let prev = -1;
  for (const bytes of [1, 4, 100, 4096, 1_000_000]) {
    const tokens = estimateTokensFromBytes(bytes);
    expect(tokens >= prev, `tokens should be non-decreasing at ${bytes}`).toBeTruthy();
    prev = tokens;
  }
  expect(estimateTokensFromBytes(BYTES_PER_TOKEN)).toBe(1);
  expect(estimateTokensFromBytes(BYTES_PER_TOKEN * 10)).toBe(10);
});

test("resolveContextBudget prefers explicit values, else the conservative floor", () => {
  const explicit = resolveContextBudget({
    contextTokens: 100_000,
    reservedOutputTokens: 4_000,
    safetyMargin: 0.5,
  });
  expect(explicit).toBe(Math.floor((100_000 - 4_000) * 0.5));

  // No window configured/discovered → conservative floor, never a guessed
  // per-model window.
  const defaults = resolveContextBudget({});
  expect(defaults).toBe(Math.floor((DEFAULT_CONTEXT_TOKENS - DEFAULT_OUTPUT_TOKENS) * BLOCK_SAFETY_MARGIN));
});

test("resolveContextBudget floors at 0 — a reserved output ≥ context never goes negative", () => {
  // A malformed/degenerate window (output meets or exceeds context) yields no
  // usable input budget; the pool fails CLOSED (0) rather than propagating a
  // negative budget. Guards the remediate path where no config validator runs.
  expect(resolveContextBudget({ contextTokens: 4_000, reservedOutputTokens: 8_000 })).toBe(0);
  expect(resolveContextBudget({ contextTokens: 4_000, reservedOutputTokens: 4_000 })).toBe(0);
});
