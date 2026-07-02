import { test, expect } from "vitest";

const { scanStringAware } = await import("../../src/shared/parsing/stringAwareScanner.ts");

// ── JSON double-quote string skipping ─────────────────────────────────────────

test("scanStringAware — JSON: chars inside a double-quoted string are not passed to onUnquoted", () => {
  const seen = [];
  scanStringAware(
    '"hello"world',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["w", "o", "r", "l", "d"]);
});

test("scanStringAware — JSON: escaped quote inside a string does not close the string", () => {
  const seen = [];
  scanStringAware(
    '"a\\"b"X',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["X"]);
});

test("scanStringAware — JSON: characters after the closing quote are passed to onUnquoted", () => {
  const seen = [];
  scanStringAware(
    '"str"after',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["a", "f", "t", "e", "r"]);
});

// ── TOML single-quote string (no escape processing) ───────────────────────────

test("scanStringAware — TOML: backslash inside a single-quoted string does not prevent the next single-quote from closing it", () => {
  const seen = [];
  scanStringAware(
    "'a\\'b'X",
    { quoteChars: ['"', "'"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  // Single quotes: no escape processing, so \' closes at the backslash position — wait,
  // the backslash is inside the string. The first ' opens the string, then 'a', '\' are
  // inside (not seen). The next ' closes the string. Then 'b', "'", 'X' are unquoted.
  // Because ' is a quoteChar, the second ' after \' closes the string at index 2.
  // content: ' a \ ' b ' X
  // idx:     0 1 2 3 4 5 6
  // String opens at 0, closes at 3 (the ' at index 3). Then b, ', X are outside.
  // ' at index 5 opens another string (immediately closed by... there's no closing ').
  // Actually let's re-check: "'a\\'b'X"
  // char[0] = '  → opens string
  // char[1] = a  → inside string (skipped)
  // char[2] = \  → inside string (skipped, no escape)
  // char[3] = '  → closes string (no escape on ' chars)
  // char[4] = b  → outside → onUnquoted
  // char[5] = '  → opens string
  // char[6] = X  → inside string (skipped)
  // → seen = ['b']
  expect(seen).toEqual(["b"]);
});

test("scanStringAware — TOML: hash inside a single-quoted string is not passed to onUnquoted", () => {
  const hashes = [];
  scanStringAware(
    "'val#ue'#comment",
    { quoteChars: ['"', "'"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { if (c === "#") hashes.push(c); } },
  );
  // '#' at index 4 is inside the string (skipped), '#' at index 8 is outside.
  expect(hashes).toEqual(["#"]);
});

// ── Go backtick raw string ─────────────────────────────────────────────────────

test("scanStringAware — Go backtick: chars inside a backtick string are not passed to onUnquoted", () => {
  const seen = [];
  scanStringAware(
    "`raw content`outside",
    { quoteChars: ['"', "`"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["o", "u", "t", "s", "i", "d", "e"]);
});

test("scanStringAware — Go backtick: backslash inside a backtick string does not trigger escape processing", () => {
  const seen = [];
  scanStringAware(
    "`a\\`b`X",
    { quoteChars: ['"', "`"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  // ` opens at 0, a and \ are inside, ` at index 3 closes (no escape on backtick).
  // Then b, `, X: ` at 5 opens again (never closed), X is inside.
  expect(seen).toEqual(["b"]);
});

// ── onQuoteOpen / onQuoteClose callbacks ──────────────────────────────────────

test("scanStringAware — onQuoteOpen is called with correct quoteChar and index", () => {
  const opens = [];
  scanStringAware(
    'before"inside"after',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onQuoteOpen: (q, i) => { opens.push({ q, i }); } },
  );
  expect(opens.length).toBe(1);
  expect(opens[0].q).toBe('"');
  expect(opens[0].i).toBe(6);
});

test("scanStringAware — onQuoteClose is called with correct quoteChar and index", () => {
  const closes = [];
  scanStringAware(
    'before"inside"after',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onQuoteClose: (q, i) => { closes.push({ q, i }); } },
  );
  expect(closes.length).toBe(1);
  expect(closes[0].q).toBe('"');
  expect(closes[0].i).toBe(13);
});

// ── Early scan termination (FND-TST-2bc16ad1) ─────────────────────────────────

test("scanStringAware — returning false from onUnquoted stops the scan early", () => {
  // Scan "abcdef" and return false on the first 'c'. Only 'a' and 'b' should
  // be delivered before the scan stops. 'd', 'e', 'f' must never be seen.
  const seen = [];
  scanStringAware(
    "abcdef",
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    {
      onUnquoted: (c) => {
        seen.push(c);
        if (c === "c") return false; // stop here
      },
    },
  );
  expect(seen, "scan must stop after onUnquoted returns false").toEqual(["a", "b", "c"]);
});

test("scanStringAware — early termination does not fire inside a string (only outside)", () => {
  // The string literal spans chars 1-5 ('xyz'). The callback fires for 'a'
  // (outside, before the string) and should stop there. 'xyz' is inside the
  // string so onUnquoted is never called for those chars.
  const seen = [];
  scanStringAware(
    'a"xyz"b',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    {
      onUnquoted: (c) => {
        seen.push(c);
        if (c === "a") return false;
      },
    },
  );
  // Scan stops at 'a'; 'b' (outside, after the string) is never reached.
  expect(seen).toEqual(["a"]);
});
