import { test, expect } from "vitest";

const { detectRateLimitError, computeCooldownUntil } = await import(
  "audit-tools/shared/quota/errorParsing"
);

// ── detectRateLimitError: word-boundary matching ────────────────────────────

test("detects standalone 429 status code", () => {
  const result = detectRateLimitError("Error: 429 Too Many Requests");
  expect(result.isRateLimited).toBe(true);
});

test("rejects 429 embedded in non-status context (port number)", () => {
  const result = detectRateLimitError("connecting to localhost:4290");
  expect(result.isRateLimited).toBe(false);
});

test("rejects 429 embedded in a path segment", () => {
  const result = detectRateLimitError("file at /data/42900/log.txt not found");
  expect(result.isRateLimited).toBe(false);
});

test("detects 'rate limit' case-insensitively", () => {
  const result = detectRateLimitError("Rate Limit exceeded for this API key");
  expect(result.isRateLimited).toBe(true);
});

test("detects 'rate_limit' with underscore", () => {
  const result = detectRateLimitError("error type: rate_limit_error");
  expect(result.isRateLimited).toBe(true);
});

test("detects 'overloaded'", () => {
  const result = detectRateLimitError("The API is overloaded, please try again");
  expect(result.isRateLimited).toBe(true);
});

test("detects a host session-limit sentinel and extracts the clock-time reset", () => {
  const now = new Date(2024, 0, 1, 10, 0, 0, 0).getTime(); // 10:00am local
  const result = detectRateLimitError(
    "You've hit your session limit · resets 3:30pm",
    now,
  );
  expect(result.isRateLimited).toBe(true);
  // 3:30pm is 5h30m after 10:00am (+5s buffer).
  expect(result.retryAfterMs).toBe((5 * 3600 + 30 * 60 + 5) * 1000);
});

test("session-limit reset already passed today rolls to tomorrow", () => {
  const now = new Date(2024, 0, 1, 16, 0, 0, 0).getTime(); // 4:00pm local
  const result = detectRateLimitError(
    "You've reached your usage limit, resets 3:30pm",
    now,
  );
  expect(result.isRateLimited).toBe(true);
  // 3:30pm already passed → next is +23h30m (+5s buffer).
  expect(result.retryAfterMs).toBe((23 * 3600 + 30 * 60 + 5) * 1000);
});

test("does not flag the word 'limit' in ordinary audit output", () => {
  const result = detectRateLimitError(
    "The function exceeds the recommended complexity limit of 15.",
  );
  expect(result.isRateLimited).toBe(false);
});

test("detects 'resource exhausted'", () => {
  const result = detectRateLimitError("RESOURCE_EXHAUSTED: quota depleted");
  expect(result.isRateLimited).toBe(true);
});

test("detects 'quota exceeded'", () => {
  const result = detectRateLimitError("quota exceeded for project default");
  expect(result.isRateLimited).toBe(true);
});

test("returns false for unrelated errors", () => {
  const result = detectRateLimitError("TypeError: Cannot read property 'foo' of undefined");
  expect(result.isRateLimited).toBe(false);
  expect(result.retryAfterMs).toBe(null);
  expect(result.rawMatch).toBe(null);
});

// ── detectRateLimitError: JSON parsing ──────────────────────────────────────

test("detects JSON error with status 429", () => {
  const json = JSON.stringify({ status: 429, message: "rate limited" });
  const result = detectRateLimitError(json);
  expect(result.isRateLimited).toBe(true);
  expect(result.rawMatch?.includes("status=429")).toBeTruthy();
});

test("detects JSON error with type rate_limit_error", () => {
  const json = JSON.stringify({ type: "rate_limit_error", message: "too many requests" });
  const result = detectRateLimitError(json);
  expect(result.isRateLimited).toBe(true);
  expect(result.rawMatch?.includes("rate_limit_error")).toBeTruthy();
});

test("detects JSON error with nested error.type", () => {
  const json = JSON.stringify({ error: { type: "rate_limit_error", message: "overloaded" } });
  const result = detectRateLimitError(json);
  expect(result.isRateLimited).toBe(true);
});

test("extracts retry_after from JSON body (seconds)", () => {
  const json = JSON.stringify({ status: 429, retry_after: 30 });
  const result = detectRateLimitError(json);
  expect(result.isRateLimited).toBe(true);
  expect(result.retryAfterMs).toBe(30_000);
});

test("extracts retry_after_ms from JSON body", () => {
  const json = JSON.stringify({ status: 429, retry_after_ms: 5000 });
  const result = detectRateLimitError(json);
  expect(result.isRateLimited).toBe(true);
  expect(result.retryAfterMs).toBe(5000);
});

test("extracts retry-after from headers object", () => {
  const json = JSON.stringify({ status: 429, headers: { "retry-after": "45" } });
  const result = detectRateLimitError(json);
  expect(result.isRateLimited).toBe(true);
  expect(result.retryAfterMs).toBe(45_000);
});

test("JSON with non-429 status is not rate limited", () => {
  const json = JSON.stringify({ status: 500, message: "internal server error" });
  const result = detectRateLimitError(json);
  expect(result.isRateLimited).toBe(false);
});

test("handles JSON preceded by log text", () => {
  const text = 'stderr: {"status":429,"message":"rate limited"}';
  const result = detectRateLimitError(text);
  expect(result.isRateLimited).toBe(true);
});

// ── computeCooldownUntil ────────────────────────────────────────────────────

const FIXED_NOW = 1_000_000_000_000;

test("computeCooldownUntil uses retryAfterMs when provided", () => {
  const result = computeCooldownUntil(5000, undefined, FIXED_NOW);
  expect(result).toBe(new Date(FIXED_NOW + 5000).toISOString());
});

test("computeCooldownUntil uses default 60s when retryAfterMs is null", () => {
  const result = computeCooldownUntil(null, undefined, FIXED_NOW);
  expect(result).toBe(new Date(FIXED_NOW + 60_000).toISOString());
});

test("computeCooldownUntil uses custom default when provided", () => {
  const result = computeCooldownUntil(null, 120_000, FIXED_NOW);
  expect(result).toBe(new Date(FIXED_NOW + 120_000).toISOString());
});

test("computeCooldownUntil returns valid ISO string", () => {
  const result = computeCooldownUntil(1000, undefined, FIXED_NOW);
  expect(!Number.isNaN(new Date(result).getTime())).toBeTruthy();
});

test("computeCooldownUntil uses injected now for deterministic timestamp", () => {
  expect(computeCooldownUntil(5000, undefined, FIXED_NOW)).toBe(new Date(1_000_000_005_000).toISOString());
  expect(computeCooldownUntil(null, 60_000, FIXED_NOW)).toBe(new Date(1_000_000_060_000).toISOString());
  expect(computeCooldownUntil(null, 10_000, FIXED_NOW)).toBe(new Date(1_000_000_010_000).toISOString());
});
