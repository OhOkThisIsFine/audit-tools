import test from "node:test";
import assert from "node:assert/strict";

const { detectRateLimitError } = await import("../src/quota/errorParsing.ts");
const { ClaudeCodeErrorParser } = await import("../src/quota/errorParsers/claudeCodeErrorParser.ts");

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

// COR-a09cf823: retry_after seconds/ms disambiguation — regression tests
test("extractRetryAfterMs: retry_after=600 treated as 600s (600000ms), not 600ms", () => {
  // JSON payload with retry_after=600 (seconds); old code treated >= 600 as ms (bug).
  const result = detectRateLimitError(JSON.stringify({
    status: 429,
    type: "rate_limit_error",
    retry_after: 600,
  }));
  assert.equal(result.isRateLimited, true);
  // Should be 600 * 1000 = 600000ms, not 600ms.
  assert.equal(result.retryAfterMs, 600_000);
});

test("extractRetryAfterMs: retry_after=60 treated as 60s (60000ms)", () => {
  const result = detectRateLimitError(JSON.stringify({
    status: 429,
    type: "rate_limit_error",
    retry_after: 60,
  }));
  assert.equal(result.isRateLimited, true);
  assert.equal(result.retryAfterMs, 60_000);
});

test("ClaudeCodeErrorParser: retry_after=600 treated as 600s (regression for COR-a09cf823)", () => {
  const parser = new ClaudeCodeErrorParser();
  const result = parser.parse(JSON.stringify({
    status_code: 429,
    retry_after: 600,
  }));
  assert.equal(result.isRateLimited, true);
  // Old code: >= 600 was treated as already-ms (returned 600ms). Fixed: always seconds.
  assert.equal(result.retryAfterMs, 600_000);
});

test("ClaudeCodeErrorParser: retry_after_ms takes precedence over retry_after", () => {
  const parser = new ClaudeCodeErrorParser();
  const result = parser.parse(JSON.stringify({
    status_code: 429,
    retry_after: 30,
    retry_after_ms: 45_000,
  }));
  assert.equal(result.isRateLimited, true);
  assert.equal(result.retryAfterMs, 45_000);
});
