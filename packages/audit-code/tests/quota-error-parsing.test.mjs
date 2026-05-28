import test from "node:test";
import assert from "node:assert/strict";

const { detectRateLimitError, computeCooldownUntil } = await import(
  "@audit-tools/shared/quota/errorParsing"
);

// ── detectRateLimitError: word-boundary matching ────────────────────────────

test("detects standalone 429 status code", () => {
  const result = detectRateLimitError("Error: 429 Too Many Requests");
  assert.equal(result.isRateLimited, true);
});

test("rejects 429 embedded in non-status context (port number)", () => {
  const result = detectRateLimitError("connecting to localhost:4290");
  assert.equal(result.isRateLimited, false);
});

test("rejects 429 embedded in a path segment", () => {
  const result = detectRateLimitError("file at /data/42900/log.txt not found");
  assert.equal(result.isRateLimited, false);
});

test("detects 'rate limit' case-insensitively", () => {
  const result = detectRateLimitError("Rate Limit exceeded for this API key");
  assert.equal(result.isRateLimited, true);
});

test("detects 'rate_limit' with underscore", () => {
  const result = detectRateLimitError("error type: rate_limit_error");
  assert.equal(result.isRateLimited, true);
});

test("detects 'overloaded'", () => {
  const result = detectRateLimitError("The API is overloaded, please try again");
  assert.equal(result.isRateLimited, true);
});

test("detects 'resource exhausted'", () => {
  const result = detectRateLimitError("RESOURCE_EXHAUSTED: quota depleted");
  assert.equal(result.isRateLimited, true);
});

test("detects 'quota exceeded'", () => {
  const result = detectRateLimitError("quota exceeded for project default");
  assert.equal(result.isRateLimited, true);
});

test("returns false for unrelated errors", () => {
  const result = detectRateLimitError("TypeError: Cannot read property 'foo' of undefined");
  assert.equal(result.isRateLimited, false);
  assert.equal(result.retryAfterMs, null);
  assert.equal(result.rawMatch, null);
});

// ── detectRateLimitError: JSON parsing ──────────────────────────────────────

test("detects JSON error with status 429", () => {
  const json = JSON.stringify({ status: 429, message: "rate limited" });
  const result = detectRateLimitError(json);
  assert.equal(result.isRateLimited, true);
  assert.ok(result.rawMatch?.includes("status=429"));
});

test("detects JSON error with type rate_limit_error", () => {
  const json = JSON.stringify({ type: "rate_limit_error", message: "too many requests" });
  const result = detectRateLimitError(json);
  assert.equal(result.isRateLimited, true);
  assert.ok(result.rawMatch?.includes("rate_limit_error"));
});

test("detects JSON error with nested error.type", () => {
  const json = JSON.stringify({ error: { type: "rate_limit_error", message: "overloaded" } });
  const result = detectRateLimitError(json);
  assert.equal(result.isRateLimited, true);
});

test("extracts retry_after from JSON body (seconds)", () => {
  const json = JSON.stringify({ status: 429, retry_after: 30 });
  const result = detectRateLimitError(json);
  assert.equal(result.isRateLimited, true);
  assert.equal(result.retryAfterMs, 30_000);
});

test("extracts retry_after_ms from JSON body", () => {
  const json = JSON.stringify({ status: 429, retry_after_ms: 5000 });
  const result = detectRateLimitError(json);
  assert.equal(result.isRateLimited, true);
  assert.equal(result.retryAfterMs, 5000);
});

test("extracts retry-after from headers object", () => {
  const json = JSON.stringify({ status: 429, headers: { "retry-after": "45" } });
  const result = detectRateLimitError(json);
  assert.equal(result.isRateLimited, true);
  assert.equal(result.retryAfterMs, 45_000);
});

test("JSON with non-429 status is not rate limited", () => {
  const json = JSON.stringify({ status: 500, message: "internal server error" });
  const result = detectRateLimitError(json);
  assert.equal(result.isRateLimited, false);
});

test("handles JSON preceded by log text", () => {
  const text = 'stderr: {"status":429,"message":"rate limited"}';
  const result = detectRateLimitError(text);
  assert.equal(result.isRateLimited, true);
});

// ── computeCooldownUntil ────────────────────────────────────────────────────

test("computeCooldownUntil uses retryAfterMs when provided", () => {
  const before = Date.now();
  const result = computeCooldownUntil(5000);
  const parsed = new Date(result).getTime();
  assert.ok(parsed >= before + 4900);
  assert.ok(parsed <= before + 5200);
});

test("computeCooldownUntil uses default 60s when retryAfterMs is null", () => {
  const before = Date.now();
  const result = computeCooldownUntil(null);
  const parsed = new Date(result).getTime();
  assert.ok(parsed >= before + 59_000);
  assert.ok(parsed <= before + 61_000);
});

test("computeCooldownUntil uses custom default when provided", () => {
  const before = Date.now();
  const result = computeCooldownUntil(null, 120_000);
  const parsed = new Date(result).getTime();
  assert.ok(parsed >= before + 119_000);
  assert.ok(parsed <= before + 121_000);
});

test("computeCooldownUntil returns valid ISO string", () => {
  const result = computeCooldownUntil(1000);
  assert.ok(!Number.isNaN(new Date(result).getTime()));
});
