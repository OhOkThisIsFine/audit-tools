import { scanStringAware } from "audit-tools/shared";
import stripJsonCommentsVetted from "strip-json-comments";

const JSON_SCAN_OPTIONS = { quoteChars: ['"'] as const, escapedQuotes: ['"'] as const };

/**
 * JSONC comment stripping via the vetted parser (two-tier dependency rule:
 * JSONC is a grammar this repo does not own). Comments are replaced with
 * whitespace, which preserves both line AND column positions — strictly
 * stronger than the prior hand-rolled scanner, which kept only newlines.
 * `removeTrailingJsonCommas` stays on the shared string-aware scanner: that
 * scanner is not comment-aware (a quote inside a comment body would desync its
 * string state), which is exactly why comment stripping runs first and through
 * the library.
 */
export function stripJsonComments(content: string): string {
  return stripJsonCommentsVetted(content);
}

export function removeTrailingJsonCommas(content: string): string {
  let result = "";
  let pos = 0;

  scanStringAware(
    content,
    JSON_SCAN_OPTIONS,
    {
      onQuoteOpen(_q, i) {
        result += content.slice(pos, i + 1);
        pos = i + 1;
      },
      onQuoteClose(_q, i) {
        result += content.slice(pos, i + 1);
        pos = i + 1;
      },
      onUnquoted(char, i) {
        if (char === ",") {
          let lookahead = i + 1;
          while (/\s/.test(content[lookahead] ?? "")) {
            lookahead++;
          }
          if (content[lookahead] === "}" || content[lookahead] === "]") {
            // Flush up to (not including) the comma; skip it.
            result += content.slice(pos, i);
            pos = i + 1;
          }
        }
      },
    },
  );

  // Flush anything after the last event.
  result += content.slice(pos);
  return result;
}

export function parseJsoncObject(content: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(removeTrailingJsonCommas(stripJsonComments(content)));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}
