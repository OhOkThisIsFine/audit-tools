import test from "node:test";
import assert from "node:assert/strict";

const { extractRateLimitHeaders } = await import("../src/quota/headerExtraction.ts");
const { getHeaderExtractorForProvider } = await import("../src/quota/headerExtractors/index.ts");

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

// ── zero remaining values (COR-c7af6f1b) ───────────────────────────────────

test("parseNumericValue correctly handles zero for remaining_requests (x-ratelimit)", () => {
  const text = "x-ratelimit-limit-requests: 50\nx-ratelimit-remaining-requests: 0";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.remaining_requests, 0, "remaining_requests should be 0, not null");
});

test("parseNumericValue correctly handles zero for remaining_tokens (x-ratelimit)", () => {
  const text = "x-ratelimit-limit-tokens: 100000\nx-ratelimit-remaining-tokens: 0";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.remaining_tokens, 0, "remaining_tokens should be 0, not null");
});

test("parseNumericValue correctly handles zero for remaining_requests (anthropic-ratelimit)", () => {
  const text = "anthropic-ratelimit-requests-limit: 60\nanthropic-ratelimit-requests-remaining: 0";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.remaining_requests, 0, "remaining_requests should be 0, not null");
});

test("parseNumericValue correctly handles zero for remaining_tokens (anthropic-ratelimit)", () => {
  const text = "anthropic-ratelimit-tokens-limit: 200000\nanthropic-ratelimit-tokens-remaining: 0";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.remaining_tokens, 0, "remaining_tokens should be 0, not null");
});

test("extractFromHeaderObject path: remaining_requests 0 alongside non-zero limit returns 0", () => {
  // Force the JSON/header-object path by embedding in JSON that matches extractFromJson
  const text = JSON.stringify({
    "x-ratelimit-limit-requests": "50",
    "x-ratelimit-limit-tokens": "100000",
    "x-ratelimit-remaining-requests": "0",
  });
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.remaining_requests, 0, "extractFromHeaderObject: remaining_requests should be 0, not null");
});

test("positive remaining values still parse correctly", () => {
  const text = "x-ratelimit-limit-requests: 50\nx-ratelimit-remaining-requests: 5";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.remaining_requests, 5);
});

