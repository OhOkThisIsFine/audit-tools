import type { RateLimitDetectionResult } from "../errorParsing.js";
import type { ErrorParser } from "./genericErrorParser.js";

export class ClaudeCodeErrorParser implements ErrorParser {
  readonly name = "claude-code";

  parse(text: string): RateLimitDetectionResult {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;

      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;

        const level = obj["level"] as string | undefined;
        const type = obj["type"] as string | undefined;
        const message = (obj["message"] as string) ?? "";
        const statusCode = obj["status_code"] as number | undefined;

        if (
          statusCode === 429 ||
          type === "rate_limit_error" ||
          (level === "error" && /\brate.?limit/i.test(message))
        ) {
          const retryAfter = obj["retry_after"] as number | undefined;
          const retryAfterMs = obj["retry_after_ms"] as number | undefined;
          let extractedMs: number | null = null;
          if (retryAfterMs != null && retryAfterMs > 0) {
            extractedMs = retryAfterMs;
          } else if (retryAfter != null && retryAfter > 0) {
            extractedMs = retryAfter < 600 ? retryAfter * 1000 : retryAfter;
          }

          return {
            isRateLimited: true,
            retryAfterMs: extractedMs,
            rawMatch: `claude-code-stderr:${statusCode ?? type ?? "rate_limit"}`,
          };
        }
      } catch {
        // Not valid JSON, skip
      }
    }

    return { isRateLimited: false, retryAfterMs: null, rawMatch: null };
  }
}
