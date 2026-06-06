import { scanStringAware } from "@audit-tools/shared";

const TOML_SCAN_OPTIONS = {
  quoteChars: ['"', "'"] as const,
  // Only double-quoted strings honour backslash escapes in TOML.
  escapedQuotes: ['"'] as const,
};

export function stripTomlComment(line: string): string {
  let commentIndex: number | undefined;

  scanStringAware(
    line,
    TOML_SCAN_OPTIONS,
    {
      onUnquoted(char, i) {
        if (char === "#") {
          commentIndex = i;
          return false;
        }
      },
    },
  );

  return commentIndex !== undefined ? line.slice(0, commentIndex) : line;
}

export function tomlArrayIsClosed(value: string): boolean {
  let depth = 0;
  let found = false;

  scanStringAware(
    value,
    TOML_SCAN_OPTIONS,
    {
      onUnquoted(char) {
        if (char === "[") {
          depth += 1;
        } else if (char === "]") {
          depth -= 1;
          if (depth <= 0) {
            found = true;
            return false;
          }
        }
      },
    },
  );

  return found;
}

export function unquoteTomlString(value: string, quote: '"' | "'"): string {
  if (quote === "'") {
    return value.trim();
  }

  try {
    const parsed: unknown = JSON.parse(`"${value}"`);
    return typeof parsed === "string" ? parsed.trim() : value.trim();
  } catch {
    return value.replace(/\\"/g, '"').trim();
  }
}

export function tomlStringArrayValues(value: string): string[] {
  const values: string[] = [];
  let openIndex = 0;

  scanStringAware(
    value,
    TOML_SCAN_OPTIONS,
    {
      onQuoteOpen(_quoteChar, i) {
        openIndex = i + 1; // content starts after the opening quote
      },
      onQuoteClose(quoteChar, i) {
        if (quoteChar === "`") {
          return;
        }
        const item = unquoteTomlString(value.slice(openIndex, i), quoteChar);
        if (item.length > 0) {
          values.push(item);
        }
      },
    },
  );

  return values;
}
