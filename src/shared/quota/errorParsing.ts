export interface RateLimitDetectionResult {
  isRateLimited: boolean;
  retryAfterMs: number | null;
  rawMatch: string | null;
}

const RATE_LIMIT_PATTERNS = [
  /\b429\b/i,
  /\btoo many requests\b/i,
  /\brate.?limit/i,
  /\boverloaded\b/i,
  /\bresource.?exhausted\b/i,
  /\bquota.?exceeded\b/i,
];

// Host *account* usage caps (e.g. Claude Code's "You've hit your session limit ·
// resets 3:30pm"). A worker that hits one returns this sentinel instead of a
// result; it should be treated like a rate limit — pause until the stated reset
// rather than re-dispatch into the active cap. Kept specific to avoid matching
// the word "limit" in ordinary audit output.
const USAGE_LIMIT_PATTERNS = [
  /hit your (?:session|usage|account|daily|weekly) limit/i,
  /reached your (?:session|usage|account|daily|weekly) limit/i,
  /\b(?:session|usage) limit reached\b/i,
];

const ALL_RATE_LIMIT_PATTERNS = [...RATE_LIMIT_PATTERNS, ...USAGE_LIMIT_PATTERNS];

// Credit exhaustion (the account/API key has run out of PREPAID usage credits,
// e.g. Anthropic's "Your credit balance is too low" or OpenAI-compatible
// `insufficient_quota`) is architecturally distinct from a rate limit: it
// carries NO reset time — the condition does not clear on a timer, only when an
// operator adds credits. Patterns are deliberately exact vendor wording so an
// ordinary resettable 429 / "quota exceeded" (RATE_LIMIT_PATTERNS, which DOES
// reset) is never misclassified as unrecoverable, and vice versa. The
// `exceeded your current quota` phrase gap is BOUNDED (no wildcard span across a
// resettable clause), and `RESET_INDICATOR_PATTERN` below is a hard veto on any
// free-text match whose message self-describes as resettable — because
// permanently sinking a pool that would have recovered is worse than the bug
// this fixes (adversarial-review finding, 2026-07-11).
const CREDIT_EXHAUSTION_PATTERNS = [
  /credit balance is too low/i,
  /\bout of (?:usage )?credits\b/i,
  /\binsufficient credits\b/i,
  /\bno credits? remaining\b/i,
  /\bpurchase (?:more )?credits\b/i,
  /exceeded your current quota,? please check your plan and billing details/i,
];

// A message that says it RESETS / is transient is a rate limit, never permanent
// credit exhaustion — veto any free-text credit match when these appear. (The
// structured `insufficient_quota` JSON code is exempt: it is an unambiguous
// vendor billing signal, trusted even if the surrounding prose mentions retry.)
const RESET_INDICATOR_PATTERN =
  /\b(?:resets?|resetting|retry|retry[- ]after|temporar(?:y|ily)|transient|per[- ]?(?:minute|second|hour|day)|try again|rate[- ]?limit)\b/i;

function tryParseJson(text: string): Record<string, unknown> | null {
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    return JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toPositiveNumber(value: string | number | undefined): number | null {
  if (value == null) return null;
  const val = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(val) || val <= 0) return null;
  return val;
}

function extractRetryAfterMs(obj: Record<string, unknown>): number | null {
  // A *_ms field is already in milliseconds and must NOT be scaled. Prefer it
  // when present, returning it verbatim.
  const retryAfterMs = toPositiveNumber(
    obj["retry_after_ms"] as string | number | undefined,
  );
  if (retryAfterMs != null) return retryAfterMs;

  const headers = obj["headers"] as Record<string, unknown> | undefined;
  const retryAfterSeconds = toPositiveNumber(
    (headers?.["retry-after"] as string | number | undefined) ??
      (headers?.["Retry-After"] as string | number | undefined) ??
      (obj["retry_after"] as string | number | undefined),
  );
  if (retryAfterSeconds == null) return null;
  // Retry-After (RFC 7231) and retry_after fields are always in seconds; convert to ms.
  return retryAfterSeconds * 1000;
}

