import { describe, it, expect } from "vitest";
import {
  ClaudeCodeErrorParser,
  GenericErrorParser,
  getErrorParserForProvider,
} from "audit-tools/shared";

describe("GenericErrorParser", () => {
  it("delegates to detectRateLimitError", () => {
    const parser = new GenericErrorParser();
    const result = parser.parse("Error 429 rate limited");
    expect(result.isRateLimited).toBe(true);
  });

  it("returns false for non-rate-limit text", () => {
    const parser = new GenericErrorParser();
    const result = parser.parse("Connection refused");
    expect(result.isRateLimited).toBe(false);
  });
});

describe("ClaudeCodeErrorParser", () => {
  it("detects status_code 429 in JSON-line stderr", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = '{"level":"error","status_code":429,"message":"Rate limit hit"}';
    const result = parser.parse(stderr);
    expect(result.isRateLimited).toBe(true);
    expect(result.rawMatch).toContain("claude-code-stderr:429");
  });

  it("detects type rate_limit_error", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = '{"level":"error","type":"rate_limit_error","message":"slow down"}';
    const result = parser.parse(stderr);
    expect(result.isRateLimited).toBe(true);
  });

  it("detects rate limit in error message when level=error", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = '{"level":"error","message":"You hit the rate limit"}';
    const result = parser.parse(stderr);
    expect(result.isRateLimited).toBe(true);
  });

  it("extracts retry_after_ms", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = '{"level":"error","status_code":429,"retry_after_ms":3000}';
    const result = parser.parse(stderr);
    expect(result.isRateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(3000);
  });

  it("extracts retry_after in seconds and converts to ms", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = '{"level":"error","status_code":429,"retry_after":30}';
    const result = parser.parse(stderr);
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("returns false for non-rate-limit JSON lines", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = '{"level":"info","message":"Starting task"}\n{"level":"debug","message":"done"}';
    const result = parser.parse(stderr);
    expect(result.isRateLimited).toBe(false);
  });

  it("skips non-JSON lines", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = 'some text\n{"level":"error","status_code":429}\nmore text';
    const result = parser.parse(stderr);
    expect(result.isRateLimited).toBe(true);
  });

  it("does not false-positive on rate limit in non-error level", () => {
    const parser = new ClaudeCodeErrorParser();
    const stderr = '{"level":"info","message":"rate limit info"}';
    const result = parser.parse(stderr);
    expect(result.isRateLimited).toBe(false);
  });
});

describe("getErrorParserForProvider", () => {
  it("returns ClaudeCodeErrorParser for claude-code", () => {
    const parser = getErrorParserForProvider("claude-code");
    expect(parser.name).toBe("claude-code");
  });

  it("returns GenericErrorParser for unknown providers", () => {
    const parser = getErrorParserForProvider("subprocess-template");
    expect(parser.name).toBe("generic");
  });
});
