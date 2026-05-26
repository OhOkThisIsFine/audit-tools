import type { ExtractedRateLimits } from "../headerExtraction.js";
import type { HeaderExtractor } from "./genericHeaderExtractor.js";
import { extractRateLimitHeaders } from "../headerExtraction.js";

export class ClaudeCodeHeaderExtractor implements HeaderExtractor {
  readonly name = "claude-code";

  extract(stderr: string): ExtractedRateLimits | null {
    // Claude Code emits structured JSON lines to stderr. Collect all lines
    // that might contain header data and feed them to the agnostic parser.
    const candidates: string[] = [];
    for (const line of stderr.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        if (obj["headers"] || obj["response_headers"]) {
          candidates.push(trimmed);
        }
      } catch {
        // not JSON
      }
    }

    if (candidates.length > 0) {
      return extractRateLimitHeaders(candidates.join("\n"));
    }

    // Fall back to scanning the full text for raw header lines
    return extractRateLimitHeaders(stderr);
  }
}