function detectFromJson(text: string): RateLimitDetectionResult | null {
  const obj = tryParseJson(text);
  if (!obj) return null;

  const status = obj["status"] as number | undefined;
  const type = obj["type"] as string | undefined;
  const errorObj = obj["error"] as Record<string, unknown> | undefined;
  const errorType = errorObj?.["type"] as string | undefined;

  const isRateLimited =
    status === 429 ||
    type === "rate_limit_error" ||
    errorType === "rate_limit_error";

  if (!isRateLimited) return null;

  return {
    isRateLimited: true,
    retryAfterMs: extractRetryAfterMs(obj),
    rawMatch: `json:${status === 429 ? "status=429" : `type=${type ?? errorType}`}`,
  };
}

/** Detection result for the non-resettable credit-exhaustion error class. */
export interface CreditExhaustionDetectionResult {
  isCreditExhausted: boolean;
  rawMatch: string | null;
}

// OpenAI-compatible endpoints (OpenAI itself, and NIM/vLLM/LM Studio proxies
// that mirror the shape) report billing-hard-limit exhaustion with the
// structured `error.type`/`error.code === "insufficient_quota"` — a precise,
// vendor-defined signal distinct from `rate_limit_error`/status 429.
function detectCreditExhaustionFromJson(
  text: string,
): CreditExhaustionDetectionResult | null {
  const obj = tryParseJson(text);
  if (!obj) return null;

  const errorObj = obj["error"] as Record<string, unknown> | undefined;
  const errorType = errorObj?.["type"] as string | undefined;
  const errorCode = errorObj?.["code"] as string | undefined;

  const isCreditExhausted =
    errorType === "insufficient_quota" || errorCode === "insufficient_quota";

  if (!isCreditExhausted) return null;

  return {
    isCreditExhausted: true,
    rawMatch: `json:type=${errorType ?? errorCode}`,
  };
}

/**
 * Detect a non-resettable credit-exhaustion condition (out of prepaid usage
 * credits) — distinct from {@link detectRateLimitError}: a positive result here
 * carries no retry-after/reset semantics, ever. A caller must exclude the pool
 * from the admissible set for the remainder of the run rather than apply a
 * timed cooldown.
 */
export function detectCreditExhaustionError(
  text: string,
): CreditExhaustionDetectionResult {
  const jsonResult = detectCreditExhaustionFromJson(text);
  if (jsonResult) return jsonResult;

  // A message that self-describes as resettable/transient is a rate limit, not
  // permanent credit exhaustion — never sink such a pool for the whole run.
  if (RESET_INDICATOR_PATTERN.test(text)) {
    return { isCreditExhausted: false, rawMatch: null };
  }

  for (const pattern of CREDIT_EXHAUSTION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { isCreditExhausted: true, rawMatch: match[0] };
    }
  }

  return { isCreditExhausted: false, rawMatch: null };
}

/**
 * Channel-isolated credit-exhaustion detection (CE-003, mirrors
 * {@link detectRateLimitFromChannel}): only the worker's `error`/`status`
 * channel is inspected, never the consumed `result` channel, so a healthy
 * AuditResult that merely quotes a credit-exhaustion string can never trip it.
 */
export function detectCreditExhaustionFromChannel(
  channel: WorkerOutputChannel,
  text: string,
): CreditExhaustionDetectionResult {
  if (channel === "result") {
    return { isCreditExhausted: false, rawMatch: null };
  }
  return detectCreditExhaustionError(text);
}

/** Detection result for the model-unavailable error class (404 / not found). */
export interface ModelUnavailableDetectionResult {
  isModelUnavailable: boolean;
  rawMatch: string | null;
}

// Model-unavailable patterns (HTTP 404, "not found", "may not exist", etc.).
// Distinct from rate limits and credit exhaustion — a 404 is permanent for the
// run (the model is not served by this provider) and should trigger pool
// exclusion without cooldown.
const MODEL_UNAVAILABLE_PATTERNS = [
  /\b404\b/,
  /model_not_found/i,
  /\bmay not exist\b/i,
  /no such model/i,
  /does not exist or you do not have access/i,
];

/**
 * Detect a model-unavailable condition (HTTP 404, "not found" class) — distinct
 * from {@link detectRateLimitError}: a positive result here means the model is
 * not served by this provider and the pool should be excluded for the run
 * (never re-queued to this pool, but other pools/packets unaffected).
 */
