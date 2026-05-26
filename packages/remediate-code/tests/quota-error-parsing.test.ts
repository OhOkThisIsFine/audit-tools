import { describe, it, expect } from "vitest";
import { detectRateLimitError, computeCooldownUntil } from "../src/quota/errorParsing.js";

describe("detectRateLimitError", () => {
  it("detects 429 status code", () => {
    const result = detectRateLimitError("Error: 429 Too Many Requests");
    expect(result.isRateLimited).toBe(true);
    expect(result.rawMatch).toBe("429");
  });

  it("detects rate limit text", () => {
    const result = detectRateLimitError("You have been rate-limited");
    expect(result.isRateLimited).toBe(true);
  });

  it("detects overloaded", () => {
    const result = detectRateLimitError("The server is overloaded right now");
    expect(result.isRateLimited).toBe(true);
  });

  it("detects quota exceeded", () => {
    const result = detectRateLimitError("Your quota exceeded the limit");
    expect(result.isRateLimited).toBe(true);
  });

  it("detects resource exhausted", () => {
    const result = detectRateLimitError("Resource exhausted, try again later");
    expect(result.isRateLimited).toBe(true);
  });

  it("returns false for normal errors", () => {
    const result = detectRateLimitError("TypeError: undefined is not a function");
    expect(result.isRateLimited).toBe(false);
    expect(result.rawMatch).toBeNull();
  });

  it("detects JSON with status 429", () => {
    const json = JSON.stringify({ status: 429, type: "rate_limit_error" });
    const result = detectRateLimitError(json);
    expect(result.isRateLimited).toBe(true);
    expect(result.rawMatch).toContain("status=429");
  });

  it("extracts retry-after from JSON headers", () => {
    const json = JSON.stringify({
      status: 429,
      headers: { "retry-after": "30" },
    });
    const result = detectRateLimitError(json);
    expect(result.isRateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("extracts retry_after_ms from JSON", () => {
    const json = JSON.stringify({
      type: "rate_limit_error",
      retry_after_ms: 5000,
    });
    const result = detectRateLimitError(json);
    expect(result.isRateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(5000);
  });

  it("detects JSON with error.type rate_limit_error", () => {
    const json = JSON.stringify({
      error: { type: "rate_limit_error", message: "Rate limited" },
    });
    const result = detectRateLimitError(json);
    expect(result.isRateLimited).toBe(true);
  });

  it("does not false-positive on non-rate-limit JSON", () => {
    const json = JSON.stringify({ status: 200, type: "success" });
    const result = detectRateLimitError(json);
    expect(result.isRateLimited).toBe(false);
  });

  it("handles non-JSON text with embedded JSON gracefully", () => {
    const result = detectRateLimitError("some prefix {invalid json}");
    expect(result.isRateLimited).toBe(false);
  });
});

describe("computeCooldownUntil", () => {
  it("uses retryAfterMs when provided", () => {
    const before = Date.now();
    const result = computeCooldownUntil(5000);
    const timestamp = new Date(result).getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before + 4900);
    expect(timestamp).toBeLessThanOrEqual(before + 5200);
  });

  it("falls back to default when retryAfterMs is null", () => {
    const before = Date.now();
    const result = computeCooldownUntil(null);
    const timestamp = new Date(result).getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before + 59_000);
    expect(timestamp).toBeLessThanOrEqual(before + 61_000);
  });

  it("uses custom default", () => {
    const before = Date.now();
    const result = computeCooldownUntil(null, 10_000);
    const timestamp = new Date(result).getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before + 9_000);
    expect(timestamp).toBeLessThanOrEqual(before + 11_000);
  });
});
