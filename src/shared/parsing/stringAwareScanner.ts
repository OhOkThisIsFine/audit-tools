/** Quote characters recognised as string delimiters. */
export type QuoteChar = '"' | "'" | "`";

export interface StringAwareScannerOptions {
  /** Which characters open/close a string literal. */
  quoteChars: readonly QuoteChar[];
  /**
   * Quote chars for which backslash-escape processing applies.
   * Typically just `'"'`; backtick raw strings and single-quoted TOML
   * strings never treat `\\` as an escape sequence.
   */
  escapedQuotes?: readonly QuoteChar[];
}

/**
 * Scans `input` character-by-character while tracking string-literal state.
 *
 * Calls:
 * - `callbacks.onUnquoted(char, index)` for every character that is NOT inside
 *   a string literal.  Returning `false` stops the scan early.
 * - `callbacks.onQuoteOpen(quoteChar, index)` when a string literal opens
 *   (called with the opening quote character and its position).
 * - `callbacks.onQuoteClose(quoteChar, index)` when a string literal closes
 *   (called with the closing quote character and its position).
 *
 * The quote-open and quote-close characters themselves are NOT passed to
 * `onUnquoted` — only truly unquoted content reaches that callback.
 */
export function scanStringAware(
  input: string,
  options: StringAwareScannerOptions,
  callbacks: {
    onUnquoted?: (char: string, index: number) => boolean | void;
    onQuoteOpen?: (quoteChar: QuoteChar, index: number) => void;
    onQuoteClose?: (quoteChar: QuoteChar, index: number) => void;
  },
): void {
  const { quoteChars, escapedQuotes } = options;
  const escapedSet: ReadonlySet<QuoteChar> = new Set(escapedQuotes ?? ['"']);

  let currentQuote: QuoteChar | undefined;
  let escaped = false;

  for (let index = 0; index < input.length; index++) {
    const char = input[index] as QuoteChar | string;

    if (currentQuote !== undefined) {
      // Inside a string literal.
      if (escaped) {
        escaped = false;
        continue;
      }
      if (escapedSet.has(currentQuote) && char === "\\") {
        escaped = true;
        continue;
      }
      if (char === currentQuote) {
        const closing = currentQuote;
        currentQuote = undefined;
        callbacks.onQuoteClose?.(closing, index);
      }
      continue;
    }

    // Outside any string literal.
    if ((quoteChars as readonly string[]).includes(char)) {
      currentQuote = char as QuoteChar;
      callbacks.onQuoteOpen?.(currentQuote, index);
      continue;
    }

    const result = callbacks.onUnquoted?.(char, index);
    if (result === false) {
      return;
    }
  }
}