export function detectModelUnavailableError(
  text: string,
): ModelUnavailableDetectionResult {
  for (const pattern of MODEL_UNAVAILABLE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { isModelUnavailable: true, rawMatch: match[0] };
    }
  }

  return { isModelUnavailable: false, rawMatch: null };
}

/**
 * Channel-isolated model-unavailable detection (mirrors
 * {@link detectRateLimitFromChannel}): only the worker's `error`/`status`
 * channel is inspected, never the consumed `result` channel, so a healthy
 * AuditResult that merely quotes a not-found string can never trip it.
 */
export function detectModelUnavailableFromChannel(
  channel: WorkerOutputChannel,
  text: string,
): ModelUnavailableDetectionResult {
  if (channel === "result") {
    return { isModelUnavailable: false, rawMatch: null };
  }
  return detectModelUnavailableError(text);
}

/** Detection result for the request-too-large error class (HTTP 413). */
export interface RequestTooLargeDetectionResult {
  isRequestTooLarge: boolean;
  rawMatch: string | null;
}

// Request-too-large patterns (HTTP 413, "request too large", "payload too large", etc.).
// Distinct from rate limits and credit exhaustion — a 413 indicates a packet
// sizing fault (for this particular packet/pool combination) and should trigger
// a per-packet skip for that pool without cooldown.
const REQUEST_TOO_LARGE_PATTERNS = [
  /request too large/i,
  /\b413\b/,
  /payload too large/i,
  /content too long/i,
];

/**
 * Detect a request-too-large condition (HTTP 413, "request too large" class) —
 * distinct from {@link detectRateLimitError}: a positive result here means the
 * packet is too large for this particular pool and should skip that pool
 * (without cooldown; a sizing fault must not cool a healthy pool), but other
 * packets and pools are unaffected.
 */
export function detectRequestTooLargeError(
  text: string,
): RequestTooLargeDetectionResult {
  for (const pattern of REQUEST_TOO_LARGE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { isRequestTooLarge: true, rawMatch: match[0] };
    }
  }

  return { isRequestTooLarge: false, rawMatch: null };
}

/**
 * Channel-isolated request-too-large detection (mirrors
 * {@link detectRateLimitFromChannel}): only the worker's `error`/`status`
 * channel is inspected, never the consumed `result` channel, so a healthy
 * AuditResult that merely quotes a too-large string can never trip it.
 */
export function detectRequestTooLargeFromChannel(
  channel: WorkerOutputChannel,
  text: string,
): RequestTooLargeDetectionResult {
  if (channel === "result") {
    return { isRequestTooLarge: false, rawMatch: null };
  }
  return detectRequestTooLargeError(text);
}

// Slice A2b (TIER 2 of the three-tier classifier — see rollingDispatch.ts's
// header doc for the full design): a deliberately BROAD, routing-only
// pre-filter for "does this text merely SMELL quota/billing-related?". Neither
// CREDIT_EXHAUSTION_PATTERNS nor ALL_RATE_LIMIT_PATTERNS is exhaustive — a
// provider death whose text matches neither currently falls through to a raw,
// silent `error` outcome (the exact failure mode credit-exhaustion detection
// fixed, but only for text it recognizes). This pattern is intentionally far
// broader than either precise class: a false positive here only routes an
// unmatched death to the CONSERVATIVE `quota_unclassified` degrade (re-queue +
// reversible cooldown, never a permanent pool exclusion — see
// `rollingDispatch.ts`) instead of a silent raw error, so over-matching is
// cheap. It is NEVER used to classify a `credit_exhausted` or `rate_limited`
// outcome — those stay owned by their precise detectors above, checked first.
// Broad — but NOT so broad it fires on ordinary crash text. Bare "limit" /
// "usage" / "credit" / "exceeded" / "rate" matched generic failures ("Maximum
// call stack size exceeded", a CLI "Usage:" banner, "...(reading credit)",
// "limit-based pagination") — adversarial-review finding. Require quota/billing-
// SPECIFIC phrasing (a qualifier before "limit", "credits" not bare "credit",
// etc.). Genuinely novel wording the precise detectors AND this filter both miss
// is caught by the host-observation net (triage.ts mechanism B), so erring
// slightly narrow here is safe; erring broad masks a real bug as a quota event.
const QUOTA_SUSPICIOUS_PATTERN =
  /\b(?:quota|billing|429|402|payment required|too many requests|throttl(?:e|ed|ing)|insufficient (?:quota|credits?|balance|funds)|credit balance|out of (?:usage |prepaid )?credits?|(?:no )?credits? (?:remaining|left)|(?:usage|rate|spend(?:ing)?|session|account|daily|weekly|monthly|token|request|concurrency)[- ]?(?:limit|cap)|(?:quota|usage|credit|rate|plan|token|request|spend(?:ing)?)\s+(?:exceeded|reached)|limit (?:reached|exceeded|hit)|rate[- ]?limit(?:ed|ing)?|exceeded your (?:current )?(?:quota|limit|usage|plan)|over (?:your )?(?:quota|limit))\b/i;

