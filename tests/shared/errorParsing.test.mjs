import { test, expect } from "vitest";

const {
  detectRateLimitError,
  detectCreditExhaustionError,
  detectCreditExhaustionFromChannel,
} = await import("../../src/shared/quota/errorParsing.ts");
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

// Backlog HIGH (2026-07-11 live run) — credit-exhaustion error class (Slice A2).
// A deep-tier model OUT OF USAGE CREDITS has no reset timer, unlike a 429/rate
// limit. detectCreditExhaustionError must recognize it as a DISTINCT class from
// detectRateLimitError, never both, never neither.

test("detectCreditExhaustionError: recognizes exact vendor credit-exhaustion wording", () => {
  expect(
    detectCreditExhaustionError(
      "Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.",
    ).isCreditExhausted,
  ).toBe(true);
  expect(detectCreditExhaustionError("You are out of usage credits.").isCreditExhausted).toBe(true);
  expect(detectCreditExhaustionError("insufficient credits for this request").isCreditExhausted).toBe(true);
  expect(detectCreditExhaustionError("no credits remaining on this account").isCreditExhausted).toBe(true);
  expect(
    detectCreditExhaustionError(
      "You exceeded your current quota, please check your plan and billing details.",
    ).isCreditExhausted,
  ).toBe(true);
});

test("detectCreditExhaustionError: recognizes the OpenAI-compatible insufficient_quota JSON error code", () => {
  const result = detectCreditExhaustionError(
    JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        param: null,
        code: "insufficient_quota",
      },
    }),
  );
  expect(result.isCreditExhausted).toBe(true);
  expect(result.rawMatch).toContain("insufficient_quota");
});

test("detectCreditExhaustionError: a plain 429 / resettable rate limit is NOT classified as credit-exhausted", () => {
  expect(detectCreditExhaustionError("429 Too Many Requests").isCreditExhausted).toBe(false);
  expect(detectCreditExhaustionError("rate limit exceeded, please retry").isCreditExhausted).toBe(false);
  expect(detectCreditExhaustionError("quota exceeded").isCreditExhausted).toBe(false);
  expect(
    detectCreditExhaustionError(
      JSON.stringify({ status: 429, type: "rate_limit_error", retry_after: 30 }),
    ).isCreditExhausted,
  ).toBe(false);
});

// Adversarial-review finding (2026-07-11): a message that self-describes as
// RESETTABLE must never classify as permanent credit exhaustion — permanently
// sinking a pool that would have recovered is worse than the bug being fixed.
// The old unbounded `exceeded your current quota[^.]*(?:plan|billing)` regex
// matched all three of these; the reset-indicator veto now blocks them.
test("detectCreditExhaustionError: a resettable message mentioning plan/quota is NOT credit-exhausted (reset-indicator veto)", () => {
  for (const resettable of [
    "You have exceeded your current quota, resets in 60s, please check your plan for higher limits",
    "Rate limit: exceeded your current quota (per-minute), this is transient and resets automatically; see your plan",
    "exceeded your current quota\nplease review your billing settings, this is a temporary per-minute cap that resets shortly",
    "out of usage credits for this minute — retry after the window resets",
  ]) {
    expect(detectCreditExhaustionError(resettable).isCreditExhausted, resettable).toBe(false);
  }
  // The genuine, non-resettable billing message still classifies correctly.
  expect(
    detectCreditExhaustionError(
      "You exceeded your current quota, please check your plan and billing details.",
    ).isCreditExhausted,
  ).toBe(true);
  // The structured vendor code is authoritative even if prose mentions retry.
  expect(
    detectCreditExhaustionError(
      JSON.stringify({ error: { type: "insufficient_quota", message: "add credits, then retry" } }),
    ).isCreditExhausted,
  ).toBe(true);
});

test("detectRateLimitError: exact credit-exhaustion text is NOT classified as a (resettable) rate limit — the two classes are disjoint", () => {
  const creditText =
    "Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.";
  expect(detectRateLimitError(creditText).isRateLimited).toBe(false);
  expect(detectCreditExhaustionError(creditText).isCreditExhausted).toBe(true);

  const insufficientQuotaJson = JSON.stringify({
    error: { message: "no quota left", type: "insufficient_quota", code: "insufficient_quota" },
  });
  expect(detectRateLimitError(insufficientQuotaJson).isRateLimited).toBe(false);
  expect(detectCreditExhaustionError(insufficientQuotaJson).isCreditExhausted).toBe(true);
});

test("detectCreditExhaustionFromChannel: channel-isolated (CE-003) — only error/status trip it, never the consumed result channel", () => {
  const text = "Your credit balance is too low to access the Claude API.";
  expect(detectCreditExhaustionFromChannel("error", text).isCreditExhausted).toBe(true);
  expect(detectCreditExhaustionFromChannel("status", text).isCreditExhausted).toBe(true);
  // A healthy AuditResult that merely QUOTES a credit-exhaustion string (e.g. a
  // finding describing this exact bug) must never trip it via the result channel.
  expect(detectCreditExhaustionFromChannel("result", text).isCreditExhausted).toBe(false);
});