test("negative remaining values still return null", () => {
  // -1 should not parse as a valid remaining value
  const text = "x-ratelimit-limit-requests: 50\nx-ratelimit-remaining-requests: -1";
  const result = extractRateLimitHeaders(text);
  // remaining_requests is null (negative not valid), but requests_per_minute still parsed
  assert.notEqual(result, null);
  assert.equal(result.remaining_requests, null, "negative remaining should produce null");
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

// ── singleton identity (MNT-9c585b98) ─────────────────────────────────────

test("getHeaderExtractorForProvider returns same instance on repeated calls for a known provider", () => {
  const a = getHeaderExtractorForProvider("claude-code");
  const b = getHeaderExtractorForProvider("claude-code");
  assert.strictEqual(a, b, "claude-code extractor should be a singleton, not a new instance per call");
});

test("getHeaderExtractorForProvider returns same generic instance on repeated calls for an unknown provider", () => {
  const a = getHeaderExtractorForProvider("unknown-provider");
  const b = getHeaderExtractorForProvider("other-unknown");
  assert.strictEqual(a, b, "generic fallback extractor should be the same singleton for all unknown providers");
});

// ── parseResetValue branches (TST-b225b404) ────────────────────────────────

test("parseResetValue: relative seconds with 's' suffix sets reset_at to a future ISO timestamp", () => {
  const before = Date.now();
  const text = "x-ratelimit-limit-requests: 1\nx-ratelimit-reset-requests: 42s";
  const result = extractRateLimitHeaders(text);
  const after = Date.now();
  assert.notEqual(result, null);
  assert.notEqual(result.reset_at, null);
  const ts = new Date(result.reset_at).getTime();
  assert.ok(ts >= before + 42000, `reset_at (${ts}) should be >= before+42s (${before + 42000})`);
  assert.ok(ts <= after + 42000, `reset_at (${ts}) should be <= after+42s (${after + 42000})`);
});

test("parseResetValue: plain numeric relative seconds (no suffix) sets reset_at to a future ISO timestamp", () => {
  const before = Date.now();
  const text = "x-ratelimit-limit-requests: 1\nx-ratelimit-reset-requests: 10";
  const result = extractRateLimitHeaders(text);
  const after = Date.now();
  assert.notEqual(result, null);
  assert.notEqual(result.reset_at, null);
  const ts = new Date(result.reset_at).getTime();
  assert.ok(ts >= before + 10000, `reset_at (${ts}) should be >= before+10s (${before + 10000})`);
  assert.ok(ts <= after + 10000, `reset_at (${ts}) should be <= after+10s (${after + 10000})`);
});

test("parseResetValue: blank reset header value leaves reset_at null", () => {
  // Whitespace-only value: trimmed is empty, transform returns null
  const text = "x-ratelimit-limit-requests: 1\nx-ratelimit-reset-requests:   ";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.reset_at, null);
});

test("parseResetValue: non-ISO non-numeric value is returned as-is", () => {
  const text = "x-ratelimit-limit-requests: 1\nx-ratelimit-reset-requests: unknown";
  const result = extractRateLimitHeaders(text);
  assert.notEqual(result, null);
  assert.equal(result.reset_at, "unknown");
});

// ── OBS-34ce7e45: stderr diagnostics on silent null returns ─────────────────

test("extractRateLimitHeaders emits diagnostic to stderr when non-empty text has no matching headers", () => {
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    const result = extractRateLimitHeaders("some random log output\nerror: something failed\n");
    assert.equal(result, null);
    const combined = chunks.join("");
    assert.ok(
      combined.includes("[quota] header extraction: no rate-limit data found in non-empty stderr text"),
      `expected diagnostic in stderr, got: ${combined}`,
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

test("extractRateLimitHeaders does NOT emit diagnostic for empty input", () => {
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    const result = extractRateLimitHeaders("");
    assert.equal(result, null);
    const combined = chunks.join("");
    assert.ok(
      !combined.includes("[quota] header extraction:"),
      `unexpected diagnostic in stderr for empty input: ${combined}`,
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

test("extractRateLimitHeaders does NOT emit diagnostic for whitespace-only input", () => {
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    const result = extractRateLimitHeaders("   \n\t  ");
    assert.equal(result, null);
    const combined = chunks.join("");
    assert.ok(
      !combined.includes("[quota] header extraction:"),
      `unexpected diagnostic in stderr for whitespace input: ${combined}`,
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

test("ClaudeCodeHeaderExtractor emits diagnostic when no structured JSON header lines are found in non-empty stderr", () => {
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    const extractor = getHeaderExtractorForProvider("claude-code");
    extractor.extract("plain text line\nanother plain line\n");
    const combined = chunks.join("");
    assert.ok(
      combined.includes("[quota] claude-code header extractor: no structured JSON lines with headers/response_headers found in non-empty stderr"),
      `expected fallback diagnostic in stderr, got: ${combined}`,
    );
  } finally {
    process.stderr.write = origWrite;
  }
});

test("ClaudeCodeHeaderExtractor does NOT emit fallback diagnostic when structured JSON header lines are found", () => {
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    const stderr = [
      '{"level":"info","message":"Starting session"}',
      JSON.stringify({ headers: { "x-ratelimit-limit-requests": 50, "x-ratelimit-limit-tokens": 100000 } }),
    ].join("\n");
    const extractor = getHeaderExtractorForProvider("claude-code");
    const result = extractor.extract(stderr);
    assert.notEqual(result, null);
    const combined = chunks.join("");
    assert.ok(
      !combined.includes("[quota] claude-code header extractor: no structured JSON lines"),
      `unexpected fallback diagnostic when structured lines present: ${combined}`,
    );
  } finally {
    process.stderr.write = origWrite;
  }
});
