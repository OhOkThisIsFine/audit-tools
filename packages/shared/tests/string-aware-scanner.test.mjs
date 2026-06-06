import test from "node:test";
import assert from "node:assert/strict";

const { scanStringAware } = await import("../src/parsing/stringAwareScanner.ts");

// ── JSON double-quote string skipping ─────────────────────────────────────────

test("scanStringAware — JSON: chars inside a double-quoted string are not passed to onUnquoted", () => {
  const seen = [];
  scanStringAware(
    '"hello"world',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  assert.deepEqual(seen, ["w", "o", "r", "l", "d"]);
});

test("scanStringAware — JSON: escaped quote inside a string does not close the string", () => {
  const seen = [];
  scanStringAware(
    '"a\\"b"X',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  assert.deepEqual(seen, ["X"]);
});

test("scanStringAware — JSON: characters after the closing quote are passed to onUnquoted", () => {
  const seen = [];
  scanStringAware(
    '"str"after',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  assert.deepEqual(seen, ["a", "f", "t", "e", "r"]);
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
  assert.deepEqual(seen, ["b"]);
});

test("scanStringAware — TOML: hash inside a single-quoted string is not passed to onUnquoted", () => {
  const hashes = [];
  scanStringAware(
    "'val#ue'#comment",
    { quoteChars: ['"', "'"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { if (c === "#") hashes.push(c); } },
  );
  // '#' at index 4 is inside the string (skipped), '#' at index 8 is outside.
  assert.deepEqual(hashes, ["#"]);
});

// ── Go backtick raw string ─────────────────────────────────────────────────────

test("scanStringAware — Go backtick: chars inside a backtick string are not passed to onUnquoted", () => {
  const seen = [];
  scanStringAware(
    "`raw content`outside",
    { quoteChars: ['"', "`"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  assert.deepEqual(seen, ["o", "u", "t", "s", "i", "d", "e"]);
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
  assert.deepEqual(seen, ["b"]);
});

// ── onQuoteOpen / onQuoteClose callbacks ──────────────────────────────────────

test("scanStringAware — onQuoteOpen is called with correct quoteChar and index", () => {
  const opens = [];
  scanStringAware(
    'before"inside"after',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onQuoteOpen: (q, i) => { opens.push({ q, i }); } },
  );
  assert.equal(opens.length, 1);
  assert.equal(opens[0].q, '"');
  assert.equal(opens[0].i, 6);
});

test("scanStringAware — onQuoteClose is called with correct quoteChar and index", () => {
  const closes = [];
  scanStringAware(
    'before"inside"after',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onQuoteClose: (q, i) => { closes.push({ q, i }); } },
  );
  assert.equal(closes.length, 1);
  assert.equal(closes[0].q, '"');
  assert.equal(closes[0].i, 13);
});
