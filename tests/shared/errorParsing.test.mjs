import { test, expect } from "vitest";

const {
  detectRateLimitError,
  detectCreditExhaustionError,
  detectCreditExhaustionFromChannel,
  detectModelUnavailableError,
  detectModelUnavailableFromChannel,
  detectRequestTooLargeError,
  detectRequestTooLargeFromChannel,
  detectQuotaSuspicious,
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

// Slice A2b — TIER 2 broad quota-suspicious pre-filter. Deliberately broad
// (routing-only, never itself a classification) so a provider death that
// matches NEITHER precise pattern above still surfaces as `quota_unclassified`
// instead of a silent, unclassified `error`.

test("detectQuotaSuspicious: matches a broad range of quota/billing-shaped words", () => {
  expect(detectQuotaSuspicious("Your account has hit a spending limit")).toBe(true);
  expect(detectQuotaSuspicious("Unexpected billing error, contact support")).toBe(true);
  expect(detectQuotaSuspicious("HTTP 429 received from upstream")).toBe(true);
  expect(detectQuotaSuspicious("throttled by the gateway")).toBe(true);
  expect(detectQuotaSuspicious("Too Many Requests")).toBe(true);
  expect(detectQuotaSuspicious("usage exceeded for this account")).toBe(true);
  expect(detectQuotaSuspicious("insufficient balance to proceed")).toBe(true);
  // Vendor prose that doesn't precisely match either TIER-1 pattern class but is
  // still recognizably quota-shaped (the exact gap this tier exists to catch).
  expect(detectQuotaSuspicious("Your organization has reached its monthly usage cap")).toBe(true);
});

test("detectQuotaSuspicious: does NOT match ordinary, non-quota-shaped text (broad but not unbounded)", () => {
  expect(detectQuotaSuspicious("The build completed successfully")).toBe(false);
  expect(detectQuotaSuspicious("TypeError: cannot read property of undefined")).toBe(false);
  expect(detectQuotaSuspicious("connection refused")).toBe(false);
  expect(detectQuotaSuspicious("")).toBe(false);
  // Adversarial-review over-fire cases: bare "exceeded"/"usage"/"credit"/"limit"
  // in ordinary crash text must NOT route a genuine bug to the quota degrade
  // (masking it) — these all matched the original loose pattern.
  expect(detectQuotaSuspicious("RangeError: Maximum call stack size exceeded")).toBe(false);
  expect(detectQuotaSuspicious("Usage: audit-code <command> [options]")).toBe(false);
  expect(detectQuotaSuspicious("TypeError: cannot read properties of undefined (reading credit)")).toBe(false);
  expect(detectQuotaSuspicious("npm WARN deprecated pkg@1.0.0: use limit-based pagination")).toBe(false);
});

test("detectQuotaSuspicious: is a superset — every precise credit/rate-limit match is ALSO quota-suspicious", () => {
  const creditText =
    "Your credit balance is too low to access the Claude API. Please go to Plans & Billing to upgrade or purchase credits.";
  expect(detectCreditExhaustionError(creditText).isCreditExhausted).toBe(true);
  expect(detectQuotaSuspicious(creditText)).toBe(true);

  const rateText = "429 Too Many Requests";
  expect(detectRateLimitError(rateText).isRateLimited).toBe(true);
  expect(detectQuotaSuspicious(rateText)).toBe(true);
});

// Backlog HIGH (2026-07-17) — model-unavailable error class (404 / not found).
// A provider that returns 404 for a model has no reset timer — the model is not
// served by that provider. detectModelUnavailableError must recognize it as a
// DISTINCT class from detectRateLimitError, never both, never neither.

test("detectModelUnavailableError: recognizes exact dogfood-run model-unavailable string (verbatim fixture)", () => {
  const dogfoodText =
    "There's an issue with the selected model (nim/moonshotai/kimi-k2.6). It may not exist or you may not have access to it. Run --model to pick a different model.";
  expect(detectModelUnavailableError(dogfoodText).isModelUnavailable).toBe(true);
  expect(detectModelUnavailableError(dogfoodText).rawMatch).toContain("may not exist");
});

test("detectModelUnavailableError: recognizes all MODEL_UNAVAILABLE_PATTERNS", () => {
  expect(detectModelUnavailableError("HTTP 404 Not Found").isModelUnavailable).toBe(true);
  expect(detectModelUnavailableError("model_not_found").isModelUnavailable).toBe(true);
  expect(detectModelUnavailableError("This model may not exist or you may not have access to it.").isModelUnavailable).toBe(true);
  expect(detectModelUnavailableError("no such model available").isModelUnavailable).toBe(true);
  expect(detectModelUnavailableError("does not exist or you do not have access").isModelUnavailable).toBe(true);
});

test("detectModelUnavailableError: a 404 is NOT classified as rate-limited", () => {
  const notFoundText = "HTTP 404 Not Found: model does not exist or you do not have access";
  expect(detectModelUnavailableError(notFoundText).isModelUnavailable).toBe(true);
  expect(detectRateLimitError(notFoundText).isRateLimited).toBe(false);
});

test("detectModelUnavailableFromChannel: channel-isolated (CE-003 parallel) — only error/status trip it, never result", () => {
  const text = "This model may not exist or you may not have access to it.";
  expect(detectModelUnavailableFromChannel("error", text).isModelUnavailable).toBe(true);
  expect(detectModelUnavailableFromChannel("status", text).isModelUnavailable).toBe(true);
  // A healthy AuditResult that merely QUOTES a model-unavailable string must never trip it via the result channel.
  expect(detectModelUnavailableFromChannel("result", text).isModelUnavailable).toBe(false);
});

// Backlog HIGH (2026-07-17) — request-too-large error class (413).
// A packet that is too large for a particular pool indicates a sizing fault
// (not a permanent issue like credit exhaustion or model unavailability).
// detectRequestTooLargeError must recognize it as a DISTINCT class.

test("detectRequestTooLargeError: recognizes exact dogfood-run request-too-large string (verbatim fixture)", () => {
  const dogfoodText = "Request too large (max 32MB). Try with a smaller file.";
  expect(detectRequestTooLargeError(dogfoodText).isRequestTooLarge).toBe(true);
  expect(detectRequestTooLargeError(dogfoodText).rawMatch).toContain("Request too large");
});

test("detectRequestTooLargeError: recognizes all REQUEST_TOO_LARGE_PATTERNS", () => {
  expect(detectRequestTooLargeError("request too large for this endpoint").isRequestTooLarge).toBe(true);
  expect(detectRequestTooLargeError("HTTP 413 Payload Too Large").isRequestTooLarge).toBe(true);
  expect(detectRequestTooLargeError("payload too large").isRequestTooLarge).toBe(true);
  expect(detectRequestTooLargeError("content too long").isRequestTooLarge).toBe(true);
});

test("detectRequestTooLargeError: a 413 is NOT classified as rate-limited or model-unavailable", () => {
  const tooLargeText = "Request too large (max 32MB). Try with a smaller file.";
  expect(detectRequestTooLargeError(tooLargeText).isRequestTooLarge).toBe(true);
  expect(detectRateLimitError(tooLargeText).isRateLimited).toBe(false);
  expect(detectModelUnavailableError(tooLargeText).isModelUnavailable).toBe(false);
});

test("detectRequestTooLargeError: a 413 is NOT matched by detectQuotaSuspicious (cross-exclusivity)", () => {
  const tooLargeText = "Request too large (max 32MB). Try with a smaller file.";
  expect(detectRequestTooLargeError(tooLargeText).isRequestTooLarge).toBe(true);
  // Confirmed by spec F4: detectQuotaSuspicious does NOT match the groq 413 text.
  expect(detectQuotaSuspicious(tooLargeText)).toBe(false);
});

test("detectRequestTooLargeFromChannel: channel-isolated (CE-003 parallel) — only error/status trip it, never result", () => {
  const text = "payload too large";
  expect(detectRequestTooLargeFromChannel("error", text).isRequestTooLarge).toBe(true);
  expect(detectRequestTooLargeFromChannel("status", text).isRequestTooLarge).toBe(true);
  // A healthy AuditResult that merely quotes a too-large string must never trip it via the result channel.
  expect(detectRequestTooLargeFromChannel("result", text).isRequestTooLarge).toBe(false);
});

// Cross-exclusivity: the three TIER-1 detectors must be disjoint.
test("TIER-1 detectors are mutually exclusive: rate-limit dogfood string", () => {
  const rateText = 'API Error: Request rejected (429) · openai backend HTTP 429: {"status":429,"title":"Too Many Requests"}';
  expect(detectRateLimitError(rateText).isRateLimited).toBe(true);
  expect(detectModelUnavailableError(rateText).isModelUnavailable).toBe(false);
  expect(detectRequestTooLargeError(rateText).isRequestTooLarge).toBe(false);
  expect(detectCreditExhaustionError(rateText).isCreditExhausted).toBe(false);
});

test("TIER-1 detectors are mutually exclusive: model-unavailable dogfood string", () => {
  const notFoundText =
    "There's an issue with the selected model (nim/moonshotai/kimi-k2.6). It may not exist or you may not have access to it. Run --model to pick a different model.";
  expect(detectRateLimitError(notFoundText).isRateLimited).toBe(false);
  expect(detectModelUnavailableError(notFoundText).isModelUnavailable).toBe(true);
  expect(detectRequestTooLargeError(notFoundText).isRequestTooLarge).toBe(false);
  expect(detectCreditExhaustionError(notFoundText).isCreditExhausted).toBe(false);
});

test("TIER-1 detectors are mutually exclusive: request-too-large dogfood string", () => {
  const tooLargeText = "Request too large (max 32MB). Try with a smaller file.";
  expect(detectRateLimitError(tooLargeText).isRateLimited).toBe(false);
  expect(detectModelUnavailableError(tooLargeText).isModelUnavailable).toBe(false);
  expect(detectRequestTooLargeError(tooLargeText).isRequestTooLarge).toBe(true);
  expect(detectCreditExhaustionError(tooLargeText).isCreditExhausted).toBe(false);
});
