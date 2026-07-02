import { test, expect } from "vitest";

const { GenericErrorParser, ClaudeCodeErrorParser, getErrorParserForProvider } =
  await import("audit-tools/shared/quota/errorParsers/index");

// ── GenericErrorParser ──────────────────────────────────────────────────────

test("GenericErrorParser detects 429 errors", () => {
  const parser = new GenericErrorParser();
  const result = parser.parse("Error: 429 Too Many Requests");
  expect(result.isRateLimited).toBe(true);
});

test("GenericErrorParser returns false for non-rate-limit errors", () => {
  const parser = new GenericErrorParser();
  const result = parser.parse("Error: 500 Internal Server Error");
  expect(result.isRateLimited).toBe(false);
});

// ── ClaudeCodeErrorParser ───────────────────────────────────────────────────

test("ClaudeCodeErrorParser detects JSON line with status_code 429", () => {
  const parser = new ClaudeCodeErrorParser();
  const stderr = '{"level":"error","status_code":429,"message":"rate limited","retry_after":30}';
  const result = parser.parse(stderr);
  expect(result.isRateLimited).toBe(true);
  expect(result.retryAfterMs).toBe(30_000);
  expect(result.rawMatch?.includes("claude-code-stderr")).toBeTruthy();
});

test("ClaudeCodeErrorParser detects JSON line with type rate_limit_error", () => {
  const parser = new ClaudeCodeErrorParser();
  const stderr = '{"type":"rate_limit_error","message":"too many requests"}';
  const result = parser.parse(stderr);
  expect(result.isRateLimited).toBe(true);
});

test("ClaudeCodeErrorParser detects rate limit in error-level message", () => {
  const parser = new ClaudeCodeErrorParser();
  const stderr = '{"level":"error","message":"Rate limit exceeded for this API key"}';
  const result = parser.parse(stderr);
  expect(result.isRateLimited).toBe(true);
});

test("ClaudeCodeErrorParser extracts retry_after_ms", () => {
  const parser = new ClaudeCodeErrorParser();
  const stderr = '{"status_code":429,"retry_after_ms":5000}';
  const result = parser.parse(stderr);
  expect(result.retryAfterMs).toBe(5000);
});

test("ClaudeCodeErrorParser ignores non-rate-limit JSON lines", () => {
  const parser = new ClaudeCodeErrorParser();
  const stderr = [
    '{"level":"info","message":"connected"}',
    '{"level":"error","message":"file not found"}',
  ].join("\n");
  const result = parser.parse(stderr);
  expect(result.isRateLimited).toBe(false);
});

test("ClaudeCodeErrorParser handles mixed text and JSON", () => {
  const parser = new ClaudeCodeErrorParser();
  const stderr = [
    "Starting worker...",
    '{"level":"info","message":"connected"}',
    '{"status_code":429,"message":"rate limited"}',
    "Worker complete.",
  ].join("\n");
  const result = parser.parse(stderr);
  expect(result.isRateLimited).toBe(true);
});

test("ClaudeCodeErrorParser handles empty input", () => {
  const parser = new ClaudeCodeErrorParser();
  const result = parser.parse("");
  expect(result.isRateLimited).toBe(false);
});

// ── getErrorParserForProvider ────────────────────────────────────────────────

test("getErrorParserForProvider returns ClaudeCodeErrorParser for claude-code", () => {
  const parser = getErrorParserForProvider("claude-code");
  expect(parser.name).toBe("claude-code");
});

test("getErrorParserForProvider returns GenericErrorParser for unknown providers", () => {
  const parser = getErrorParserForProvider("opencode");
  expect(parser.name).toBe("generic");
});

test("getErrorParserForProvider returns GenericErrorParser for local-subprocess", () => {
  const parser = getErrorParserForProvider("local-subprocess");
  expect(parser.name).toBe("generic");
});
