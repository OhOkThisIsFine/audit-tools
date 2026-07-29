import { test, expect } from "vitest";

import { scanStringAware } from "../../src/shared/parsing/stringAwareScanner.js";

// ── JSON double-quote string skipping ─────────────────────────────────────────

test("scanStringAware — JSON: chars inside a double-quoted string are not passed to onUnquoted", () => {
  const seen: string[] = [];
  scanStringAware(
    '"hello"world',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["w", "o", "r", "l", "d"]);
});

test("scanStringAware — JSON: escaped quote inside a string does not close the string", () => {
  const seen: string[] = [];
  scanStringAware(
    '"a\\"b"X',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["X"]);
});

test("scanStringAware — JSON: characters after the closing quote are passed to onUnquoted", () => {
  const seen: string[] = [];
  scanStringAware(
    '"str"after',
    { quoteChars: ['"'], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["a", "f", "t", "e", "r"]);
});

// ── TOML single-quote string (no escape processing) ───────────────────────────

test("scanStringAware — TOML: backslash inside a single-quoted string does not prevent the next single-quote from closing it", () => {
  const seen: string[] = [];
  scanStringAware(
    "'a\\'b'X",
    { quoteChars: ['"', "'"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["b"]);
});

test("scanStringAware — TOML: hash inside a single-quoted string is not passed to onUnquoted", () => {
  const hashes: string[] = [];
  scanStringAware(
    "'val#ue'#comment",
    { quoteChars: ['"', "'"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { if (c === "#") hashes.push(c); } },
  );
  expect(hashes).toEqual(["#"]);
});

// ── Go backtick raw string ─────────────────────────────────────────────────────

test("scanStringAware — Go backtick: chars inside a backtick string are not passed to onUnquoted", () => {
  const seen: string[] = [];
  scanStringAware(
    "`raw content`outside",
    { quoteChars: ['"', "`"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["o", "u", "t", "s", "i", "d", "e"]);
});

test("scanStringAware — Go backtick: backslash inside a backtick string does not trigger escape processing", () => {
  const seen: string[] = [];
  scanStringAware(
    "`a\\`b`X",
    { quoteChars: ['"', "`"], escapedQuotes: ['"'] },
    { onUnquoted: (c) => { seen.push(c); } },
  );
  expect(seen).toEqual(["b"]);
});

// ── onQuoteOpen / onQuoteClose callbacks ──────────────────────────────────────

test("scanStringAware — onQuoteOpen is called with correct quoteChar and index", () => {
  const opens: Array<{ q: string; i: number }> = [];
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
  const closes: Array<{ q: string; i: number }> = [];
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
  const seen: string[] = [];
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
  const seen: string[] = [];
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
  expect(seen).toEqual(["a"]);
});
