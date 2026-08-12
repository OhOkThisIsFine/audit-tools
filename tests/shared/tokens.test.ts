import { test, expect } from "vitest";
import {
  estimateTokensFromBytes,
  BYTES_PER_TOKEN,
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
} from "../../src/shared/tokens.js";

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
