import { describe, it, expect } from "vitest";
import { detectRateLimitError, computeCooldownUntil } from "audit-tools/shared";

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
  const FIXED_NOW = 1_000_000_000_000;

  it("uses retryAfterMs when provided", () => {
    const result = computeCooldownUntil(5000, undefined, FIXED_NOW);
    expect(result).toBe(new Date(FIXED_NOW + 5000).toISOString());
  });

  it("falls back to default when retryAfterMs is null", () => {
    const result = computeCooldownUntil(null, undefined, FIXED_NOW);
    expect(result).toBe(new Date(FIXED_NOW + 60_000).toISOString());
  });

  it("uses custom default", () => {
    const result = computeCooldownUntil(null, 10_000, FIXED_NOW);
    expect(result).toBe(new Date(FIXED_NOW + 10_000).toISOString());
  });

  it("uses injected now for deterministic timestamp", () => {
    expect(computeCooldownUntil(5000, undefined, FIXED_NOW)).toBe(
      new Date(1_000_000_005_000).toISOString(),
    );
    expect(computeCooldownUntil(null, 60_000, FIXED_NOW)).toBe(
      new Date(1_000_000_060_000).toISOString(),
    );
    expect(computeCooldownUntil(null, 10_000, FIXED_NOW)).toBe(
      new Date(1_000_000_010_000).toISOString(),
    );
  });
});
