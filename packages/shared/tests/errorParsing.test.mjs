import test from "node:test";
import assert from "node:assert/strict";

const { detectRateLimitError } = await import("../src/quota/errorParsing.ts");

test("detectRateLimitError still matches all RATE_LIMIT_PATTERNS after refactor", () => {
  assert.equal(detectRateLimitError("429 Too Many Requests").isRateLimited, true);
  assert.equal(detectRateLimitError("too many requests").isRateLimited, true);
  assert.equal(detectRateLimitError("rate-limit exceeded").isRateLimited, true);
  assert.equal(detectRateLimitError("server overloaded").isRateLimited, true);
  assert.equal(detectRateLimitError("resource exhausted").isRateLimited, true);
  assert.equal(detectRateLimitError("quota exceeded").isRateLimited, true);
});

test("detectRateLimitError still matches all USAGE_LIMIT_PATTERNS after refactor", () => {
  assert.equal(detectRateLimitError("You have hit your session limit").isRateLimited, true);
  assert.equal(detectRateLimitError("You have reached your usage limit").isRateLimited, true);
  assert.equal(detectRateLimitError("session limit reached").isRateLimited, true);
});
