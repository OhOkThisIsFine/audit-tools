import { scanStringAware } from "audit-tools/shared";

const JSON_SCAN_OPTIONS = { quoteChars: ['"'] as const, escapedQuotes: ['"'] as const };

export function stripJsonComments(content: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < content.length && content[index] !== "\n") {
        index++;
      }
      if (index < content.length) {
        result += content[index];
      }
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < content.length &&
        !(content[index] === "*" && content[index + 1] === "/")
      ) {
        if (content[index] === "\n") {
          result += "\n";
        }
        index++;
      }
      if (index < content.length) {
        index++;
      }
      continue;
    }

    result += char;
  }

  return result;
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
