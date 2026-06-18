import type { ExtractedRateLimits } from "../headerExtraction.js";
import { extractRateLimitHeaders } from "../headerExtraction.js";

export interface HeaderExtractor {
  readonly name: string;
  extract(stderr: string): ExtractedRateLimits | null;
}

export class GenericHeaderExtractor implements HeaderExtractor {
  readonly name = "generic";

  extract(stderr: string): ExtractedRateLimits | null {
    return extractRateLimitHeaders(stderr);
  }
}
