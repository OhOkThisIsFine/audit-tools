import type { RateLimitDetectionResult } from "../errorParsing.js";
import { detectRateLimitError } from "../errorParsing.js";

export interface ErrorParser {
  readonly name: string;
  parse(text: string): RateLimitDetectionResult;
}

export class GenericErrorParser implements ErrorParser {
  readonly name = "generic";

  parse(text: string): RateLimitDetectionResult {
    return detectRateLimitError(text);
  }
}
