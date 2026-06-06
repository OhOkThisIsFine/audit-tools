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

function tryParseJson(text: string): Record<string, unknown> | null {
  const jsonStart = text.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    return JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractRetryAfterMs(obj: Record<string, unknown>): number | null {
  const headers = obj["headers"] as Record<string, unknown> | undefined;
  const retryAfter =
    (headers?.["retry-after"] as string | number | undefined) ??
    (headers?.["Retry-After"] as string | number | undefined) ??
    (obj["retry_after"] as string | number | undefined) ??
    (obj["retry_after_ms"] as string | number | undefined);
  if (retryAfter == null) return null;
  const val = typeof retryAfter === "string" ? Number(retryAfter) : retryAfter;
  if (!Number.isFinite(val) || val <= 0) return null;
  // If the value looks like seconds (< 600), convert to ms
  return val < 600 ? val * 1000 : val;
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

const DEFAULT_COOLDOWN_MS = 60_000;

export function computeCooldownUntil(
  retryAfterMs: number | null,
  defaultMs: number = DEFAULT_COOLDOWN_MS,
  now: number = Date.now(),
): string {
  const ms = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : defaultMs;
  return new Date(now + ms).toISOString();
}
