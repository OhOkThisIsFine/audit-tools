export interface ExtractedRateLimits {
  requests_per_minute: number | null;
  input_tokens_per_minute: number | null;
  remaining_requests: number | null;
  remaining_tokens: number | null;
  reset_at: string | null;
}

const HEADER_PATTERNS: Array<{
  pattern: RegExp;
  field: keyof ExtractedRateLimits;
  transform?: (value: string) => number | string | null;
}> = [
  // Standard x-ratelimit-* (OpenAI, Anthropic, and others)
  { pattern: /x-ratelimit-limit-requests:\s*(\d+)/i, field: "requests_per_minute" },
  { pattern: /x-ratelimit-limit-tokens:\s*(\d+)/i, field: "input_tokens_per_minute" },
  { pattern: /x-ratelimit-remaining-requests:\s*(\d+)/i, field: "remaining_requests" },
  { pattern: /x-ratelimit-remaining-tokens:\s*(\d+)/i, field: "remaining_tokens" },
  { pattern: /x-ratelimit-reset-requests:\s*(.+)/i, field: "reset_at", transform: parseResetValue },
  { pattern: /x-ratelimit-reset-tokens:\s*(.+)/i, field: "reset_at", transform: parseResetValue },

  // Anthropic-specific header naming
  { pattern: /anthropic-ratelimit-requests-limit:\s*(\d+)/i, field: "requests_per_minute" },
  { pattern: /anthropic-ratelimit-tokens-limit:\s*(\d+)/i, field: "input_tokens_per_minute" },
  { pattern: /anthropic-ratelimit-requests-remaining:\s*(\d+)/i, field: "remaining_requests" },
  { pattern: /anthropic-ratelimit-tokens-remaining:\s*(\d+)/i, field: "remaining_tokens" },
  { pattern: /anthropic-ratelimit-requests-reset:\s*(.+)/i, field: "reset_at", transform: parseResetValue },
  { pattern: /anthropic-ratelimit-tokens-reset:\s*(.+)/i, field: "reset_at", transform: parseResetValue },
];

function parseResetValue(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // ISO timestamp
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return trimmed;
  // Relative seconds (e.g. "42s", "42")
  const seconds = parseFloat(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return trimmed;
}

function parseNumericValue(value: string): number | null {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function extractRateLimitHeaders(text: string): ExtractedRateLimits | null {
  const result: ExtractedRateLimits = {
    requests_per_minute: null,
    input_tokens_per_minute: null,
    remaining_requests: null,
    remaining_tokens: null,
    reset_at: null,
  };

  let found = false;

  for (const { pattern, field, transform } of HEADER_PATTERNS) {
    const match = pattern.exec(text);
    if (!match || !match[1]) continue;
    if (result[field] != null) continue; // first match wins

    if (transform) {
      const transformed = transform(match[1]);
      if (transformed != null) {
        (result as unknown as Record<string, unknown>)[field] = transformed;
        found = true;
      }
    } else {
      const numeric = parseNumericValue(match[1]);
      if (numeric != null) {
        (result as unknown as Record<string, unknown>)[field] = numeric;
        found = true;
      }
    }
  }

  // Also try JSON objects that embed header-like fields
  if (!found) {
    const jsonResult = extractFromJson(text);
    if (jsonResult) return jsonResult;
  }

  if (!found && text.trim().length > 0) {
    process.stderr.write(
      JSON.stringify({
        event: "header_extraction_no_match",
        reason: "no rate-limit data found in non-empty stderr text",
        hint: "possible provider format change",
      }) + "\n",
    );
  }
  return found ? result : null;
}

function extractFromJson(text: string): ExtractedRateLimits | null {
  const jsonPattern = /\{[^{}]*"(?:x-ratelimit|anthropic-ratelimit|ratelimit)[^{}]*\}/gi;
  for (const match of text.matchAll(jsonPattern)) {
    try {
      const obj = JSON.parse(match[0]) as Record<string, unknown>;
      return extractFromHeaderObject(obj);
    } catch {
      // not valid JSON
    }
  }

  // Try line-by-line JSON (Claude Code stderr format)
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const headers =
        (obj["headers"] as Record<string, unknown> | undefined) ??
        (obj["response_headers"] as Record<string, unknown> | undefined);
      if (headers) {
        const extracted = extractFromHeaderObject(headers);
        if (extracted) return extracted;
      }
    } catch {
      // not valid JSON
    }
  }

  return null;
}

function extractFromHeaderObject(headers: Record<string, unknown>): ExtractedRateLimits | null {
  const get = (keys: string[]): number | null => {
    for (const key of keys) {
      const val = headers[key] ?? headers[key.toLowerCase()];
      if (val != null) {
        const n = typeof val === "number" ? val : parseInt(String(val), 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return null;
  };

  const rpm = get([
    "x-ratelimit-limit-requests",
    "anthropic-ratelimit-requests-limit",
  ]);
  const tpm = get([
    "x-ratelimit-limit-tokens",
    "anthropic-ratelimit-tokens-limit",
  ]);

  if (rpm == null && tpm == null) return null;

  return {
    requests_per_minute: rpm,
    input_tokens_per_minute: tpm,
    remaining_requests: get([
      "x-ratelimit-remaining-requests",
      "anthropic-ratelimit-requests-remaining",
    ]),
    remaining_tokens: get([
      "x-ratelimit-remaining-tokens",
      "anthropic-ratelimit-tokens-remaining",
    ]),
    reset_at: null,
  };
}
