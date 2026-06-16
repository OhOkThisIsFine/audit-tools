import type { ExtractedRateLimits } from "../headerExtraction.js";
import type { HeaderExtractor } from "./genericHeaderExtractor.js";
import { extractRateLimitHeaders } from "../headerExtraction.js";
import { collectClaudeCodeJsonLines } from "@audit-tools/shared";

export class ClaudeCodeHeaderExtractor implements HeaderExtractor {
  readonly name = "claude-code";

  extract(stderr: string): ExtractedRateLimits | null {
    // Claude Code emits structured JSON lines to stderr. Reuse the shared
    // claude-code JSON-line scan, then keep only the objects that carry header
    // data and feed them to the agnostic parser.
    const candidates = collectClaudeCodeJsonLines(stderr)
      .filter((obj) => obj["headers"] || obj["response_headers"])
      .map((obj) => JSON.stringify(obj));

    if (candidates.length > 0) {
      return extractRateLimitHeaders(candidates.join("\n"));
    }

    // Fall back to scanning the full text for raw header lines
    if (stderr.trim().length > 0) {
      process.stderr.write(
        JSON.stringify({
          event: "header_extractor_fallback",
          provider: this.name,
          reason: "no structured JSON lines with headers/response_headers found in non-empty stderr",
          fallback: "raw-text scan",
        }) + "\n",
      );
    }
    return extractRateLimitHeaders(stderr);
  }
}
