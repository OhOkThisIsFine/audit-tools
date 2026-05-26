import test from "node:test";
import assert from "node:assert/strict";

const { extractRateLimitHeaders } = await import("../dist/quota/headerExtraction.js");
const { getHeaderExtractorForProvider } = await import("../dist/quota/headerExtractors/index.js");

// ── extractRateLimitHeaders ─────────────────────────────────────────────────

test("extracts standard x-ratelimit-* headers", () => {
  const text = [
    "x-ratelimit-limit-requests: 50",
    "x-ratelimit-limit-tokens: 100000",
    "x-ratelimit-remaining-requests: 42",
    "x-ratelimit-remaining-tokens: 80000",
  ].join("\n");

  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 50);
  assert.equal(result.input_tokens_per_minute, 100000);
  assert.equal(result.remaining_requests, 42);
  assert.equal(result.remaining_tokens, 80000);
});

test("extracts anthropic-ratelimit-* headers", () => {
  const text = [
    "anthropic-ratelimit-requests-limit: 60",
    "anthropic-ratelimit-tokens-limit: 200000",
    "anthropic-ratelimit-requests-remaining: 55",
    "anthropic-ratelimit-tokens-remaining: 190000",
  ].join("\n");

  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 60);
  assert.equal(result.input_tokens_per_minute, 200000);
  assert.equal(result.remaining_requests, 55);
  assert.equal(result.remaining_tokens, 190000);
});

test("case-insensitive header matching", () => {
  const text = "X-RateLimit-Limit-Requests: 25\nX-RATELIMIT-LIMIT-TOKENS: 50000";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 25);
  assert.equal(result.input_tokens_per_minute, 50000);
});

test("first match wins for duplicate headers", () => {
  const text = [
    "x-ratelimit-limit-requests: 50",
    "anthropic-ratelimit-requests-limit: 60",
  ].join("\n");

  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 50);
});

test("returns null for text without rate limit headers", () => {
  const text = "some random log output\nerror: something failed\n";
  const result = extractRateLimitHeaders(text);
  assert.equal(result, null);
});

test("extracts from JSON objects with header fields", () => {
  const text = JSON.stringify({
    headers: {
      "x-ratelimit-limit-requests": "40",
      "x-ratelimit-limit-tokens": "80000",
      "x-ratelimit-remaining-requests": "38",
    },
  });

  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 40);
  assert.equal(result.input_tokens_per_minute, 80000);
  assert.equal(result.remaining_requests, 38);
});

test("extracts from JSON lines with response_headers", () => {
  const text = [
    '{"level":"info","message":"request started"}',
    JSON.stringify({
      response_headers: {
        "anthropic-ratelimit-requests-limit": 30,
        "anthropic-ratelimit-tokens-limit": 150000,
      },
    }),
    '{"level":"info","message":"request completed"}',
  ].join("\n");

  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 30);
  assert.equal(result.input_tokens_per_minute, 150000);
});

test("ignores invalid numeric values", () => {
  const text = "x-ratelimit-limit-requests: abc\nx-ratelimit-limit-tokens: -5";
  const result = extractRateLimitHeaders(text);
  assert.equal(result, null);
});

// ── getHeaderExtractorForProvider ───────────────────────────────────────────

test("getHeaderExtractorForProvider returns claude-code extractor", () => {
  const extractor = getHeaderExtractorForProvider("claude-code");
  assert.equal(extractor.name, "claude-code");
});

test("getHeaderExtractorForProvider falls back to generic", () => {
  const extractor = getHeaderExtractorForProvider("opencode");
  assert.equal(extractor.name, "generic");
});

test("claude-code extractor finds headers in JSON stderr lines", () => {
  const stderr = [
    '{"level":"info","message":"Starting session"}',
    JSON.stringify({
      headers: {
        "x-ratelimit-limit-requests": 50,
        "x-ratelimit-limit-tokens": 100000,
      },
    }),
    '{"level":"info","message":"Session completed"}',
  ].join("\n");

  const extractor = getHeaderExtractorForProvider("claude-code");
  const result = extractor.extract(stderr);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 50);
  assert.equal(result.input_tokens_per_minute, 100000);
});

test("generic extractor finds raw headers in text", () => {
  const stderr = "x-ratelimit-limit-requests: 20\nx-ratelimit-limit-tokens: 40000\n";
  const extractor = getHeaderExtractorForProvider("opencode");
  const result = extractor.extract(stderr);
  assert.notEqual(result, null);
  assert.equal(result.requests_per_minute, 20);
  assert.equal(result.input_tokens_per_minute, 40000);
});