/**
 * TIER 2 broad pre-filter (Slice A2b): true when `text` merely smells
 * quota/billing-related. Deliberately over-broad and routing-ONLY — a positive
 * result is never a classification by itself (see
 * {@link detectCreditExhaustionError} / {@link detectRateLimitError} for the
 * precise, acted-on classes). Callers use a positive result only to decide
 * whether an otherwise-unmatched provider death should surface as the
 * conservative `quota_unclassified` outcome (re-queue + verbatim-message
 * harvest for pattern improvement) rather than a silent, unclassified `error`.
 */
export function detectQuotaSuspicious(text: string): boolean {
  return QUOTA_SUSPICIOUS_PATTERN.test(text);
}

function extractResetsInMs(text: string): number | null {
  const match = /Resets in (?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(text);
  if (!match) return null;
  const hours = match[1] ? parseInt(match[1], 10) : 0;
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  if (hours === 0 && minutes === 0 && seconds === 0) return null;
  // Add 5 seconds of buffer
  return (hours * 3600 + minutes * 60 + seconds + 5) * 1000;
}

// Parse a wall-clock reset like "resets 3:30pm" or "resets at 15:30" into ms
// until the next occurrence of that local time. Session-limit sentinels state a
// clock time rather than a duration. Returns null when absent/ambiguous.
function extractResetsAtClockMs(text: string, now: number): number | null {
  const match = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  const ms = target.getTime() - now;
  return ms > 0 ? ms + 5000 : null;
}

/**
 * The worker output channel a piece of text came from. Host *session-limit*
 * sentinels are only trustworthy from the ERROR / STATUS channel: the consumed
 * AuditResult finding content is attacker- / model-controlled prose that may
 * legitimately *quote* a limit string (e.g. a finding describing a rate-limit
 * bug). Treating that as a real session cap would let result content pause the
 * run. CE-003 channel isolation: only `error` / `status` may trip a session
 * limit; `result` is parsed for nothing.
 */
export type WorkerOutputChannel = "error" | "status" | "result";

/**
 * Channel-isolated session-limit detection (CE-003). The single entry point a
 * dispatch consumer MUST use when the text originates from worker output: it
 * refuses to inspect the consumed-result channel, so a healthy AuditResult that
 * merely quotes a limit string can never consume a pause. Only `error` /
 * `status` text is forwarded to {@link detectRateLimitError}.
 */
export function detectRateLimitFromChannel(
  channel: WorkerOutputChannel,
  text: string,
  now: number = Date.now(),
): RateLimitDetectionResult {
  if (channel === "result") {
    return { isRateLimited: false, retryAfterMs: null, rawMatch: null };
  }
  return detectRateLimitError(text, now);
}

export function detectRateLimitError(
  text: string,
  now: number = Date.now(),
): RateLimitDetectionResult {
  const jsonResult = detectFromJson(text);
  if (jsonResult) return jsonResult;

  for (const pattern of ALL_RATE_LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        isRateLimited: true,
        retryAfterMs: extractResetsInMs(text) ?? extractResetsAtClockMs(text, now),
        rawMatch: match[0],
      };
    }
  }

  return { isRateLimited: false, retryAfterMs: null, rawMatch: null };
}

export const DEFAULT_COOLDOWN_MS = 60_000;

export function computeCooldownUntil(
  retryAfterMs: number | null,
  defaultMs: number = DEFAULT_COOLDOWN_MS,
  now: number = Date.now(),
): string {
  const ms = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : defaultMs;
  return new Date(now + ms).toISOString();
}
