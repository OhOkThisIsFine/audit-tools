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

export function detectRateLimitError(text: string): RateLimitDetectionResult {
  const jsonResult = detectFromJson(text);
  if (jsonResult) return jsonResult;

  for (const pattern of RATE_LIMIT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { isRateLimited: true, retryAfterMs: null, rawMatch: match[0] };
    }
  }

  return { isRateLimited: false, retryAfterMs: null, rawMatch: null };
}

const DEFAULT_COOLDOWN_MS = 60_000;

export function computeCooldownUntil(
  retryAfterMs: number | null,
  defaultMs: number = DEFAULT_COOLDOWN_MS,
): string {
  const ms = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : defaultMs;
  return new Date(Date.now() + ms).toISOString();
}
