import { test, expect } from "vitest";

const { detectRateLimitError } = await import("../../src/shared/quota/errorParsing.ts");
const { ClaudeCodeErrorParser } = await import("../../src/shared/quota/errorParsers/claudeCodeErrorParser.ts");

test("detectRateLimitError still matches all RATE_LIMIT_PATTERNS after refactor", () => {
  expect(detectRateLimitError("429 Too Many Requests").isRateLimited).toBe(true);
  expect(detectRateLimitError("too many requests").isRateLimited).toBe(true);
  expect(detectRateLimitError("rate-limit exceeded").isRateLimited).toBe(true);
  expect(detectRateLimitError("server overloaded").isRateLimited).toBe(true);
  expect(detectRateLimitError("resource exhausted").isRateLimited).toBe(true);
  expect(detectRateLimitError("quota exceeded").isRateLimited).toBe(true);
});

test("detectRateLimitError still matches all USAGE_LIMIT_PATTERNS after refactor", () => {
  expect(detectRateLimitError("You have hit your session limit").isRateLimited).toBe(true);
  expect(detectRateLimitError("You have reached your usage limit").isRateLimited).toBe(true);
  expect(detectRateLimitError("session limit reached").isRateLimited).toBe(true);
});

// COR-a09cf823: retry_after seconds/ms disambiguation — regression tests
test("extractRetryAfterMs: retry_after=600 treated as 600s (600000ms), not 600ms", () => {
  // JSON payload with retry_after=600 (seconds); old code treated >= 600 as ms (bug).
  const result = detectRateLimitError(JSON.stringify({
    status: 429,
    type: "rate_limit_error",
    retry_after: 600,
  }));
  expect(result.isRateLimited).toBe(true);
  // Should be 600 * 1000 = 600000ms, not 600ms.
  expect(result.retryAfterMs).toBe(600_000);
});

test("extractRetryAfterMs: retry_after=60 treated as 60s (60000ms)", () => {
  const result = detectRateLimitError(JSON.stringify({
    status: 429,
    type: "rate_limit_error",
    retry_after: 60,
  }));
  expect(result.isRateLimited).toBe(true);
  expect(result.retryAfterMs).toBe(60_000);
});

test("ClaudeCodeErrorParser: retry_after=600 treated as 600s (regression for COR-a09cf823)", () => {
  const parser = new ClaudeCodeErrorParser();
  const result = parser.parse(JSON.stringify({
    status_code: 429,
    retry_after: 600,
  }));
  expect(result.isRateLimited).toBe(true);
  // Old code: >= 600 was treated as already-ms (returned 600ms). Fixed: always seconds.
  expect(result.retryAfterMs).toBe(600_000);
});

test("ClaudeCodeErrorParser: retry_after_ms takes precedence over retry_after", () => {
  const parser = new ClaudeCodeErrorParser();
  const result = parser.parse(JSON.stringify({
    status_code: 429,
    retry_after: 30,
    retry_after_ms: 45_000,
  }));
  expect(result.isRateLimited).toBe(true);
  expect(result.retryAfterMs).toBe(45_000);
});
